/**
 * Grid view — React rewrite. Per ` §Grid`
 * and the 9.12.R1 plan rung.
 *
 * Replaces the imperative `render/grid-view.ts` (HTML5 column DnD, no
 * drop indicator, drop-stuck artifacts) with:
 *
 *   - **`@dnd-kit` column reorder** — deterministic drop targeting,
 *     single horizontal-strategy reflow (no stuck multi-column lines),
 *     keyboard-accessible sensors out of the box. Fires
 *     `onReorderColumns` once with the final order, so the existing
 *     `schedulePersist` overlay refresh persists every reorder.
 *   - **`@tanstack/react-virtual`** row virtualization — only on-screen
 *     rows are mounted; idle rows have zero render cost.
 *   - **Pointer-based resize** — ported from the imperative renderer
 *     unchanged (suspends drag-reorder while resizing).
 *
 * Cross-view / cross-app entity drag (`application/x-brainstorm-entity`)
 * stays native HTML5 on the row — that is a different drag channel
 * (intentionally outside dnd-kit's scope) and existing consumers depend
 * on the wire shape.
 *
 * Cells reuse `render/cells.ts` (`entityIcon`, `entityTitle`,
 * `paintPropertyValue`) via `<DomSlot>` — those helpers paint DOM
 * directly today and the cell shapes (pills, rating, tags) are out of
 * scope for this rung. React migration of cell internals is follow-up.
 */

