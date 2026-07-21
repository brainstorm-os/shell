/**
 * `<PropertiesPanel>` — the shared properties inspector CONTENT used by every
 * app (Notes / Journal / Database / Bookmarks): a 44px header, a scrolling
 * body, and property rows rendered through the shared property-value cells.
 * Chrome ships in `properties-panel.css` (via `app-theme.css`).
 *
 * CONTENT-ONLY by design — the surrounding CONTAINER (positioning / glass /
 * slide / resize) is the app's, exactly as Notes already separates them:
 * Notes wraps this in its resizable grid `.notes__props` aside; Bookmarks
 * wraps it in the shared `.bs-props` glass-overlay container (also in this
 * sheet). One content component everywhere; each app picks its container.
 *
 * Generic over the data source: each app maps its object to a `rows` array
 * (def + already-read value + callbacks). Editing, removing, an add-property
 * control, and a metadata block are all OPT-IN via props, so a fixed read-only
 * set (Bookmarks) and a fully-editable vault-property set (Notes) use the SAME
 * component. Wrap in `<PropertiesProvider>` so the cells reach the vault.
 */

import { type PropertyDef, defaultViewFor } from "@brainstorm-os/sdk-types";
import type { ReactNode } from "react";
import { Icon, IconName } from "../icon";
import { getCell } from "../property-ui";

export type PropertiesPanelRow = {
	def: PropertyDef;
	/** The value already read for this def (via `readValue`). */
	value: unknown;
	readOnly?: boolean;
	/** Called with the cell's new value; omit for a display-only row. */
	onChange?: (next: unknown) => void;
	/** Renders a hover remove affordance when provided (unbind the property). */
	onRemove?: () => void;
	/** Custom value renderer. When provided, the row renders this node in the
	 *  value column INSTEAD of the def-derived `getCell` cell — for hosts whose
	 *  values need richer rendering than a scalar cell (e.g. Database's
	 *  `EditableCell`, which paints arrays / rich text / system fields the
	 *  scalar cells can't). The shared label / grid / remove chrome is unchanged. */
	valueNode?: ReactNode;
};

export type PropertiesPanelMeta = {
	label: string;
	value: string;
	title?: string;
};

export type PropertiesPanelProps = {
	title: string;
	rows: readonly PropertiesPanelRow[];
	/** The entity id handed to cells (some cells key per-object UI state). */
	entityId: string;
	/** Accessible name for each remove button: `(name) => string`. */
	removeLabel?: (name: string) => string;
	emptyLabel?: string;
	/** Renders a header close button (e.g. the panel toggle). */
	onClose?: () => void;
	closeLabel?: string;
	/** Suppress the panel's own `.bs-props__head` (title + close). Use when the
	 *  panel is hosted inside a tab strip that already labels it "Properties"
	 *  (Notes / Journal `CommentsRightPanel`) — otherwise the tab AND the panel
	 *  header both read "Properties", a redundant double header. */
	hideHeader?: boolean;
	/** Renders an "add property" button below the rows. */
	onAdd?: () => void;
	addLabel?: string;
	addButtonRef?: React.Ref<HTMLButtonElement>;
	/** Footer metadata rows (created / updated, word count, …). */
	meta?: readonly PropertiesPanelMeta[];
	/** Rendered at the top of the scrolling body, before the rows — the
	 *  cover-band slot (the host's cover wrapper carries `flex-shrink: 0`). */
	lead?: ReactNode;
	/** Rendered after the rows (before `meta`) — extra panel sections the
	 *  host owns (e.g. Books' table of contents). Scrolls with the body. */
	children?: ReactNode;
};

export function PropertiesPanel({
	title,
	rows,
	entityId,
	removeLabel,
	emptyLabel,
	onClose,
	closeLabel,
	hideHeader,
	onAdd,
	addLabel,
	addButtonRef,
	meta,
	lead,
	children,
}: PropertiesPanelProps): ReactNode {
	// The whole entity's values, keyed by property key — passed to each cell so a
	// computed cell (formula) can resolve references to sibling properties.
	const siblingValues: Record<string, unknown> = {};
	for (const row of rows) siblingValues[row.def.key] = row.value;
	return (
		<div className="bs-props__inner">
			{hideHeader ? null : (
				<header className="bs-props__head">
					<h2 className="bs-props__title">{title}</h2>
					{onClose ? (
						<button
							type="button"
							className="bs-props__close"
							onClick={onClose}
							aria-label={closeLabel ?? title}
							data-bs-tooltip={closeLabel ?? title}
						>
							<Icon name={IconName.Close} />
						</button>
					) : null}
				</header>
			)}

			<div className="bs-props__body">
				{lead}
				{rows.length === 0 && emptyLabel ? (
					<p className="bs-props__status">{emptyLabel}</p>
				) : (
					<dl className="bs-props__list">
						{rows.map((row) => (
							<PropertyRow
								key={row.def.key}
								row={row}
								entityId={entityId}
								removeLabel={removeLabel}
								siblings={siblingValues}
							/>
						))}
					</dl>
				)}

				{onAdd ? (
					<button ref={addButtonRef} type="button" className="bs-props__add" onClick={onAdd}>
						<span className="bs-props__add-glyph" aria-hidden="true">
							<Icon name={IconName.Plus} />
						</span>
						<span>{addLabel}</span>
					</button>
				) : null}

				{children}

				{meta && meta.length > 0 ? (
					<dl className="bs-props__meta">
						{meta.map((entry) => (
							<div className="bs-props__meta-row" key={entry.label}>
								<dt>{entry.label}</dt>
								<dd {...(entry.title ? { title: entry.title } : {})}>{entry.value}</dd>
							</div>
						))}
					</dl>
				) : null}
			</div>
		</div>
	);
}

function PropertyRow({
	row,
	entityId,
	removeLabel,
	siblings,
}: {
	row: PropertiesPanelRow;
	entityId: string;
	removeLabel?: ((name: string) => string) | undefined;
	siblings?: Readonly<Record<string, unknown>>;
}): ReactNode {
	const { def } = row;
	const Cell = row.valueNode === undefined ? getCell(def.valueType, defaultViewFor(def)) : undefined;
	return (
		<div className="bs-props__row" data-property-key={def.key}>
			<dt className="bs-props__row-label" title={def.description ?? def.name}>
				{def.name}
			</dt>
			<dd className="bs-props__row-value">
				{row.valueNode !== undefined ? (
					row.valueNode
				) : Cell ? (
					<Cell
						property={def}
						value={row.value}
						onChange={(next) => row.onChange?.(next)}
						readOnly={row.readOnly ?? row.onChange === undefined}
						noteId={entityId}
						{...(siblings ? { siblings } : {})}
					/>
				) : (
					<span>{String(row.value ?? "")}</span>
				)}
				{row.onRemove ? (
					<button
						type="button"
						className="bs-props__row-remove"
						onClick={row.onRemove}
						aria-label={removeLabel?.(def.name) ?? def.name}
						data-bs-tooltip={removeLabel?.(def.name) ?? def.name}
					>
						<Icon name={IconName.Trash} />
					</button>
				) : null}
			</dd>
		</div>
	);
}
