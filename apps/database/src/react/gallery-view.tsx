/**
 * Gallery view — React port. Responsive card grid with cover + title +
 * subtitle + chip strip. Per ` §Gallery`.
 *
 * Virtualized by *row of cards* (per the [[virtualize-lists-by-default]]
 * memory): a `ResizeObserver` measures the available width, we compute how
 * many fixed-width cards fit per row, and `@tanstack/react-virtual` windows
 * the rows. Card height varies with cover aspect + body content, so each
 * row reports its real height via `measureElement` — the estimate only
 * seeds the first paint. Scroll lives on the `.db-stage__body` ancestor,
 * same as grid/list.
 *
 * Cards are draggable (cross-view HTML5 drag, same MIME). Chips are
 * rendered from `renderCell` directly here (a small projection of
 * `paintPropertyValue` since gallery chips have their own classes /
 * color treatment in the imperative renderer).
 */

import type { PropertyDef } from "@brainstorm/sdk-types";
import { type CompositeItemProps, Orientation, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	type CSSProperties,
	type MouseEvent,
	type ReactElement,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { t } from "../i18n";
import type { CompiledView } from "../logic/compile-view";
import type { EntityRow } from "../logic/in-memory-entities";
import { coverBackgroundFor, entityIcon, entityTitle, renderCell } from "../render/cells";
import type { ColumnSpec, GalleryLayoutOptions } from "../types/list-view";
import { CardFields, type ColumnDefs, useEditableColumnDefs } from "./card-fields";
import {
	ComputedCellsProvider,
	cardChips,
	useComputedCells,
	useRollupLookups,
} from "./computed-cells";
import { DomSlot } from "./dom-slot";
import type { EntityPropertyEdit } from "./editable-cell";
import { useStableCallback } from "./use-stable-callback";

const ENTITY_MIME = "application/x-brainstorm-entity";
const GRID_GAP = 16;

const THUMB_SIZES: Record<GalleryLayoutOptions["thumbnailSize"], number> = {
	small: 160,
	medium: 220,
	large: 300,
};

const ASPECTS: Record<GalleryLayoutOptions["cardAspectRatio"], string> = {
	square: "1 / 1",
	video: "16 / 9",
	portrait: "3 / 4",
};

/** Numeric width-over-height for row-height estimation. */
const ASPECT_RATIO: Record<GalleryLayoutOptions["cardAspectRatio"], number> = {
	square: 1,
	video: 16 / 9,
	portrait: 3 / 4,
};

export type SelectionModifiers = { shiftKey: boolean; metaKey: boolean };

/** Keyboard navigation is single-select — moving the cursor replaces the
 *  selection (no range/toggle). Mirrors the list view. */
const NO_MODIFIERS: SelectionModifiers = { shiftKey: false, metaKey: false };

export type GalleryViewProps = {
	compiled: CompiledView;
	columns: ReadonlyArray<ColumnSpec>;
	/** The full live vault entity set — rollup columns walk a relation to
	 *  entities of *other* types, which aren't in `compiled.rows`. Mirrors the
	 *  grid's prop of the same name. */
	allRows?: ReadonlyArray<EntityRow>;
	layout: GalleryLayoutOptions;
	coverProperty: string | null;
	subtitleProperty: string | null;
	selectedIds: ReadonlySet<string>;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
	/** Commit an inline card-field edit (9.12.23). When omitted, cards show the
	 *  read-only chip strip; when present, each visible column becomes a labeled
	 *  editable cell (the shared B5.11 cells, same as grid + inspector). */
	onEdit?: EntityPropertyEdit;
};

export function GalleryView(props: GalleryViewProps): ReactElement {
	const { compiled, columns, layout, coverProperty, subtitleProperty, selectedIds } = props;
	const onSelect = useStableCallback(props.onSelect);
	const onOpen = useStableCallback(props.onOpen);
	const hasEdit = props.onEdit !== undefined;
	const onEdit = useStableCallback(props.onEdit ?? (() => {}));

	const columnDefs = useEditableColumnDefs(columns, compiled.rows, hasEdit);
	const rollupLookups = useRollupLookups(columns, props.allRows, compiled.rows);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const [viewportWidth, setViewportWidth] = useState(0);

	// Track the content width so we know how many cards fit per row.
	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		setViewportWidth(el.clientWidth);
		const ro = new ResizeObserver((entries) => {
			const w = entries[0]?.contentRect.width;
			if (typeof w === "number") setViewportWidth(w);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const cardW = THUMB_SIZES[layout.thumbnailSize];
	const cols = useMemo(() => {
		if (viewportWidth <= 0) return 1;
		return Math.max(1, Math.floor((viewportWidth + GRID_GAP) / (cardW + GRID_GAP)));
	}, [viewportWidth, cardW]);

	const rows = useMemo(() => {
		const out: EntityRow[][] = [];
		for (let i = 0; i < compiled.rows.length; i += cols) {
			out.push(compiled.rows.slice(i, i + cols));
		}
		return out;
	}, [compiled.rows, cols]);

	// Seed estimate: a card's cover + ~84px of body, plus the row gap.
	const cardActualWidth =
		cols > 0 && viewportWidth > 0 ? (viewportWidth - (cols - 1) * GRID_GAP) / cols : cardW;
	const estimatedRowHeight = cardActualWidth / ASPECT_RATIO[layout.cardAspectRatio] + 84 + GRID_GAP;

	const rowVirtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () =>
			scrollRef.current?.closest<HTMLElement>(".db-stage__body") ?? scrollRef.current,
		estimateSize: () => estimatedRowHeight,
		overscan: 4,
	});

	// KBN-A-database (gallery view): the card grid adopts the SDK composite-
	// keyboard reducer as a 2-D grid (`columns` = cards per row, derived from the
	// measured viewport). Virtualized by row → focus stays on the container with
	// `aria-activedescendant`; the active card's row is scrolled into view. The
	// cursor follows the first selected card; Left/Right move within a row,
	// Up/Down move between rows (single-select, no modifiers), Enter opens.
	const activeIndex = useMemo(
		() => compiled.rows.findIndex((r) => selectedIds.has(r.id)),
		[compiled.rows, selectedIds],
	);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Grid,
		count: compiled.rows.length,
		columns: cols,
		activeIndex,
		onActiveIndexChange: (index) => {
			const entity = compiled.rows[index];
			if (entity) onSelect(entity, NO_MODIFIERS);
			rowVirtualizer.scrollToIndex(Math.floor(index / cols));
		},
		onActivate: (index) => {
			const entity = compiled.rows[index];
			if (entity) onOpen(entity);
		},
		useAriaActiveDescendant: true,
	});

	const rootStyle = {
		"--dbv-card-w": `${cardW}px`,
		"--dbv-card-aspect": ASPECTS[layout.cardAspectRatio],
	} as CSSProperties;

	if (compiled.rows.length === 0) {
		return <div className="dbv-empty">{t("brainstorm.database.view.empty")}</div>;
	}

	return (
		<ComputedCellsProvider value={rollupLookups}>
			<div ref={scrollRef} className="dbv-gallery" style={rootStyle}>
				<div
					{...containerProps}
					ref={(node) => {
						viewportRef.current = node;
						containerProps.ref(node);
					}}
					className="dbv-gallery__virtual"
					style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
				>
					{rowVirtualizer.getVirtualItems().map((virtualRow) => {
						const rowCards = rows[virtualRow.index];
						if (!rowCards) return null;
						return (
							<div
								key={virtualRow.key}
								className="dbv-gallery__row"
								data-index={virtualRow.index}
								ref={rowVirtualizer.measureElement}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									right: 0,
									transform: `translateY(${virtualRow.start}px)`,
									display: "grid",
									gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
									gap: `${GRID_GAP}px`,
									paddingBottom: `${GRID_GAP}px`,
								}}
							>
								{rowCards.map((entity, offset) => (
									<GalleryCard
										key={entity.id}
										entity={entity}
										columns={columns}
										columnDefs={columnDefs}
										coverProperty={coverProperty}
										subtitleProperty={subtitleProperty}
										selected={selectedIds.has(entity.id)}
										itemProps={getItemProps(virtualRow.index * cols + offset)}
										onSelect={onSelect}
										onOpen={onOpen}
										onEdit={hasEdit ? onEdit : undefined}
									/>
								))}
							</div>
						);
					})}
				</div>
			</div>
		</ComputedCellsProvider>
	);
}