import {
	type ColumnFormula,
	type ColumnRollup,
	type ObjectDragItem,
	type PropertyDef,
	ValueType,
} from "@brainstorm/sdk-types";
import { type CompositeItemProps, Orientation, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { useDragSource } from "@brainstorm/sdk/object-dnd";
import { openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import {
	DndContext,
	type DragEndEvent,
	type DragStartEvent,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
	SortableContext,
	arrayMove,
	horizontalListSortingStrategy,
	sortableKeyboardCoordinates,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	type CSSProperties,
	type ReactElement,
	type PointerEvent as ReactPointerEvent,
	memo,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { t } from "../i18n";
import {
	AggregationKind,
	aggregationLabel,
	aggregationsForValueType,
	computeAggregation,
	defaultAggregationFor,
	formatAggregation,
} from "../logic/aggregations";
import type { CompiledView } from "../logic/compile-view";
import { dragItemsForRow } from "../logic/drag-items";
import { effectiveColumnDef } from "../logic/effective-def";
import { type CompiledFormula, compileFormula } from "../logic/formula";
import {
	cellActivationOpensRecord,
	cellColOf,
	cellCursorCount,
	cellRowOf,
	clampCellCursor,
	flatCellIndex,
} from "../logic/grid-cell-nav";
import { type EntityRow, readPropertyPath } from "../logic/in-memory-entities";
import {
	columnRollupToSpec,
	computeRollup,
	entitiesById,
	parseAggregationKind,
} from "../logic/rollup";
import { entityIcon, entityTitle } from "../render/cells";
import type { ColumnSpec, GridLayoutOptions } from "../types/list-view";
import { humanize } from "../ui/humanize";
import { DomSlot } from "./dom-slot";
import { EditableCell, type EntityPropertyEdit } from "./editable-cell";
import { useStableCallback } from "./use-stable-callback";

type ColumnDefs = ReadonlyMap<string, PropertyDef | null>;

/** The cell the keyboard asked to edit (12.4 Enter-to-edit), addressed by
 *  entity + property identity so a live row reorder can't re-target a stale
 *  latch onto a different row. */
type EditTarget = { entityId: string; propertyId: string };

export type SelectionModifiers = { shiftKey: boolean; metaKey: boolean };

export type GridViewProps = {
	compiled: CompiledView;
	columns: ReadonlyArray<ColumnSpec>;
	/** The full live vault entity set — rollup columns walk a relation to
	 *  entities of *other* types, which aren't in `compiled.rows`. Omitted
	 *  (e.g. no rollup columns) means rollups resolve against nothing. */
	allRows?: ReadonlyArray<EntityRow>;
	layout: GridLayoutOptions;
	selectedIds: ReadonlySet<string>;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
	/** Open the row's Details inspector — the explicit title-cell "Open"
	 *  affordance (F-023). Distinct from `onOpen` (cross-app open intent). */
	onOpenInspector: (entity: EntityRow) => void;
	onReorderColumns?: (next: ColumnSpec[]) => void;
	onResizeColumn?: (propertyId: string, width: number) => void;
	onReorderRows?: (orderedIds: string[]) => void;
	/** Commit an inline cell edit (optimistic write + vault persist). When
	 *  omitted, cells render read-only. */
	onEdit?: EntityPropertyEdit;
	/** Persist a footer aggregation choice for a column (9.12.18). Omitted →
	 *  the footer is read-only (shows the type default, no picker). */
	onSetColumnAggregation?: (propertyId: string, aggregation: AggregationKind) => void;
	/** Entity id whose title editor should open as soon as the row paints —
	 *  the "+ New" create→type→Enter keyboard handoff (F-215) and the row
	 *  menu's Rename (F-216). The row may land asynchronously (the entity
	 *  write → vault reload), so the grid scrolls it into the window and the
	 *  title cell opens its inline editor on mount. A row whose title isn't
	 *  editable (typed entities) receives plain focus instead, so Enter never
	 *  re-fires whatever button the keyboard was parked on. */
	pendingTitleEditId?: string | null;
	/** Called once the pending edit has been consumed (editor opened or row
	 *  focused) so the host clears it. */
	onPendingTitleEditHandled?: () => void;
};

const TITLE_COL = "__title__";
const TITLE_WIDTH = 320;
const DEFAULT_COLUMN_WIDTH = 160;
const ENTITY_MIME = "application/x-brainstorm-entity";
const noopReorder = (_: string[]): void => {};
const noopEdit: EntityPropertyEdit = () => {};

const DENSITY_ROW_HEIGHT: Record<GridLayoutOptions["rowHeight"], number> = {
	compact: 32,
	comfortable: 40,
	tall: 56,
};

/** Pure column-reorder helper — `null` when the move is a no-op or
 *  either id is missing. Extracted so the dnd-kit onDragEnd path is
 *  test-covered without simulating dnd-kit's event lifecycle. */
export function computeColumnReorder(
	columns: ReadonlyArray<ColumnSpec>,
	fromId: string,
	toId: string,
): ColumnSpec[] | null {
	if (fromId === toId) return null;
	const from = columns.findIndex((c) => c.propertyId === fromId);
	const to = columns.findIndex((c) => c.propertyId === toId);
	if (from < 0 || to < 0) return null;
	return arrayMove([...columns], from, to);
}

export function GridView(props: GridViewProps): ReactElement {
	const { compiled, columns, layout, selectedIds, onReorderColumns, onResizeColumn } = props;

	// Stabilize callback identity so `memo(GridRow)` skips re-renders on
	// selection clicks (app.ts builds these fresh every renderActiveView).
	const onSelect = useStableCallback(props.onSelect);
	const onOpen = useStableCallback(props.onOpen);
	const onOpenInspector = useStableCallback(props.onOpenInspector);
	const onReorderRows = useStableCallback(props.onReorderRows ?? noopReorder);
	const hasReorderRows = props.onReorderRows !== undefined;
	const onEdit = useStableCallback(props.onEdit ?? noopEdit);
	const hasEdit = props.onEdit !== undefined;
	// Cross-app drag payload (DND-4) — reads the live selection + row order at
	// drag start; stable identity so it doesn't bust `memo(GridRow)`.
	const getDragItems = useStableCallback((entity: EntityRow) =>
		dragItemsForRow(entity, selectedIds, compiled.rows),
	);

	// The synthetic Name column always pins to the left — see imperative
	// renderer's comment. Any `title`/`name` column the view declares is
	// dropped to avoid duplicating it (Notion-style).
	const visible = useMemo<ColumnSpec[]>(() => {
		const title: ColumnSpec = { propertyId: TITLE_COL, width: TITLE_WIDTH, visible: true };
		return [
			title,
			...columns.filter(
				(c) => c.visible !== false && c.propertyId !== "title" && c.propertyId !== "name",
			),
		];
	}, [columns]);

	const reorderableIds = useMemo(
		() => visible.filter((c) => c.propertyId !== TITLE_COL).map((c) => c.propertyId),
		[visible],
	);

	// The effective editing def per column (catalog def, else inferred from
	// the column's data). Computed once here so memoized rows share it.
	// Rollup columns are always read-only computed values → null def.
	const columnDefs = useMemo<ColumnDefs>(() => {
		const map = new Map<string, PropertyDef | null>();
		for (const c of visible) {
			if (c.propertyId === TITLE_COL) continue;
			if (c.rollup || c.formula) {
				map.set(c.propertyId, null);
				continue;
			}
			map.set(c.propertyId, hasEdit ? effectiveColumnDef(c.propertyId, compiled.rows) : null);
		}
		return map;
	}, [visible, compiled.rows, hasEdit]);

	// Rollup wiring (9.12.17): the relation walks to entities of *other* types,
	// so the lookup is built over the full vault (`allRows`), not the view's
	// filtered rows. The target property's def comes from those linked entities
	// (the source rows don't carry it) so the cell formats in the target's units.
	const allRows = props.allRows;
	const rollupById = useMemo(() => entitiesById(allRows ?? compiled.rows), [allRows, compiled.rows]);
	const rollupTargetDefs = useMemo<ColumnDefs>(() => {
		const map = new Map<string, PropertyDef | null>();
		const source = allRows ?? compiled.rows;
		for (const c of visible) {
			if (!c.rollup) continue;
			map.set(c.propertyId, effectiveColumnDef(c.rollup.targetPropertyKey, source));
		}
		return map;
	}, [visible, allRows, compiled.rows]);

	const [activeColumn, setActiveColumn] = useState<string | null>(null);
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const handleDragStart = useCallback((event: DragStartEvent) => {
		setActiveColumn(String(event.active.id));
	}, []);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveColumn(null);
			if (!onReorderColumns) return;
			const { active, over } = event;
			if (!over) return;
			const next = computeColumnReorder(columns, String(active.id), String(over.id));
			if (next) onReorderColumns(next);
		},
		[columns, onReorderColumns],
	);

	const handleDragCancel = useCallback(() => setActiveColumn(null), []);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const rowHeight = DENSITY_ROW_HEIGHT[layout.rowHeight];
	// `.dbv-grid` is now a child of `.db-stage__body` (the scroll
	// container — `overflow: auto` is on `#stage-body` itself, see
	// styles.css). The virtualizer needs the actual scrollable ancestor,
	// not our wrapper — without this rows never enter the viewport.
	const rowVirtualizer = useVirtualizer({
		count: compiled.rows.length,
		getScrollElement: () =>
			scrollRef.current?.closest<HTMLElement>(".db-stage__body") ?? scrollRef.current,
		estimateSize: () => rowHeight,
		overscan: 8,
	});

	// Density changes the fixed row height, but the virtualizer caches the size
	// it estimated per index — without a re-measure the cache keeps the old
	// height, so `getTotalSize()` and every row offset drift and the grid breaks.
	// `rowHeight` is the trigger, not a body reference: `estimateSize` closes
	// over it, so the cache must be reset whenever it changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: rowHeight is the intentional trigger; estimateSize reads it via closure.
	useLayoutEffect(() => {
		rowVirtualizer.measure();
	}, [rowHeight, rowVirtualizer]);

	const rowIds = useMemo(() => compiled.rows.map((r) => r.id), [compiled.rows]);

	// Cell-level 2D keyboard navigation (12.4 — KBN-A-database grid). DOM focus
	// stays on the `role="grid"` container (one Tab stop); the cursor rides the
	// shared composite reducer in `aria-activedescendant` mode — a roving
	// tabindex can't work over a virtualized body where the active cell may be
	// unmounted. Arrows step the cursor row-major over `rows × columns`; the
	// cursor's row is scrolled into the window so the referenced cell is mounted
	// by the time AT resolves the id. Enter on the Name column opens the record
	// (the prior row-level Enter); Enter on any other column begins in-cell
	// editing — `editCell` latches the target by ENTITY + PROPERTY identity (not
	// a positional flat index, which would address a different row if the live
	// `compiled.rows` reorders/filters while a read-only cell's latch is still
	// un-acked). The matching cell opens its editor on the rising `autoEdit` edge
	// and acks so the latch clears.
	const columnCount = visible.length;
	const cellCount = cellCursorCount(compiled.rows.length, columnCount);
	const [cellCursor, setCellCursor] = useState(0);
	const [editCell, setEditCell] = useState<EditTarget | null>(null);
	const activeCell = clampCellCursor(cellCursor, cellCount);
	const moveCellCursor = useCallback(
		(next: number) => {
			setCellCursor(next);
			setEditCell(null);
			if (next >= 0) rowVirtualizer.scrollToIndex(cellRowOf(next, columnCount));
		},
		[rowVirtualizer, columnCount],
	);
	const activateCell = useCallback(
		(flat: number) => {
			if (cellActivationOpensRecord(flat, columnCount)) {
				const entity = compiled.rows[cellRowOf(flat, columnCount)];
				if (entity) onOpen(entity);
				return;
			}
			const entity = compiled.rows[cellRowOf(flat, columnCount)];
			const column = visible[cellColOf(flat, columnCount)];
			if (entity && column) setEditCell({ entityId: entity.id, propertyId: column.propertyId });
		},
		[compiled.rows, columnCount, visible, onOpen],
	);
	const clearEditCell = useStableCallback(() => setEditCell(null));
	const { containerProps: gridKeyboardProps, getItemProps: getCellProps } = useCompositeKeyboard({
		orientation: Orientation.Grid,
		count: cellCount,
		columns: columnCount,
		activeIndex: activeCell,
		onActiveIndexChange: moveCellCursor,
		onActivate: activateCell,
		useAriaActiveDescendant: true,
	});

	// Focus handoff (F-215/F-216): bring the pending row into the virtual
	// window so it mounts — the row itself then opens its editor / takes
	// focus and reports back via `onPendingTitleEditHandled`.
	const pendingTitleEditId = props.pendingTitleEditId ?? null;
	const onPendingTitleEditHandled = useStableCallback(props.onPendingTitleEditHandled ?? (() => {}));
	useLayoutEffect(() => {
		if (!pendingTitleEditId) return;
		const index = compiled.rows.findIndex((r) => r.id === pendingTitleEditId);
		if (index >= 0) rowVirtualizer.scrollToIndex(index);
	}, [pendingTitleEditId, compiled.rows, rowVirtualizer]);

	// Footer aggregations (9.12.18). The value type per column (catalog def,
	// else inferred) decides which aggregations apply; an un-typeable column
	// is treated as Text (count family only).
	const valueTypes = useMemo<ReadonlyMap<string, ValueType>>(() => {
		const map = new Map<string, ValueType>();
		for (const c of visible) {
			if (c.propertyId === TITLE_COL || c.rollup) continue;
			map.set(
				c.propertyId,
				effectiveColumnDef(c.propertyId, compiled.rows)?.valueType ?? ValueType.Text,
			);
		}
		return map;
	}, [visible, compiled.rows]);
	// The chosen aggregation per column is PERSISTED on the ColumnSpec
	// (`aggregation`), so it survives reloads and vault rebuilds via the view
	// override. Clicking the footer opens a picker; the host persists the choice.
	const onChooseAggregation = props.onSetColumnAggregation;
	const pickAggregation = useCallback(
		(anchor: HTMLElement, propertyId: string, valueType: ValueType, current: AggregationKind) => {
			if (!onChooseAggregation) return;
			const rect = anchor.getBoundingClientRect();
			const items = aggregationsForValueType(valueType).map((kind) => ({
				label: aggregationLabel(kind),
				...(kind === current ? { icon: IconName.CheckCircle } : {}),
				onSelect: () => onChooseAggregation(propertyId, kind),
			}));
			openAnchoredMenu({ x: rect.left, y: rect.bottom + 4 }, items, {
				menuLabel: "Choose aggregation",
				anchor,
			});
		},
		[onChooseAggregation],
	);

	return (
		<div
			ref={scrollRef}
			className="dbv-grid"
			data-density={layout.rowHeight}
			data-wrap={layout.wrap ? "true" : "false"}
			data-pinned={layout.pinFirstColumn ? "true" : "false"}
		>
			<div className="dbv-grid__table" {...gridKeyboardProps}>
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					modifiers={[restrictToHorizontalAxis]}
					onDragStart={handleDragStart}
					onDragEnd={handleDragEnd}
					onDragCancel={handleDragCancel}
				>
					<div className="dbv-grid__row dbv-grid__row--head" role="row" tabIndex={-1}>
						{layout.showRowNumbers ? (
							<div
								className="dbv-grid__cell dbv-grid__cell--head dbv-grid__cell--num"
								role="columnheader"
								aria-label="Row number"
							>
								#
							</div>
						) : null}
						<PinnedHeaderCell width={TITLE_WIDTH} label="Name" />
						<SortableContext items={reorderableIds} strategy={horizontalListSortingStrategy}>
							{visible
								.filter((c) => c.propertyId !== TITLE_COL)
								.map((c) => (
									<SortableHeaderCell
										key={c.propertyId}
										column={c}
										label={columnLabel(c, columnDefs)}
										isActive={activeColumn === c.propertyId}
										onResize={onResizeColumn}
									/>
								))}
						</SortableContext>
					</div>

					{compiled.rows.length === 0 ? (
						<div className="dbv-empty">{t("brainstorm.database.view.empty")}</div>
					) : (
						<div
							className="dbv-grid__rows"
							style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
						>
							{rowVirtualizer.getVirtualItems().map((virtualRow) => {
								const entity = compiled.rows[virtualRow.index];
								if (!entity) return null;
								return (
									<GridRow
										key={entity.id}
										entity={entity}
										columns={visible}
										selected={selectedIds.has(entity.id)}
										showRowNumber={layout.showRowNumbers}
										rowNumber={virtualRow.index + 1}
										rowIndex={virtualRow.index}
										columnCount={columnCount}
										getCellProps={getCellProps}
										editCell={editCell}
										onEditCellHandled={clearEditCell}
										translateY={virtualRow.start}
										height={virtualRow.size}
										rowIds={rowIds}
										columnDefs={columnDefs}
										rollupById={rollupById}
										rollupTargetDefs={rollupTargetDefs}
										pendingTitleEdit={pendingTitleEditId === entity.id}
										onPendingTitleEditHandled={onPendingTitleEditHandled}
										onSelect={onSelect}
										onOpen={onOpen}
										onOpenInspector={onOpenInspector}
										onReorderRows={hasReorderRows ? onReorderRows : undefined}
										getDragItems={getDragItems}
										onEdit={hasEdit ? onEdit : undefined}
									/>
								);
							})}
						</div>
					)}
				</DndContext>

				{compiled.rows.length > 0 ? (
					<GridFooter
						columns={visible}
						rows={compiled.rows}
						showRowNumber={layout.showRowNumbers}
						valueTypes={valueTypes}
						columnDefs={columnDefs}
						onPick={onChooseAggregation ? pickAggregation : undefined}
					/>
				) : null}
			</div>
		</div>
	);
}

/** Sticky footer of per-column aggregations. Each non-title cell is a button
 *  that cycles through the applicable aggregations for that column's type;
 *  the title cell shows the total row count. */
function GridFooter({
	columns,
	rows,
	showRowNumber,
	valueTypes,
	columnDefs,
	onPick,
}: {
	columns: ReadonlyArray<ColumnSpec>;
	rows: ReadonlyArray<EntityRow>;
	showRowNumber: boolean;
	valueTypes: ReadonlyMap<string, ValueType>;
	columnDefs: ColumnDefs;
	/** Open the aggregation picker for a column (omitted → read-only footer). */
	onPick:
		| ((
				anchor: HTMLElement,
				propertyId: string,
				valueType: ValueType,
				current: AggregationKind,
		  ) => void)
		| undefined;
}): ReactElement {
	return (
		<div className="dbv-grid__row dbv-grid__row--foot" role="row" tabIndex={-1}>
			{showRowNumber ? <div className="dbv-grid__cell dbv-grid__cell--num" role="cell" /> : null}
			{columns.map((column) => {
				const width =
					column.width ?? (column.propertyId === TITLE_COL ? TITLE_WIDTH : DEFAULT_COLUMN_WIDTH);
				if (column.propertyId === TITLE_COL) {
					const count = computeAggregation(AggregationKind.CountAll, rows);
					return (
						<div
							key={column.propertyId}
							className="dbv-grid__cell dbv-grid__foot-cell"
							role="cell"
							data-col="title"
							style={{ width }}
						>
							<span className="dbv-grid__foot-total">
								{formatAggregation(count)} {rows.length === 1 ? "row" : "rows"}
							</span>
						</div>
					);
				}
				// A rollup / formula is itself a computed value — no footer for it.
				if (column.rollup || column.formula) {
					return (
						<div
							key={column.propertyId}
							className="dbv-grid__cell dbv-grid__foot-cell"
							role="cell"
							style={{ width }}
						/>
					);
				}
				const valueType = valueTypes.get(column.propertyId) ?? ValueType.Text;
				const kind =
					column.aggregation != null
						? parseAggregationKind(column.aggregation)
						: defaultAggregationFor(valueType);
				const values = rows.map((r) => readPropertyPath(r, column.propertyId));
				const aggregate = computeAggregation(kind, values);
				const valueEl = (
					<>
						<span className="dbv-grid__foot-kind">{aggregationLabel(kind)}</span>
						<span className="dbv-grid__foot-value">
							{formatAggregation(aggregate, columnDefs.get(column.propertyId) ?? undefined)}
						</span>
					</>
				);
				return (
					<div
						key={column.propertyId}
						className="dbv-grid__cell dbv-grid__foot-cell"
						role="cell"
						style={{ width }}
					>
						{onPick ? (
							<button
								type="button"
								className="dbv-grid__foot-button"
								onClick={(e) => onPick(e.currentTarget, column.propertyId, valueType, kind)}
								title={`${aggregationLabel(kind)} — click to change`}
							>
								{valueEl}
							</button>
						) : (
							<span className="dbv-grid__foot-button dbv-grid__foot-button--static">{valueEl}</span>
						)}
					</div>
				);
			})}
		</div>
	);
}

/** Name column header — first cell, not sortable. `data-col="title"` lets
 *  the CSS make it sticky-left when `pinFirstColumn` is on. */
function PinnedHeaderCell({ width, label }: { width: number; label: string }): ReactElement {
	return (
		<div
			className="dbv-grid__cell dbv-grid__cell--head"
			role="columnheader"
			data-col="title"
			style={{ width }}
		>
			{label}
		</div>
	);
}

/** Header cell wired into dnd-kit's `useSortable`. Resize handle stops
 *  the pointer event from starting a reorder drag. */
/** The header label for a column: the property def's display `name` when the
 *  catalog (or inference) resolves one, else the humanized key. A user-created
 *  property has a generated key (`prop_<…>`) but a real name ("Status"); without
 *  this the header would read "Prop Mpx6xww2 2vzk7i" (F-017). */
function columnLabel(column: ColumnSpec, defs: ColumnDefs): string {
	if (column.rollup) return column.rollup.name;
	if (column.formula) return column.formula.name;
	const name = defs.get(column.propertyId)?.name;
	return name?.trim() ? name : humanize(column.propertyId);
}

function SortableHeaderCell({
	column,
	label,
	isActive,
	onResize,
}: {
	column: ColumnSpec;
	label: string;
	isActive: boolean;
	onResize: ((propertyId: string, width: number) => void) | undefined;
}): ReactElement {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: column.propertyId,
		attributes: { role: "columnheader", roleDescription: "sortable column" },
	});
	const baseWidth = column.width ?? DEFAULT_COLUMN_WIDTH;
	const [liveWidth, setLiveWidth] = useState<number | null>(null);
	const width = liveWidth ?? baseWidth;

	// `touch-action: none` + `user-select: none` are load-bearing for dnd-kit
	// pointer activation: without them the browser starts a text selection
	// (or a scroll on touch) and the 4-px activation-distance check never
	// resolves into a drag. `cursor: grab/grabbing` is the affordance the
	// row's `cursor: default` would otherwise swallow. See @dnd-kit
	// docs §Activators — these are the standard set.
	const style: CSSProperties = {
		width,
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.45 : 1,
		touchAction: "none",
		userSelect: "none",
		cursor: isDragging ? "grabbing" : "grab",
	};

	const handleResizePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLSpanElement>) => {
			if (!onResize) return;
			event.preventDefault();
			event.stopPropagation();
			const handle = event.currentTarget;
			const pointerId = event.pointerId;
			const startX = event.clientX;
			const startWidth = handle.parentElement?.getBoundingClientRect().width ?? baseWidth;
			handle.setPointerCapture(pointerId);
			const move = (ev: PointerEvent): void => {
				setLiveWidth(Math.max(60, Math.round(startWidth + (ev.clientX - startX))));
			};
			const teardown = (ev: PointerEvent, commit: boolean): void => {
				handle.releasePointerCapture(pointerId);
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", up);
				handle.removeEventListener("pointercancel", cancel);
				setLiveWidth(null);
				if (commit) {
					const final = Math.max(60, Math.round(startWidth + (ev.clientX - startX)));
					onResize(column.propertyId, final);
				}
			};
			const up = (ev: PointerEvent): void => teardown(ev, true);
			// Alt-tab / focus loss / OS gesture cancellation: drop the resize
			// without committing a stale width and release listeners + capture.
			const cancel = (ev: PointerEvent): void => teardown(ev, false);
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up);
			handle.addEventListener("pointercancel", cancel);
		},
		[baseWidth, column.propertyId, onResize],
	);

	return (
		<div
			ref={setNodeRef}
			className="dbv-grid__cell dbv-grid__cell--head"
			{...attributes}
			{...listeners}
			style={style}
			data-prop={column.propertyId}
			data-dragging={isDragging || isActive ? "true" : undefined}
			title={label}
		>
			{label}
			<span className="dbv-grid__resize" aria-hidden="true" onPointerDown={handleResizePointerDown} />
		</div>
	);
}

