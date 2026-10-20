/**
 * Board view — React port. Kanban columns derived from `view.groupBy`.
 * Per ` §Board`.
 *
 * Column reorder — `@dnd-kit/sortable` horizontal strategy on the column
 * headers (matching the grid's column DnD pattern, fixing the same
 * "stuck multi-column line / not persistent" symptoms). The shared
 * `computeColumnReorder` style is unit-test-covered in grid-view; the
 * board's reorder shape is keys-only (`""` is the null group's wire
 * form) so we keep a local string-array `arrayMove`.
 *
 * Card move between columns stays native HTML5 (cross-column drop
 * target on the column body) — that's a different drag channel
 * (`application/x-brainstorm-entity`) and consumers depend on it.
 */

import { DragPayloadKind, type ObjectDragPayload } from "@brainstorm-os/sdk-types";
import {
	type CompositeItemProps,
	Orientation,
	useCompositeKeyboard,
} from "@brainstorm-os/sdk/a11y";
import { IconName, createIconElement } from "@brainstorm-os/sdk/icon";
import { DropSemantic, effectForSemantic, useDropTarget } from "@brainstorm-os/sdk/object-dnd";
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
	type MouseEvent,
	type ReactElement,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { t } from "../i18n";
import {
	type BoardGroup,
	groupWireKey,
	laneCells,
	manualGroupOrderActive,
	orderBoardGroups,
} from "../logic/board-groups";
import type { CompiledView } from "../logic/compile-view";
import type { EntityRow } from "../logic/in-memory-entities";
import { resolveVocabularyColor as vocabularyColor } from "../logic/property-resolver";
import { entityIcon, entityTitle, renderCell } from "../render/cells";
import type { BoardLayoutOptions, ColumnSpec, GroupBy } from "../types/list-view";
import { CardEditProvider, CardFields, useCardEdit, useEditableColumnDefs } from "./card-fields";
import {
	ComputedCellsProvider,
	cardChips,
	useComputedCells,
	useRollupLookups,
} from "./computed-cells";
import { DomSlot } from "./dom-slot";
import type { EntityPropertyEdit } from "./editable-cell";

const CARD_DND_MIME = "application/x-brainstorm-entity";

export type SelectionModifiers = { shiftKey: boolean; metaKey: boolean };

/** Keyboard navigation is single-select — moving the cursor replaces the
 *  selection (no range/toggle). Mirrors the list view. */
const NO_MODIFIERS: SelectionModifiers = { shiftKey: false, metaKey: false };

export type BoardViewProps = {
	compiled: CompiledView;
	columns: ReadonlyArray<ColumnSpec>;
	/** The full live vault entity set — rollup columns walk a relation to
	 *  entities of *other* types, which aren't in `compiled.rows`. Omitted
	 *  (e.g. no rollup columns) means rollups resolve against the view's own
	 *  rows only. Mirrors the grid's prop of the same name. */
	allRows?: ReadonlyArray<EntityRow>;
	layout: BoardLayoutOptions;
	groupBy: GroupBy;
	subtitleProperty: string | null;
	selectedIds: ReadonlySet<string>;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
	/** Move a card to a different group (cross-column HTML5 drop). The
	 *  card's source column is irrelevant here; the host updates the
	 *  grouping property by id. */
	onMoveToGroup: (entity: EntityRow, groupKey: string | null) => void;
	onReorderGroups?: (orderedKeys: string[]) => void;
	/** A cross-app object dropped on a column (DND-4): add it to the active list
	 *  and set its group-by property to the column's key. Distinct from the native
	 *  intra-app card move (`onMoveToGroup`) — the dropped object may be foreign. */
	onDropObject?: (groupKey: string | null, payload: ObjectDragPayload) => void;
	/** Commit an inline card-field edit. When omitted, cards show the read-only
	 *  chip strip; when present, each visible column becomes a labeled editable
	 *  cell (the shared cells, same as grid / gallery / inspector). */
	onEdit?: EntityPropertyEdit;
	/** Swimlanes (9.12.28) — the rows bucketed by `layout.swimlaneBy`, in lane
	 *  order. Omitted → one unlaned board. */
	lanes?: ReadonlyArray<BoardGroup>;
	/** A card dropped into a (column, lane) cell: the host writes both axes in
	 *  one patch. Required for lane drops; unlaned drops use `onMoveToGroup`. */
	onMoveToCell?: (entity: EntityRow, groupKey: string | null, laneKey: string | null) => void;
	/** Toggle a column's collapsed state (wire key). Omitted → no toggle. */
	onToggleGroupCollapsed?: (key: string) => void;
	/** Toggle a lane's collapsed state (wire key). */
	onToggleLaneCollapsed?: (key: string) => void;
};

