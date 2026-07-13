/**
 * List view — React port. Row-per-entity stack with no fixed columns;
 * each row shows a type glyph + title + inline property chips.
 * Per ` §List`.
 *
 * Rows are windowed with `@tanstack/react-virtual` (mirroring grid-view):
 * only on-screen rows mount, so a list bounded by vault volume stays cheap
 * (per the [[virtualize-lists-by-default]] memory). Scroll happens on the
 * `.db-stage__body` ancestor (`overflow:auto` lives there), so the
 * virtualizer targets that element, not our wrapper.
 *
 * Behavior parity with the pre-virtual port: same DOM shape, same classes,
 * same drag MIME type (`application/x-brainstorm-entity`). Rows are single-
 * line (title + props both ellipsize), so a fixed per-density row height is
 * accurate — no dynamic measurement needed.
 */

import { type CompositeItemProps, Orientation, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	type CSSProperties,
	type MouseEvent,
	type ReactElement,
	memo,
	useCallback,
	useMemo,
	useRef,
} from "react";
import { t } from "../i18n";
import type { CompiledView } from "../logic/compile-view";
import type { EntityRow } from "../logic/in-memory-entities";
import { entityIcon, entityTitle, paintPropertyValue } from "../render/cells";
import type { ColumnSpec, ListLayoutOptions } from "../types/list-view";
import { CardEditProvider, useCardEdit, useEditableColumnDefs } from "./card-fields";
import { DomSlot } from "./dom-slot";
import { EditableCell, type EntityPropertyEdit } from "./editable-cell";
import { useStableCallback } from "./use-stable-callback";

const ENTITY_MIME = "application/x-brainstorm-entity";

const DENSITY_ROW_HEIGHT: Record<ListLayoutOptions["density"], number> = {
	compact: 34,
	comfortable: 44,
};

export type SelectionModifiers = { shiftKey: boolean; metaKey: boolean };

/** Keyboard navigation is single-select — moving the cursor replaces the
 *  selection (no range/toggle). */
const NO_MODIFIERS: SelectionModifiers = { shiftKey: false, metaKey: false };

export type ListViewProps = {
	compiled: CompiledView;
	columns: ReadonlyArray<ColumnSpec>;
	layout: ListLayoutOptions;
	selectedIds: ReadonlySet<string>;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
	/** Commit an inline property edit. When omitted, each row's property strip
	 *  is read-only; when present, the cells become inline-editable (the shared
	 *  cells, same as grid / board / gallery). */
	onEdit?: EntityPropertyEdit;
};

export function ListView(props: ListViewProps): ReactElement {
	const { compiled, columns, layout, selectedIds, onEdit } = props;
	const onSelect = useStableCallback(props.onSelect);
	const onOpen = useStableCallback(props.onOpen);
	const columnDefs = useEditableColumnDefs(columns, compiled.rows, onEdit !== undefined);
	const cardEdit = onEdit ? { onEdit, columnDefs } : null;

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const rowHeight = DENSITY_ROW_HEIGHT[layout.density];
	const rowVirtualizer = useVirtualizer({
		count: compiled.rows.length,
		getScrollElement: () =>
			scrollRef.current?.closest<HTMLElement>(".db-stage__body") ?? scrollRef.current,
		estimateSize: () => rowHeight,
		overscan: 10,
	});

	const visible = useMemo(() => columns.filter((c) => c.visible !== false), [columns]);

	// KBN-A-database (list view): the row list adopts the SDK composite-keyboard
	// reducer as a vertical listbox. Virtualized → focus stays on the container
	// with `aria-activedescendant` + `scrollToIndex` (the Bin precedent). The
	// cursor follows the first selected row; arrows move it (single-select, no
	// modifiers) and Enter opens. (The grid view's cell-level 2D keyboard lands
	// with the inline-editing work, 9.12.23.)
	const activeIndex = useMemo(
		() => compiled.rows.findIndex((r) => selectedIds.has(r.id)),
		[compiled.rows, selectedIds],
	);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: compiled.rows.length,
		activeIndex,
		onActiveIndexChange: (index) => {
			const row = compiled.rows[index];
			if (row) onSelect(row, NO_MODIFIERS);
			rowVirtualizer.scrollToIndex(index);
		},
		onActivate: (index) => {
			const row = compiled.rows[index];
			if (row) onOpen(row);
		},
		useAriaActiveDescendant: true,
	});

	if (compiled.rows.length === 0) {
		return <div className="dbv-empty">{t("brainstorm.database.view.empty")}</div>;
	}

	const listStyle: CSSProperties = {
		height: rowVirtualizer.getTotalSize(),
		position: "relative",
	};

	return (
		<CardEditProvider value={cardEdit}>
			<div ref={scrollRef} className="dbv-list" data-density={layout.density}>
				<ul {...containerProps} className="dbv-list__items" style={listStyle}>
					{rowVirtualizer.getVirtualItems().map((virtualRow) => {
						const entity = compiled.rows[virtualRow.index];
						if (!entity) return null;
						return (
							<ListItem
								key={entity.id}
								entity={entity}
								columns={visible}
								showIcon={layout.showIcon}
								selected={selectedIds.has(entity.id)}
								translateY={virtualRow.start}
								height={virtualRow.size}
								itemProps={getItemProps(virtualRow.index)}
								onSelect={onSelect}
								onOpen={onOpen}
							/>
						);
					})}
				</ul>
			</div>
		</CardEditProvider>
	);
}