type GridRowProps = {
	entity: EntityRow;
	columns: ReadonlyArray<ColumnSpec>;
	selected: boolean;
	showRowNumber: boolean;
	rowNumber: number;
	/** Absolute index of this row in `compiled.rows` — the row half of each
	 *  cell's flat keyboard-cursor index (12.4 cell-nav). */
	rowIndex: number;
	/** Navigable column count (`= visible.length`), the cursor's grid width. */
	columnCount: number;
	/** Composite-keyboard props for a flat cell index (id / `gridcell` role /
	 *  `aria-selected`). Identity changes when the cursor moves, re-rendering
	 *  this memoized row so the active cell repaints. */
	getCellProps: (index: number) => CompositeItemProps;
	/** The cell the keyboard asked to edit (12.4 Enter-to-edit), or `null`. The
	 *  cell whose entity + property matches opens its inline editor. */
	editCell: EditTarget | null;
	/** Acked once a cell has consumed the edit signal so the host clears it. */
	onEditCellHandled: () => void;
	translateY: number;
	height: number;
	rowIds: ReadonlyArray<string>;
	columnDefs: ColumnDefs;
	rollupById: ReadonlyMap<string, EntityRow>;
	rollupTargetDefs: ColumnDefs;
	/** This row should take the keyboard on mount (F-215/F-216): the title
	 *  editor when editable, plain row focus otherwise. */
	pendingTitleEdit: boolean;
	onPendingTitleEditHandled: () => void;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
	onOpenInspector: (entity: EntityRow) => void;
	onReorderRows: ((orderedIds: string[]) => void) | undefined;
	/** The cross-app drag payload for a drag starting on this row (honours the
	 *  multi-select set). Identity-stable from the parent. */
	getDragItems: (entity: EntityRow) => ObjectDragItem[];
	onEdit: EntityPropertyEdit | undefined;
};