type Group = BoardGroup;

const keyOf = groupWireKey;

/** Shared native card-drop wiring (the `application/x-brainstorm-entity`
 *  channel) for a column body or a lane cell. */
function useCardDrop(
	allRows: ReadonlyArray<EntityRow>,
	onDropEntity: (entity: EntityRow) => void,
): {
	onDragOver: (event: React.DragEvent<HTMLElement>) => void;
	onDragLeave: (event: React.DragEvent<HTMLElement>) => void;
	onDrop: (event: React.DragEvent<HTMLElement>) => void;
} {
	const onDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
		if (!event.dataTransfer.types.includes(CARD_DND_MIME)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		(event.currentTarget as HTMLElement).dataset.dropping = "true";
	}, []);
	const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
		if (event.target === event.currentTarget) {
			delete (event.currentTarget as HTMLElement).dataset.dropping;
		}
	}, []);
	const onDrop = useCallback(
		(event: React.DragEvent<HTMLElement>) => {
			delete (event.currentTarget as HTMLElement).dataset.dropping;
			const entityId = event.dataTransfer.getData(CARD_DND_MIME);
			if (!entityId) return;
			event.preventDefault();
			// A cross-column move can't find the dragged card in this bucket's
			// rows — resolve it against the board's full row set.
			const entity = allRows.find((e) => e.id === entityId);
			if (entity) onDropEntity(entity);
		},
		[allRows, onDropEntity],
	);
	return { onDragOver, onDragLeave, onDrop };
}

export function BoardView(props: BoardViewProps): ReactElement {
	const {
		compiled,
		columns,
		layout,
		groupBy,
		subtitleProperty,
		selectedIds,
		onSelect,
		onOpen,
		onMoveToGroup,
		onReorderGroups,
		onDropObject,
		onEdit,
		lanes,
		onMoveToCell,
		onToggleGroupCollapsed,
		onToggleLaneCollapsed,
	} = props;
	const columnDefs = useEditableColumnDefs(columns, compiled.rows, onEdit !== undefined);
	const cardEdit = onEdit ? { onEdit, columnDefs } : null;
	const rollupLookups = useRollupLookups(columns, props.allRows, compiled.rows);

	const baseGroups = compiled.groups.length
		? (compiled.groups as Group[])
		: [{ key: null, label: t("brainstorm.database.board.allLane"), rows: compiled.rows.slice() }];
	const groups = useMemo(() => orderBoardGroups(baseGroups, layout), [baseGroups, layout]);
	const visible = layout.collapseEmptyColumns ? groups.filter((g) => g.rows.length > 0) : groups;
	const sortableIds = useMemo(() => visible.map((g) => keyOf(g.key)), [visible]);
	const collapsedGroups = useMemo(
		() => new Set(layout.collapsedGroups ?? []),
		[layout.collapsedGroups],
	);
	const collapsedLanes = useMemo(
		() => new Set(layout.collapsedLanes ?? []),
		[layout.collapsedLanes],
	);
	const reorderEnabled = !!onReorderGroups && manualGroupOrderActive(layout);

	const [activeKey, setActiveKey] = useState<string | null>(null);
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const handleDragStart = useCallback(
		(event: DragStartEvent) => setActiveKey(String(event.active.id)),
		[],
	);
	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveKey(null);
			if (!onReorderGroups) return;
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const from = sortableIds.indexOf(String(active.id));
			const to = sortableIds.indexOf(String(over.id));
			if (from < 0 || to < 0) return;
			onReorderGroups(arrayMove(sortableIds, from, to));
		},
		[onReorderGroups, sortableIds],
	);
	const handleDragCancel = useCallback(() => setActiveKey(null), []);

	const rootStyle = { "--dbv-board-col-w": `${layout.columnWidth}px` } as CSSProperties;
	const shared = {
		groupBy,
		columns,
		layout,
		subtitleProperty,
		selectedIds,
		allRows: compiled.rows,
		onSelect,
		onOpen,
		onDropObject,
		reorderEnabled,
		onToggleCollapsed: onToggleGroupCollapsed,
	};

	return (
		<ComputedCellsProvider value={rollupLookups}>
			<CardEditProvider value={cardEdit}>
				<div className="dbv-board" style={rootStyle} data-laned={lanes ? "true" : undefined}>
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						modifiers={[restrictToHorizontalAxis]}
						onDragStart={handleDragStart}
						onDragEnd={handleDragEnd}
						onDragCancel={handleDragCancel}
					>
						{lanes ? (
							<div className="dbv-board__lanes">
								<div className="dbv-board__lane-head">
									<SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
										{visible.map((group) => (
											<BoardColumn
												key={keyOf(group.key)}
												{...shared}
												group={group}
												headerOnly
												collapsed={collapsedGroups.has(keyOf(group.key))}
												isActive={activeKey === keyOf(group.key)}
												onMoveToGroup={onMoveToGroup}
											/>
										))}
									</SortableContext>
								</div>
								{lanes.map((lane) => (
									<BoardLane
										key={keyOf(lane.key)}
										lane={lane}
										columnsInOrder={visible}
										collapsedGroups={collapsedGroups}
										collapsed={collapsedLanes.has(keyOf(lane.key))}
										swimlaneBy={layout.swimlaneBy ?? ""}
										groupBy={groupBy}
										columns={columns}
										layout={layout}
										subtitleProperty={subtitleProperty}
										selectedIds={selectedIds}
										allRows={compiled.rows}
										onSelect={onSelect}
										onOpen={onOpen}
										onMoveToCell={onMoveToCell}
										onToggleCollapsed={onToggleLaneCollapsed}
									/>
								))}
							</div>
						) : (
							<div className="dbv-board__stage">
								<SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
									{visible.map((group) => (
										<BoardColumn
											key={keyOf(group.key)}
											{...shared}
											group={group}
											headerOnly={false}
											collapsed={collapsedGroups.has(keyOf(group.key))}
											isActive={activeKey === keyOf(group.key)}
											onMoveToGroup={onMoveToGroup}
										/>
									))}
								</SortableContext>
							</div>
						)}
					</DndContext>
				</div>
			</CardEditProvider>
		</ComputedCellsProvider>
	);
}