type GalleryCardProps = {
	entity: EntityRow;
	columns: ReadonlyArray<ColumnSpec>;
	columnDefs: ColumnDefs;
	coverProperty: string | null;
	subtitleProperty: string | null;
	selected: boolean;
	/** Roving gridcell props from the container's `useCompositeKeyboard`
	 *  (id / role / aria-selected / tabIndex). Keyboard activation lives on the
	 *  container, so the card carries no own key handler. */
	itemProps: CompositeItemProps;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
	onEdit: EntityPropertyEdit | undefined;
};

const GalleryCard = memo(function GalleryCard({
	entity,
	columns,
	columnDefs,
	coverProperty,
	subtitleProperty,
	selected,
	itemProps,
	onSelect,
	onOpen,
	onEdit,
}: GalleryCardProps): ReactElement {
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
			event.dataTransfer.setData(ENTITY_MIME, entity.id);
			event.dataTransfer.effectAllowed = "move";
			(event.currentTarget as HTMLElement).dataset.dragging = "true";
		},
		[entity.id],
	);
	const handleDragEnd = useCallback((event: React.DragEvent<HTMLElement>) => {
		delete (event.currentTarget as HTMLElement).dataset.dragging;
	}, []);

	const subtitle = subtitleProperty ? renderCell(entity, subtitleProperty).text : null;
	const editableColumns = columns.filter(
		(c) => c.visible !== false && c.propertyId !== "title" && c.propertyId !== "name",
	);
	const lookups = useComputedCells();
	const chips = onEdit ? [] : cardChips(entity, editableColumns, lookups);

	return (
		// kbn-onclick-exempt: role + roving tabindex come from `itemProps` (spread); keyboard activation is the container's `useCompositeKeyboard` reducer
		<article
			{...itemProps}
			className="dbv-card"
			data-entity-id={entity.id}
			data-selected={selected ? "true" : undefined}
			draggable
			onClick={handleClick}
			onDoubleClick={handleDoubleClick}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
		>
			<div
				className="dbv-card__cover"
				style={{ background: coverBackgroundFor(entity, coverProperty) }}
			/>
			<div className="dbv-card__body">
				<div className="dbv-card__title">
					<DomSlot
						className="dbv-card__title-glyph"
						build={() => entityIcon(entity)}
						deps={[entity.id, entity.type, entity.properties.icon]}
					/>
					<span className="dbv-card__title-text">{entityTitle(entity)}</span>
				</div>
				{subtitle ? <div className="dbv-card__subtitle">{subtitle}</div> : null}
				{onEdit ? (
					<CardFields
						entity={entity}
						columns={editableColumns}
						columnDefs={columnDefs}
						onEdit={onEdit}
					/>
				) : (
					<div className="dbv-card__chips">
						{chips.map(({ id, text, color }) => {
							const chipStyle: CSSProperties = color
								? {
										background: `color-mix(in srgb, ${color} 18%, transparent)`,
										color,
										borderColor: `color-mix(in srgb, ${color} 38%, transparent)`,
									}
								: {};
							return (
								<span key={id} className="dbv-card__chip" style={chipStyle}>
									{text}
								</span>
							);
						})}
					</div>
				)}
			</div>
		</article>
	);
});