const GridRow = memo(function GridRow({
	entity,
	columns,
	selected,
	showRowNumber,
	rowNumber,
	rowIndex,
	columnCount,
	getCellProps,
	editCell,
	onEditCellHandled,
	translateY,
	height,
	rowIds,
	columnDefs,
	rollupById,
	rollupTargetDefs,
	pendingTitleEdit,
	onPendingTitleEditHandled,
	onSelect,
	onOpen,
	onOpenInspector,
	onReorderRows,
	getDragItems,
	onEdit,
}: GridRowProps): ReactElement {
	const rowRef = useRef<HTMLDivElement | null>(null);

	// Cross-app drag source (DND-4): a grip handle drives the shell-mediated drag
	// session via pointer events. `suppressNativeDragRef` flips the row's native
	// `draggable` (used for intra-grid reorder below) off for the gesture so the
	// two transports don't fight over the same pointer-down.
	const { dragHandleProps, dragging } = useDragSource({
		getItems: () => getDragItems(entity),
		suppressNativeDragRef: rowRef,
	});

	// Every row's name is inline-editable (spreadsheet rename) when the grid is
	// editable — `EditableTitle` opens on double-click and auto-opens for a
	// freshly-created row. Only when there's no editor at all does the row take
	// focus itself, so the keyboard handoff still leaves the "+ New" button.
	const titleEditable = onEdit !== undefined;
	useLayoutEffect(() => {
		if (!pendingTitleEdit || titleEditable) return;
		rowRef.current?.focus();
		onPendingTitleEditHandled();
	}, [pendingTitleEdit, titleEditable, onPendingTitleEditHandled]);

	const handleClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			onSelect(entity, {
				shiftKey: event.shiftKey,
				metaKey: event.metaKey || event.ctrlKey,
			});
		},
		[entity, onSelect],
	);

	const handleDoubleClick = useCallback(() => onOpen(entity), [entity, onOpen]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (event.key === "Enter") {
				event.preventDefault();
				onOpen(entity);
			}
		},
		[entity, onOpen],
	);

	const handleDragStart = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			event.dataTransfer.setData(ENTITY_MIME, entity.id);
			event.dataTransfer.effectAllowed = "move";
			if (rowRef.current) rowRef.current.dataset.dragging = "true";
		},
		[entity.id],
	);

	const handleDragEnd = useCallback(() => {
		if (rowRef.current) delete rowRef.current.dataset.dragging;
	}, []);

	const handleDragOver = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			if (!onReorderRows) return;
			if (!event.dataTransfer.types.includes(ENTITY_MIME)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
		},
		[onReorderRows],
	);

	const handleDrop = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			if (!onReorderRows) return;
			const dragged = event.dataTransfer.getData(ENTITY_MIME);
			if (!dragged || dragged === entity.id) return;
			event.preventDefault();
			const next = [...rowIds];
			const from = next.indexOf(dragged);
			if (from < 0) return;
			next.splice(from, 1);
			const to = next.indexOf(entity.id);
			next.splice(to < 0 ? next.length : to, 0, dragged);
			onReorderRows(next);
		},
		[entity.id, onReorderRows, rowIds],
	);

	return (
		<div
			ref={rowRef}
			className="dbv-grid__row"
			role="row"
			tabIndex={-1}
			draggable
			data-entity-id={entity.id}
			data-selected={selected ? "true" : undefined}
			data-dragging={dragging ? "true" : undefined}
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				right: 0,
				transform: `translateY(${translateY}px)`,
				height,
			}}
			onClick={handleClick}
			onDoubleClick={handleDoubleClick}
			onKeyDown={handleKeyDown}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
		>
			<button
				type="button"
				className="bs-drag-grip dbv-grid__drag-grip"
				draggable={false}
				aria-label={t("brainstorm.database.row.drag")}
				data-bs-tooltip={t("brainstorm.database.row.drag")}
				tabIndex={-1}
				{...dragHandleProps}
			>
				<Icon name={IconName.DragHandle} size={14} />
			</button>
			{showRowNumber ? <div className="dbv-grid__cell dbv-grid__cell--num">{rowNumber}</div> : null}
			{columns.map((c, colIndex) => {
				const flat = flatCellIndex(rowIndex, colIndex, columnCount);
				return (
					<GridCell
						key={c.propertyId}
						entity={entity}
						column={c}
						def={columnDefs.get(c.propertyId) ?? null}
						rollupById={rollupById}
						rollupTargetDef={rollupTargetDefs.get(c.propertyId) ?? null}
						cellProps={getCellProps(flat)}
						autoEdit={editCell?.entityId === entity.id && editCell?.propertyId === c.propertyId}
						onAutoEditHandled={onEditCellHandled}
						pendingTitleEdit={pendingTitleEdit && titleEditable}
						onPendingTitleEditHandled={onPendingTitleEditHandled}
						onEdit={onEdit}
						onOpenInspector={onOpenInspector}
					/>
				);
			})}
		</div>
	);
});