/** Collapse / expand toggle in a column or lane header. Pointer + key events
 *  stop at the button so they never start the header's column-reorder drag. */
function CollapseToggle({
	collapsed,
	label,
	onToggle,
}: {
	collapsed: boolean;
	label: string;
	onToggle: () => void;
}): ReactElement {
	return (
		<button
			type="button"
			className="dbv-board__collapse"
			aria-expanded={!collapsed}
			aria-label={t(
				collapsed ? "brainstorm.database.board.expandGroup" : "brainstorm.database.board.collapseGroup",
				{ group: label },
			)}
			data-bs-tooltip={t(
				collapsed ? "brainstorm.database.board.expandGroup" : "brainstorm.database.board.collapseGroup",
				{ group: label },
			)}
			onPointerDown={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				onToggle();
			}}
		>
			<DomSlot
				className="dbv-board__collapse-glyph"
				build={() =>
					createIconElement(collapsed ? IconName.CaretRight : IconName.CaretDown, { size: 14 })
				}
				deps={[collapsed]}
			/>
		</button>
	);
}

function BoardColumn({
	group,
	groupBy,
	columns,
	layout,
	subtitleProperty,
	selectedIds,
	allRows,
	onSelect,
	onOpen,
	onMoveToGroup,
	onDropObject,
	isActive,
	reorderEnabled,
	headerOnly,
	collapsed,
	onToggleCollapsed,
}: {
	group: Group;
	groupBy: GroupBy;
	columns: ReadonlyArray<ColumnSpec>;
	layout: BoardLayoutOptions;
	subtitleProperty: string | null;
	selectedIds: ReadonlySet<string>;
	allRows: ReadonlyArray<EntityRow>;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
	onMoveToGroup: (entity: EntityRow, groupKey: string | null) => void;
	onDropObject: ((groupKey: string | null, payload: ObjectDragPayload) => void) | undefined;
	isActive: boolean;
	reorderEnabled: boolean;
	/** Laned boards render the column as a header strip; the cards live in
	 *  each lane's cells. */
	headerOnly: boolean;
	collapsed: boolean;
	onToggleCollapsed: ((key: string) => void) | undefined;
}): ReactElement {
	const sortableId = keyOf(group.key);
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: sortableId,
		disabled: !reorderEnabled,
		attributes: { roleDescription: "kanban column" },
	});

	// Cross-app drop target (DND-4): a foreign object dropped on this column is
	// added to the active list + grouped here (SetProperty). `nativeDisabled` —
	// the intra-app card move keeps its own `application/x-brainstorm-entity` path
	// (`useCardDrop` below); this is the shell-session transport only.
	const crossAppDrop = useDropTarget({
		nativeDisabled: true,
		accepts: (info) => onDropObject !== undefined && info.payloadKind === DragPayloadKind.Object,
		dropEffectFor: () => effectForSemantic(DropSemantic.SetProperty),
		onDrop: (payload) => onDropObject?.(group.key, payload),
	});
	const headerColor = group.key === null ? null : vocabularyColor(groupBy.propertyId, group.key);

	const setColumnRef = useCallback(
		(element: HTMLElement | null) => {
			setNodeRef(element);
			crossAppDrop.dropRef(element);
		},
		[setNodeRef, crossAppDrop.dropRef],
	);

	const colStyle: CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	const dropToGroup = useCallback(
		(entity: EntityRow) => onMoveToGroup(entity, group.key),
		[onMoveToGroup, group.key],
	);
	const drop = useCardDrop(allRows, dropToGroup);

	return (
		<section
			ref={setColumnRef}
			className="dbv-board__column"
			data-group-key={sortableId}
			data-header-only={headerOnly ? "true" : undefined}
			data-collapsed={collapsed ? "true" : undefined}
			data-col-dragging={isDragging || isActive ? "true" : undefined}
			data-cross-over={crossAppDrop.isOver ? "true" : undefined}
			style={colStyle}
			{...drop}
		>
			<header
				className="dbv-board__header"
				{...attributes}
				{...listeners}
				// Merged style: dnd-kit pointer prerequisites
				// (touch-action / user-select) + the per-group accent var.
				// `cursor: grab` mirrors the grid header.
				style={{
					touchAction: "none",
					userSelect: "none",
					cursor: reorderEnabled ? (isDragging ? "grabbing" : "grab") : "default",
					...(headerColor ? ({ "--dbv-col-accent": headerColor } as CSSProperties) : {}),
				}}
			>
				{onToggleCollapsed ? (
					<CollapseToggle
						collapsed={collapsed}
						label={group.label}
						onToggle={() => onToggleCollapsed(sortableId)}
					/>
				) : null}
				<span
					className="dbv-board__dot"
					style={headerColor ? { background: headerColor } : undefined}
				/>
				<span className="dbv-board__label">{group.label}</span>
				<span className="dbv-board__count">{group.rows.length}</span>
			</header>
			{headerOnly || collapsed ? null : (
				<BoardCardList
					rows={group.rows}
					columns={columns}
					layout={layout}
					subtitleProperty={subtitleProperty}
					selectedIds={selectedIds}
					onSelect={onSelect}
					onOpen={onOpen}
				/>
			)}
		</section>
	);
}