type ListItemProps = {
	entity: EntityRow;
	columns: ReadonlyArray<ColumnSpec>;
	showIcon: boolean;
	selected: boolean;
	translateY: number;
	height: number;
	/** Roving listbox-option props from the container's `useCompositeKeyboard`
	 *  (id / role / aria-selected / tabIndex). Keyboard activation lives on the
	 *  container, so the row carries no own key handler. */
	itemProps: CompositeItemProps;
	onSelect: (entity: EntityRow, modifiers: SelectionModifiers) => void;
	onOpen: (entity: EntityRow) => void;
};

const ListItem = memo(function ListItem({
	entity,
	columns,
	showIcon,
	selected,
	translateY,
	height,
	itemProps,
	onSelect,
	onOpen,
}: ListItemProps): ReactElement {
	const handleClick = useCallback(
		(event: MouseEvent<HTMLLIElement>) => {
			onSelect(entity, {
				shiftKey: event.shiftKey,
				metaKey: event.metaKey || event.ctrlKey,
			});
		},
		[entity, onSelect],
	);
	const handleDoubleClick = useCallback(() => onOpen(entity), [entity, onOpen]);
	const handleDragStart = useCallback(
		(event: React.DragEvent<HTMLLIElement>) => {
			event.dataTransfer.setData(ENTITY_MIME, entity.id);
			event.dataTransfer.effectAllowed = "move";
			(event.currentTarget as HTMLElement).dataset.dragging = "true";
		},
		[entity.id],
	);
	const handleDragEnd = useCallback((event: React.DragEvent<HTMLLIElement>) => {
		delete (event.currentTarget as HTMLElement).dataset.dragging;
	}, []);

	return (
		// kbn-onclick-exempt: role + roving tabindex come from `itemProps` (spread); keyboard activation is the container's `useCompositeKeyboard` reducer
		<li
			{...itemProps}
			className="dbv-list__item"
			data-entity-id={entity.id}
			data-selected={selected ? "true" : undefined}
			draggable
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
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
		>
			{showIcon ? (
				<DomSlot
					className="dbv-list__glyph"
					build={() => entityIcon(entity)}
					deps={[entity.id, entity.type, entity.properties.icon]}
				/>
			) : (
				<span />
			)}
			<div className="dbv-list__title">{entityTitle(entity)}</div>
			<ListItemFields entity={entity} columns={columns} />
		</li>
	);
});

/** The row's property strip — inline-editable cells when the view supplies an
 *  editor (via `useCardEdit`), else the read-only painted chips. Title/name is
 *  the row heading, never a strip cell. Pointer/key events on an editable cell
 *  stop at the cell so editing doesn't also select/open/drag the row. */
function ListItemFields({
	entity,
	columns,
}: {
	entity: EntityRow;
	columns: ReadonlyArray<ColumnSpec>;
}): ReactElement {
	const cardEdit = useCardEdit();
	const stop = useCallback((e: { stopPropagation: () => void }) => e.stopPropagation(), []);
	if (cardEdit) {
		return (
			// kbn-onclick-exempt: handlers only stopPropagation so cell edits don't bubble to the row's select/open
			<div
				className="dbv-list__props dbv-list__props--editable"
				onClick={stop}
				onDoubleClick={stop}
				onPointerDown={stop}
				onMouseDown={stop}
				onKeyDown={stop}
			>
				{columns.map((column) =>
					column.propertyId === "title" || column.propertyId === "name" ? null : (
						<EditableCell
							key={column.propertyId}
							entity={entity}
							propertyId={column.propertyId}
							def={cardEdit.columnDefs.get(column.propertyId) ?? null}
							layout="inline"
							onEdit={cardEdit.onEdit}
						/>
					),
				)}
			</div>
		);
	}
	return (
		<div className="dbv-list__props">
			{columns.map((column) =>
				// Title/name is the row heading — same skip as the editable strip
				// above, else the full title paints AGAIN as the first chip.
				column.propertyId === "title" || column.propertyId === "name" ? null : (
					<DomSlot
						key={column.propertyId}
						build={() => paintPropertyValue(entity, column.propertyId, "inline")}
						deps={[entity.id, column.propertyId, entity.properties[column.propertyId]]}
					/>
				),
			)}
		</div>
	);
}