function GridCell({
	entity,
	column,
	def,
	rollupById,
	rollupTargetDef,
	cellProps,
	autoEdit,
	onAutoEditHandled,
	pendingTitleEdit,
	onPendingTitleEditHandled,
	onEdit,
	onOpenInspector,
}: {
	entity: EntityRow;
	column: ColumnSpec;
	def: PropertyDef | null;
	rollupById: ReadonlyMap<string, EntityRow>;
	rollupTargetDef: PropertyDef | null;
	/** Composite-keyboard props for this cell's flat cursor index — `id`
	 *  (`aria-activedescendant` target), `role="gridcell"`, `aria-selected`
	 *  (the cursor ring), `data-composite-index`, `tabIndex: -1`. */
	cellProps: CompositeItemProps;
	/** Keyboard Enter-to-edit signal for this cell (12.4); opens the inline
	 *  editor (data cells) or the title rename on the rising edge. */
	autoEdit: boolean;
	onAutoEditHandled: () => void;
	pendingTitleEdit: boolean;
	onPendingTitleEditHandled: () => void;
	onEdit: EntityPropertyEdit | undefined;
	onOpenInspector: (entity: EntityRow) => void;
}): ReactElement {
	const width =
		column.width ?? (column.propertyId === TITLE_COL ? TITLE_WIDTH : DEFAULT_COLUMN_WIDTH);
	if (column.rollup) {
		return (
			<div className="dbv-grid__cell dbv-grid__cell--rollup" style={{ width }} {...cellProps}>
				<RollupCell
					rollup={column.rollup}
					entity={entity}
					byId={rollupById}
					targetDef={rollupTargetDef}
				/>
			</div>
		);
	}
	if (column.formula) {
		return (
			<div className="dbv-grid__cell dbv-grid__cell--formula" style={{ width }} {...cellProps}>
				<FormulaCell formula={column.formula} entity={entity} />
			</div>
		);
	}
	if (column.propertyId === TITLE_COL) {
		// The title cell is the primary rename affordance for every row —
		// double-click the name to edit, like a spreadsheet. Opening the record
		// stays on the trailing open-arrow + Enter, so rename never shadows it.
		const titleEditable = onEdit !== undefined;
		return (
			<div className="dbv-grid__cell" data-col="title" style={{ width }} {...cellProps}>
				<DomSlot
					className="dbv-grid__title-glyph"
					build={() => entityIcon(entity, 16)}
					deps={[entity.id, entity.type, entity.properties.icon]}
				/>
				{titleEditable ? (
					<EditableTitle
						entity={entity}
						onEdit={onEdit}
						autoEdit={pendingTitleEdit}
						onAutoEditHandled={onPendingTitleEditHandled}
					/>
				) : (
					<span className="dbv-grid__title-label">{entityTitle(entity)}</span>
				)}
				<OpenRecordButton entity={entity} onOpenInspector={onOpenInspector} />
			</div>
		);
	}
	return (
		<div className="dbv-grid__cell dbv-grid__cell--editable" style={{ width }} {...cellProps}>
			<EditableCell
				entity={entity}
				propertyId={column.propertyId}
				def={def}
				layout="cell"
				onEdit={onEdit}
				autoEdit={autoEdit}
				onAutoEditHandled={onAutoEditHandled}
			/>
		</div>
	);
}

