/**
 * `<LayoutView>` (Stage 8.3) — the generic render pipeline for
 * `brainstorm/Layout/v1`.
 *
 * Give it a resolved `LayoutDef` (Stage 8.2's `resolveLayout` picks it)
 * and an entity, and it paints the cells: property values through the
 * shared cell registry, groups with their own nested mode, text /
 * divider inline, and the two host seams — `renderBlock` (the
 * BlockEmbed bridge is app-side) and `renderChrome` (Stage 8.4's
 * registry). Modes are CSS: `stacked` is a flex column, `grid` is CSS
 * Grid from each cell's `{col,row,span}`, `freeform` is an absolutely
 * positioned canvas.
 *
 * Two invariants worth knowing before editing this file:
 *
 * 1. **DOM order is reading order** (see `plan.ts`). Visual position is
 *    CSS-only, so traversal follows doc 27's accessibility contract by
 *    construction rather than by a parallel aria-order to maintain.
 * 2. **One property cell = one subscription.** `<PropertyCellView>`
 *    subscribes to its own key via `useSyncExternalStore`, so a write to
 *    one property repaints one cell, not the layout.
 */

import {
	type BlockCell,
	type ChromeCell,
	type GroupCell,
	type LayoutCell,
	LayoutCellKind,
	type LayoutDef,
	LayoutMode,
	type PropertyCell,
	type PropertyDef,
	type TextCell,
	type ValueType,
	defaultViewFor,
} from "@brainstorm-os/sdk-types";
import {
	type ReactElement,
	type ReactNode,
	useCallback,
	useMemo,
	useSyncExternalStore,
} from "react";
import type { EntityRow } from "../in-memory-entities";
import { getCell } from "../property-ui/cells";
import {
	type CellStyle,
	cellStyle,
	containerClass,
	freeformExtent,
	groupMode,
	planSiblings,
	readingOrderRank,
} from "./plan";
import type { LayoutValueSource } from "./value-source";

/** Host-supplied renderers for the cell kinds the SDK cannot own. */
export type LayoutViewSeams = {
	/** A `block` cell — the Block Protocol embed bridge lives app-side
	 *  (doc 15). Absent ⇒ the cell renders a labelled placeholder rather
	 *  than vanishing, so an unsupported host is visible, not silent. */
	renderBlock?: (cell: BlockCell) => ReactNode;
	/** A `chrome` cell — Stage 8.4's registry plugs in here. Absent ⇒ a
	 *  labelled placeholder, same reasoning. */
	renderChrome?: (cell: ChromeCell) => ReactNode;
	/** Resolve a `textKey` / `labelKey` to display text. Absent ⇒ the key
	 *  itself, which is visible-but-wrong rather than blank. */
	t?: (key: string) => string;
	/** Wrap each cell's rendered body in host chrome — a field label, a
	 *  required marker, a validation message. The layout owns *which*
	 *  cells exist and *where*; a host still owns what surrounds one, and
	 *  without this seam every such host would fork the pipeline to get a
	 *  label (which is exactly what the form-designer's fill pane did).
	 *  Absent ⇒ the body renders bare. */
	renderCell?: (cell: LayoutCell, body: ReactNode) => ReactNode;
	/** Render a property cell the registry cannot draw — the key has no
	 *  `PropertyDef`, or no cell is registered for its (valueType, view).
	 *  Hosts that must stay fillable regardless (a form) supply a plain
	 *  text input here; absent ⇒ the labelled placeholder, which is
	 *  visible but not editable. */
	renderMissingCell?: (cell: PropertyCell, def: PropertyDef | undefined) => ReactNode;
};

export type LayoutViewProps = {
	layout: LayoutDef;
	/** The entity being rendered — its `properties` feed `condition`
	 *  evaluation. Values shown in cells come from `values`. */
	entity: EntityRow;
	/** The effective `PropertyDef` for a key (the entity's schema).
	 *  A property cell whose key has no def renders an unknown-property
	 *  placeholder rather than throwing. */
	propertyDef: (key: string) => PropertyDef | undefined;
	values: LayoutValueSource;
	onChange?: (property: string, next: unknown) => void;
	readOnly?: boolean;
	seams?: LayoutViewSeams;
	className?: string;
	/** Evaluation clock for relative-date conditions (tests pin it). */
	now?: number;
};

export function LayoutView({
	layout,
	entity,
	propertyDef,
	values,
	onChange,
	readOnly,
	seams,
	className,
	now,
}: LayoutViewProps): ReactElement {
	const rank = useMemo(() => readingOrderRank(layout), [layout]);
	const cells = planSiblings(layout.cells, entity, rank, now);
	const classes = [containerClass(layout.mode), className].filter(Boolean).join(" ");
	const extent = layout.mode === LayoutMode.Freeform ? freeformExtent(cells) : null;

	return (
		<div
			className={classes}
			data-layout-mode={layout.mode}
			style={extent ? { width: extent.width, height: extent.height } : undefined}
		>
			{cells.map((cell) => (
				<CellView
					key={cell.id}
					cell={cell}
					mode={layout.mode}
					entity={entity}
					rank={rank}
					propertyDef={propertyDef}
					values={values}
					{...(onChange ? { onChange } : {})}
					{...(readOnly !== undefined ? { readOnly } : {})}
					{...(seams ? { seams } : {})}
					{...(now !== undefined ? { now } : {})}
				/>
			))}
		</div>
	);
}