/** One horizontal swimlane: a collapsible lane header, then one cell per
 *  board column. Each cell is a card drop target that writes BOTH the column
 *  and the lane property (`onMoveToCell`). */
function BoardLane({
	lane,
	columnsInOrder,
	collapsedGroups,
	collapsed,
	swimlaneBy,
	groupBy,
	columns,
	layout,
	subtitleProperty,
	selectedIds,
	allRows,
	onSelect,
	onOpen,
	onMoveToCell,
	onToggleCollapsed,
}: {
	lane: Group;
	columnsInOrder: ReadonlyArray<Group>;
	collapsedGroups: ReadonlySet<string>;
	collapsed: boolean;
	swimlaneBy: string;
	groupBy: GroupBy;
	columns: ReadonlyArray<ColumnSpec>;
	layout: BoardLayoutOptions;
	subtitleProperty: string | null;
	selectedIds: ReadonlySet<string>;
	allRows: ReadonlyArray<EntityRow>;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
	onMoveToCell: BoardViewProps["onMoveToCell"];
	onToggleCollapsed: ((key: string) => void) | undefined;
}): ReactElement {
	const laneKey = keyOf(lane.key);
	const columnKeys = useMemo(() => columnsInOrder.map((g) => keyOf(g.key)), [columnsInOrder]);
	const cells = useMemo(
		() => laneCells(lane.rows, groupBy.propertyId, columnKeys),
		[lane.rows, groupBy.propertyId, columnKeys],
	);
	const laneColor = lane.key === null ? null : vocabularyColor(swimlaneBy, lane.key);
	return (
		<section
			className="dbv-board__lane"
			data-lane-key={laneKey}
			data-collapsed={collapsed ? "true" : undefined}
			aria-label={lane.label}
		>
			<header className="dbv-board__lane-header">
				{onToggleCollapsed ? (
					<CollapseToggle
						collapsed={collapsed}
						label={lane.label}
						onToggle={() => onToggleCollapsed(laneKey)}
					/>
				) : null}
				<span className="dbv-board__dot" style={laneColor ? { background: laneColor } : undefined} />
				<span className="dbv-board__label">{lane.label}</span>
				<span className="dbv-board__count">{lane.rows.length}</span>
			</header>
			{collapsed ? null : (
				<div className="dbv-board__lane-row">
					{columnsInOrder.map((group) => (
						<BoardLaneCell
							key={keyOf(group.key)}
							groupKey={group.key}
							laneKey={lane.key}
							rows={cells.get(keyOf(group.key)) ?? []}
							collapsed={collapsedGroups.has(keyOf(group.key))}
							columns={columns}
							layout={layout}
							subtitleProperty={subtitleProperty}
							selectedIds={selectedIds}
							allRows={allRows}
							onSelect={onSelect}
							onOpen={onOpen}
							onMoveToCell={onMoveToCell}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function BoardLaneCell({
	groupKey,
	laneKey,
	rows,
	collapsed,
	columns,
	layout,
	subtitleProperty,
	selectedIds,
	allRows,
	onSelect,
	onOpen,
	onMoveToCell,
}: {
	groupKey: string | null;
	laneKey: string | null;
	rows: ReadonlyArray<EntityRow>;
	collapsed: boolean;
	columns: ReadonlyArray<ColumnSpec>;
	layout: BoardLayoutOptions;
	subtitleProperty: string | null;
	selectedIds: ReadonlySet<string>;
	allRows: ReadonlyArray<EntityRow>;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
	onMoveToCell: BoardViewProps["onMoveToCell"];
}): ReactElement {
	const dropToCell = useCallback(
		(entity: EntityRow) => onMoveToCell?.(entity, groupKey, laneKey),
		[onMoveToCell, groupKey, laneKey],
	);
	const drop = useCardDrop(allRows, dropToCell);
	return (
		<div
			className="dbv-board__cell"
			data-group-key={keyOf(groupKey)}
			data-collapsed={collapsed ? "true" : undefined}
			{...drop}
		>
			{collapsed ? (
				<span className="dbv-board__cell-count">{rows.length}</span>
			) : (
				<BoardCardList
					rows={rows}
					columns={columns}
					layout={layout}
					subtitleProperty={subtitleProperty}
					selectedIds={selectedIds}
					onSelect={onSelect}
					onOpen={onOpen}
				/>
			)}
		</div>
	);
}

/** A column's cards, windowed with `@tanstack/react-virtual`. The column
 *  body (`.dbv-board__cards`) is a bounded scroll viewport (the column has a
 *  `max-height`), so each column virtualizes its own card stack — a board
 *  grouped by status can hold thousands in one column. Card height varies
 *  with wrapping titles, so rows report real height via `measureElement`. */
function BoardCardList({
	rows,
	columns,
	layout,
	subtitleProperty,
	selectedIds,
	onSelect,
	onOpen,
}: {
	rows: ReadonlyArray<EntityRow>;
	columns: ReadonlyArray<ColumnSpec>;
	layout: BoardLayoutOptions;
	subtitleProperty: string | null;
	selectedIds: ReadonlySet<string>;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
}): ReactElement {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => 64,
		overscan: 6,
	});

	// KBN-A-database (board view): each column's card stack is its own vertical
	// listbox — arrows move the cursor within the column and Enter opens. Cards
	// are virtualized → focus stays on the column container with
	// `aria-activedescendant` and the active card is scrolled into view. The
	// cursor follows the first selected card in this column (single-select, no
	// modifiers). Cross-column movement stays with dnd-kit's column reorder /
	// native card drag; arrows do not jump columns.
	const activeIndex = useMemo(
		() => rows.findIndex((r) => selectedIds.has(r.id)),
		[rows, selectedIds],
	);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: rows.length,
		activeIndex,
		onActiveIndexChange: (index) => {
			const entity = rows[index];
			if (entity) onSelect(entity, NO_MODIFIERS);
			virtualizer.scrollToIndex(index);
		},
		onActivate: (index) => {
			const entity = rows[index];
			if (entity) onOpen(entity);
		},
		useAriaActiveDescendant: true,
	});

	if (rows.length === 0) {
		return (
			<div className="dbv-board__cards" ref={scrollRef}>
				<div className="dbv-board__placeholder">{t("brainstorm.database.board.empty")}</div>
			</div>
		);
	}

	return (
		<div className="dbv-board__cards" ref={scrollRef}>
			<div
				{...containerProps}
				className="dbv-board__cards-inner"
				style={{ height: virtualizer.getTotalSize(), position: "relative" }}
			>
				{virtualizer.getVirtualItems().map((virtualRow) => {
					const entity = rows[virtualRow.index];
					if (!entity) return null;
					return (
						<div
							key={entity.id}
							data-index={virtualRow.index}
							ref={virtualizer.measureElement}
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								right: 0,
								transform: `translateY(${virtualRow.start}px)`,
								paddingBottom: "var(--space-2)",
							}}
						>
							<BoardCard
								entity={entity}
								columns={columns}
								layout={layout}
								subtitleProperty={subtitleProperty}
								selected={selectedIds.has(entity.id)}
								itemProps={getItemProps(virtualRow.index)}
								onSelect={onSelect}
								onOpen={onOpen}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function BoardCard({
	entity,
	columns,
	layout,
	subtitleProperty,
	selected,
	itemProps,
	onSelect,
	onOpen,
}: {
	entity: EntityRow;
	columns: ReadonlyArray<ColumnSpec>;
	layout: BoardLayoutOptions;
	subtitleProperty: string | null;
	selected: boolean;
	/** Roving listbox-option props from the column's `useCompositeKeyboard`
	 *  (id / role / aria-selected / tabIndex). Keyboard activation lives on the
	 *  column container, so the card carries no own key handler. */
	itemProps: CompositeItemProps;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
}): ReactElement {
	const handleClick = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			onSelect(entity, {
				shiftKey: event.shiftKey,
				metaKey: event.metaKey || event.ctrlKey,
			});
		},
		[entity, onSelect],
	);
	const handleDoubleClick = useCallback(() => onOpen(entity), [entity, onOpen]);
	const handleDragStart = useCallback(
		(event: React.DragEvent<HTMLElement>) => {
			event.dataTransfer.setData(CARD_DND_MIME, entity.id);
			event.dataTransfer.effectAllowed = "move";
			(event.currentTarget as HTMLElement).dataset.dragging = "true";
		},
		[entity.id],
	);
	const handleDragEnd = useCallback((event: React.DragEvent<HTMLElement>) => {
		delete (event.currentTarget as HTMLElement).dataset.dragging;
	}, []);

	const cardEdit = useCardEdit();
	const lookups = useComputedCells();
	const chips = useMemo(
		() => (layout.cardPreview === "rich" && !cardEdit ? cardChips(entity, columns, lookups) : []),
		[layout.cardPreview, cardEdit, columns, entity, lookups],
	);

	return (
		// kbn-onclick-exempt: role + roving tabindex come from `itemProps` (spread); keyboard activation is the column container's `useCompositeKeyboard` reducer
		<article
			{...itemProps}
			className="dbv-card dbv-board__card"
			data-entity-id={entity.id}
			data-preview={layout.cardPreview}
			data-selected={selected ? "true" : undefined}
			draggable
			onClick={handleClick}
			onDoubleClick={handleDoubleClick}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
		>
			<div className="dbv-board__card-title">
				<DomSlot
					className="dbv-board__card-glyph"
					build={() => entityIcon(entity)}
					deps={[entity.id, entity.type, entity.properties.icon]}
				/>
				<span>{entityTitle(entity)}</span>
			</div>
			{subtitleProperty ? (
				<div className="dbv-board__card-subtitle">{renderCell(entity, subtitleProperty).text}</div>
			) : null}
			{cardEdit ? (
				<CardFields
					entity={entity}
					columns={columns}
					columnDefs={cardEdit.columnDefs}
					onEdit={cardEdit.onEdit}
				/>
			) : null}
			{chips.length > 0 ? (
				<div className="dbv-board__card-chips">
					{chips.map(({ id, text, color }) => (
						<span
							key={id}
							className="dbv-card__chip"
							style={
								color
									? {
											background: `color-mix(in srgb, ${color} 18%, transparent)`,
											color,
											borderColor: `color-mix(in srgb, ${color} 38%, transparent)`,
										}
									: undefined
							}
						>
							{text}
						</span>
					))}
				</div>
			) : null}
		</article>
	);
}