/** A computed rollup value (9.12.17), rendered read-only: walk the row's
 *  relation to its linked entities, aggregate their target property, and
 *  format the result in the target property's own units. */
export function RollupCell({
	rollup,
	entity,
	byId,
	targetDef,
}: {
	rollup: ColumnRollup;
	entity: EntityRow;
	byId: ReadonlyMap<string, EntityRow>;
	targetDef: PropertyDef | null;
}): ReactElement {
	const result = computeRollup(entity, columnRollupToSpec(rollup), byId);
	return (
		<span className="dbv-grid__rollup-value">
			{formatAggregation(result, targetDef ?? undefined)}
		</span>
	);
}

/** Read-only formula column cell (9.12.17): compiles the column's expression
 *  once and evaluates it against this row's properties. A compile / evaluation
 *  error renders as a muted `⚠` chip carrying the message as a tooltip rather
 *  than a value. */
export function FormulaCell({
	formula,
	entity,
}: {
	formula: ColumnFormula;
	entity: EntityRow;
}): ReactElement {
	const compiled = useMemo<{ ok: true; formula: CompiledFormula } | { ok: false; error: string }>(
		() => compileFormula(formula.expression),
		[formula.expression],
	);
	const result = compiled.ok
		? compiled.formula.evaluate((key) => entity.properties[key])
		: { ok: false as const, error: compiled.error };
	if (!result.ok) {
		return (
			<span className="dbv-grid__formula-error" title={result.error}>
				⚠
			</span>
		);
	}
	return <span className="dbv-grid__formula-value">{result.value.toLocaleString()}</span>;
}