type CellViewProps = {
	cell: LayoutCell;
	mode: LayoutMode;
	entity: EntityRow;
	rank: ReadonlyMap<string, number>;
	propertyDef: (key: string) => PropertyDef | undefined;
	values: LayoutValueSource;
	onChange?: (property: string, next: unknown) => void;
	readOnly?: boolean;
	seams?: LayoutViewSeams;
	now?: number;
};

function CellView(props: CellViewProps): ReactElement {
	const { cell, mode, seams } = props;
	const style = cellStyle(cell, mode) as CellStyle;
	const body = <CellBody {...props} />;
	return (
		<div
			className={`bs-layout__cell bs-layout__cell--${cell.kind}`}
			data-cell-id={cell.id}
			style={style}
		>
			{seams?.renderCell ? seams.renderCell(cell, body) : body}
		</div>
	);
}

function CellBody(props: CellViewProps): ReactElement {
	const { cell, seams } = props;
	switch (cell.kind) {
		case LayoutCellKind.Property:
			return <PropertyCellView {...props} cell={cell} />;
		case LayoutCellKind.Group:
			return <GroupCellView {...props} cell={cell} />;
		case LayoutCellKind.Text:
			return <TextCellView cell={cell} t={seams?.t} />;
		case LayoutCellKind.Divider:
			return <hr className="bs-layout__divider" />;
		case LayoutCellKind.Block:
			return <SeamCellView rendered={seams?.renderBlock?.(cell)} kind="block" name={cell.block} />;
		case LayoutCellKind.Chrome:
			return <SeamCellView rendered={seams?.renderChrome?.(cell)} kind="chrome" name={cell.chrome} />;
		default:
			return <UnsupportedCell label={(cell as LayoutCell).kind} />;
	}
}

/**
 * One property, subscribed on its own. `useSyncExternalStore` over the
 * source's per-key `subscribe` is what keeps a write to one property
 * from repainting its siblings.
 */
function PropertyCellView(props: CellViewProps & { cell: PropertyCell }): ReactElement {
	const { cell, entity, propertyDef, values, onChange, readOnly } = props;
	const key = cell.property;

	const subscribe = useCallback(
		(listener: () => void) => values.subscribe(key, listener),
		[values, key],
	);
	const getSnapshot = useCallback(() => values.get(key), [values, key]);
	const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	const commit = useCallback((next: unknown) => onChange?.(key, next), [onChange, key]);

	const def = propertyDef(key);
	const missing = props.seams?.renderMissingCell;
	if (!def) {
		const fallback = missing?.(cell, undefined);
		return fallback ? <>{fallback}</> : <UnknownProperty property={key} />;
	}

	// A layout cell may override the property's default display (doc 27).
	const effectiveDef: PropertyDef = cell.display ? { ...def, display: cell.display } : def;
	const Cell = getCell(effectiveDef.valueType, defaultViewFor(effectiveDef));
	if (!Cell) {
		const fallback = missing?.(cell, def);
		return fallback ? <>{fallback}</> : <UnknownProperty property={key} />;
	}

	return (
		<Cell
			property={effectiveDef as PropertyDef & { valueType: ValueType }}
			value={value as never}
			onChange={commit as never}
			noteId={entity.id}
			{...(readOnly !== undefined ? { readOnly } : {})}
			siblings={entity.properties}
		/>
	);
}

function GroupCellView(props: CellViewProps & { cell: GroupCell }): ReactElement {
	const { cell, mode, entity, rank, seams, now } = props;
	const inner = groupMode(cell, mode);
	const children = planSiblings(cell.cells, entity, rank, now);
	const label =
		cell.label ?? (cell.labelKey ? (seams?.t?.(cell.labelKey) ?? cell.labelKey) : undefined);
	const extent = inner === LayoutMode.Freeform ? freeformExtent(children) : null;

	return (
		<section className="bs-layout__group" aria-label={label}>
			{label ? <h3 className="bs-layout__group-label">{label}</h3> : null}
			<div
				className={containerClass(inner)}
				data-layout-mode={inner}
				style={extent ? { width: extent.width, height: extent.height } : undefined}
			>
				{children.map((child) => (
					<CellView {...props} key={child.id} cell={child} mode={inner} />
				))}
			</div>
		</section>
	);
}

function TextCellView({
	cell,
	t,
}: { cell: TextCell; t: ((key: string) => string) | undefined }): ReactElement {
	const text = cell.text ?? (cell.textKey ? (t?.(cell.textKey) ?? cell.textKey) : "");
	return <p className="bs-layout__text">{text}</p>;
}

/** A seam cell the host didn't supply a renderer for. Deliberately
 *  visible: a silently-dropped cell reads as a layout bug with no clue. */
function SeamCellView({
	rendered,
	kind,
	name,
}: {
	rendered: ReactNode;
	kind: string;
	name: string;
}): ReactElement {
	if (rendered !== undefined && rendered !== null) return <>{rendered}</>;
	return (
		<div className="bs-layout__placeholder" data-placeholder={kind}>
			{`${kind}: ${name}`}
		</div>
	);
}

function UnknownProperty({ property }: { property: string }): ReactElement {
	return (
		<div className="bs-layout__placeholder" data-placeholder="property">
			{property}
		</div>
	);
}

function UnsupportedCell({ label }: { label: string }): ReactElement {
	return (
		<div className="bs-layout__placeholder" data-placeholder="unsupported">
			{label}
		</div>
	);
}
