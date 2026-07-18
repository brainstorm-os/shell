/**
 * Shared editable card-field strip — the one inline-editing surface for the
 * non-grid views (Gallery / List / Board). Each visible (non-title) column
 * renders as a labeled cell backed by the same shared B5.11 cells the grid +
 * inspector use, committing through the view's `onEdit`. When a view passes no
 * `onEdit` the column-defs map stays empty and the caller paints read-only
 * chips instead — so this is purely the editable path.
 *
 * Extracted from gallery-view (9.12.23) once List + Board needed the same
 * affordance — three consumers, one component (CLAUDE.md DRY rule).
 */

import type { PropertyDef } from "@brainstorm/sdk-types";
import {
	type ReactElement,
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useMemo,
} from "react";
import { effectiveColumnDef } from "../logic/effective-def";
import type { EntityRow } from "../logic/in-memory-entities";
import type { ColumnSpec } from "../types/list-view";
import { humanize } from "../ui/humanize";
import { ComputedCell, computedColumnLabel } from "./computed-cells";
import { EditableCell, type EntityPropertyEdit } from "./editable-cell";

export type ColumnDefs = ReadonlyMap<string, PropertyDef | null>;

/** Per-view inline-edit context: the commit callback + the effective defs for
 *  the visible columns. `null` (the default) means the view is read-only — a
 *  card/row then paints chips instead of editable cells. Lets the deeply-nested
 *  board cards reach the editor without prop-drilling through column/list. */
export type CardEdit = { onEdit: EntityPropertyEdit; columnDefs: ColumnDefs };

const CardEditContext = createContext<CardEdit | null>(null);

export function CardEditProvider({
	value,
	children,
}: {
	value: CardEdit | null;
	children: ReactNode;
}): ReactElement {
	return <CardEditContext.Provider value={value}>{children}</CardEditContext.Provider>;
}

export function useCardEdit(): CardEdit | null {
	return useContext(CardEditContext);
}

/** The title/name column is rendered as the card heading, never as a field. */
function isTitleColumn(propertyId: string): boolean {
	return propertyId === "title" || propertyId === "name";
}

/** Effective editing def per visible (non-title) column — the catalog def, else
 *  inferred from the visible rows. Empty (so callers fall back to read-only) when
 *  the view supplies no editor. Memoized so memoized cards share one map. */
export function useEditableColumnDefs(
	columns: ReadonlyArray<ColumnSpec>,
	rows: ReadonlyArray<EntityRow>,
	hasEdit: boolean,
): ColumnDefs {
	return useMemo<ColumnDefs>(() => {
		const map = new Map<string, PropertyDef | null>();
		if (!hasEdit) return map;
		for (const c of columns) {
			if (c.visible === false || isTitleColumn(c.propertyId)) continue;
			// A computed column (rollup / formula) has a synthetic propertyId no
			// entity carries — never editable, nothing to infer.
			if (c.rollup || c.formula) {
				map.set(c.propertyId, null);
				continue;
			}
			map.set(c.propertyId, effectiveColumnDef(c.propertyId, rows));
		}
		return map;
	}, [columns, rows, hasEdit]);
}

/** A labeled, inline-editable field list for a card/row. All pointer / key /
 *  drag events are stopped here so editing a field never also selects, opens,
 *  or drags the host card underneath (the grid title-input seam). */
export function CardFields({
	entity,
	columns,
	columnDefs,
	onEdit,
}: {
	entity: EntityRow;
	columns: ReadonlyArray<ColumnSpec>;
	columnDefs: ColumnDefs;
	onEdit: EntityPropertyEdit;
}): ReactElement {
	const stop = useCallback((event: { stopPropagation: () => void }) => event.stopPropagation(), []);
	return (
		// kbn-onclick-exempt: not an affordance — these handlers only stopPropagation so clicks inside the fields area don't bubble to the card's open action
		<dl
			className="dbv-card__fields"
			onClick={stop}
			onDoubleClick={stop}
			onPointerDown={stop}
			onMouseDown={stop}
			onKeyDown={stop}
			onDragStart={(event) => {
				event.preventDefault();
				event.stopPropagation();
			}}
		>
			{columns.map((c) => {
				if (c.visible === false || isTitleColumn(c.propertyId)) return null;
				// Computed columns (rollup / formula, 9.12.17) render read-only —
				// the same shared cells the grid mounts, labeled by the column's
				// own name (the synthetic propertyId would humanize to noise).
				if (c.rollup || c.formula) {
					return (
						<div className="dbv-card__field" data-computed="true" key={c.propertyId}>
							<dt className="dbv-card__field-label">{computedColumnLabel(c)}</dt>
							<dd className="dbv-card__field-value">
								<ComputedCell column={c} entity={entity} />
							</dd>
						</div>
					);
				}
				const def = columnDefs.get(c.propertyId) ?? null;
				const label = def?.name?.trim() ? def.name : humanize(c.propertyId);
				return (
					<div className="dbv-card__field" key={c.propertyId}>
						<dt className="dbv-card__field-label">{label}</dt>
						<dd className="dbv-card__field-value">
							<EditableCell
								entity={entity}
								propertyId={c.propertyId}
								def={def}
								layout="cell"
								onEdit={onEdit}
							/>
						</dd>
					</div>
				);
			})}
		</dl>
	);
}