/** Hover-revealed "Open" affordance in the title cell (F-023, Notion
 *  pattern). The deliberate way to open a row's Details inspector — selecting
 *  or editing a cell no longer auto-opens the panel. Stops propagation so the
 *  click doesn't also select/drag the row underneath. */
export function OpenRecordButton({
	entity,
	onOpenInspector,
}: {
	entity: EntityRow;
	onOpenInspector: (entity: EntityRow) => void;
}): ReactElement {
	const handleClick = useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			event.stopPropagation();
			onOpenInspector(entity);
		},
		[entity, onOpenInspector],
	);
	return (
		<button
			type="button"
			className="dbv-grid__open"
			data-bs-tooltip="Open"
			aria-label="Open"
			onClick={handleClick}
			onDoubleClick={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
		>
			<Icon name={IconName.OpenExternal} size={14} />
		</button>
	);
}

/** The name property a generic Object's title is stored in (mirrors the seed
 *  in `app.ts` and `entityTitle`'s `name` key). */
const TITLE_PROP = "name";

/** Inline-editable title for a grid row. Reads as the plain label
 *  until double-clicked (or Enter while focused), then becomes a text input
 *  that commits the new name to `properties.name` on blur/Enter and reverts on
 *  Escape. Pointer/key events are kept off the row so editing never selects,
 *  opens, or drags the row underneath. */
export function EditableTitle({
	entity,
	onEdit,
	autoEdit = false,
	onAutoEditHandled,
}: {
	entity: EntityRow;
	onEdit: EntityPropertyEdit;
	/** Open the editor on mount/update — the create / row-menu Rename
	 *  keyboard handoff (F-215/F-216). Consumed via `onAutoEditHandled`. */
	autoEdit?: boolean;
	onAutoEditHandled?: () => void;
}): ReactElement {
	const [editing, setEditing] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useLayoutEffect(() => {
		if (!autoEdit) return;
		setEditing(true);
		onAutoEditHandled?.();
	}, [autoEdit, onAutoEditHandled]);

	const raw =
		typeof entity.properties[TITLE_PROP] === "string"
			? (entity.properties[TITLE_PROP] as string)
			: "";

	// Focus + select exactly once when edit mode opens, so a parent re-render
	// (selection change, sibling row update) doesn't yank the caret or reselect
	// the user's in-progress text.
	useLayoutEffect(() => {
		if (!editing) return;
		const node = inputRef.current;
		if (!node) return;
		node.focus();
		node.select();
	}, [editing]);

	const commit = useCallback(() => {
		const next = inputRef.current?.value.trim() ?? "";
		setEditing(false);
		if (next !== raw) onEdit(entity, TITLE_PROP, next);
	}, [entity, onEdit, raw]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLInputElement>) => {
			event.stopPropagation();
			if (event.key === "Enter") {
				event.preventDefault();
				commit();
			} else if (event.key === "Escape") {
				event.preventDefault();
				setEditing(false);
			}
		},
		[commit],
	);

	if (editing) {
		return (
			<input
				ref={inputRef}
				className="dbv-grid__title-input"
				defaultValue={raw}
				aria-label="Name"
				onBlur={commit}
				onKeyDown={handleKeyDown}
				onClick={(event) => event.stopPropagation()}
				onDoubleClick={(event) => event.stopPropagation()}
				onPointerDown={(event) => event.stopPropagation()}
			/>
		);
	}

	return (
		<button
			type="button"
			className="dbv-grid__title-label dbv-grid__title-label--editable"
			title="Double-click to rename"
			onDoubleClick={(event) => {
				event.stopPropagation();
				setEditing(true);
			}}
		>
			{entityTitle(entity)}
		</button>
	);
}
