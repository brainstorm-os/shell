/**
 * Read-only computed-column cells (9.12.17 / DT-4) shared by the grid and the
 * card views (board / gallery / list). A rollup or formula column is never
 * editable — every surface renders it through these cells so the value face
 * (tabular numerals, muted, error chip) stays identical everywhere.
 *
 * The rollup lookups (full-vault id→row map + per-column target defs) are
 * computed once per view via `useRollupLookups` and reach the deeply-nested
 * cards through `ComputedCellsProvider` — the same shape `CardEditContext`
 * uses for the editing path.
 */

import type { ColumnFormula, ColumnRollup, PropertyDef } from "@brainstorm/sdk-types";
import { type ReactElement, type ReactNode, createContext, useContext, useMemo } from "react";
import { formatAggregation } from "../logic/aggregations";
import { effectiveColumnDef } from "../logic/effective-def";
import { type CompiledFormula, compileFormula } from "../logic/formula";
import type { EntityRow } from "../logic/in-memory-entities";
import { columnRollupToSpec, computeRollup, entitiesById } from "../logic/rollup";
import { renderCell } from "../render/cells";
import type { ColumnSpec } from "../types/list-view";

/** The per-view lookup state a rollup cell resolves against: the live id→row
 *  map over the FULL vault (the relation walks to entities of *other* types,
 *  absent from the view's rows) + the target property's def per rollup column
 *  (keyed by the column's synthetic `propertyId`) so the value formats in the
 *  target's own units. */
export type RollupLookups = {
	byId: ReadonlyMap<string, EntityRow>;
	targetDefs: ReadonlyMap<string, PropertyDef | null>;
};

const EMPTY_LOOKUPS: RollupLookups = { byId: new Map(), targetDefs: new Map() };

/** Build the rollup lookups for a view: `allRows` is the full vault set (else
 *  the view's own rows when the host gives no full set — rollups then resolve
 *  only against in-view entities, matching the grid's existing fallback). */
export function useRollupLookups(
	columns: ReadonlyArray<ColumnSpec>,
	allRows: ReadonlyArray<EntityRow> | undefined,
	fallbackRows: ReadonlyArray<EntityRow>,
): RollupLookups {
	const source = allRows ?? fallbackRows;
	const byId = useMemo(() => entitiesById(source), [source]);
	const targetDefs = useMemo(() => {
		const map = new Map<string, PropertyDef | null>();
		for (const c of columns) {
			if (!c.rollup) continue;
			map.set(c.propertyId, effectiveColumnDef(c.rollup.targetPropertyKey, source));
		}
		return map;
	}, [columns, source]);
	return useMemo(() => ({ byId, targetDefs }), [byId, targetDefs]);
}

const ComputedCellsContext = createContext<RollupLookups | null>(null);

export function ComputedCellsProvider({
	value,
	children,
}: {
	value: RollupLookups;
	children: ReactNode;
}): ReactElement {
	return <ComputedCellsContext.Provider value={value}>{children}</ComputedCellsContext.Provider>;
}

/** The view's rollup lookups, else empty lookups when the host mounts a card
 *  outside a provider (a rollup then reads as an empty aggregation, exactly
 *  like a row with no links — never a crash). */
export function useComputedCells(): RollupLookups {
	return useContext(ComputedCellsContext) ?? EMPTY_LOOKUPS;
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
		<span className="dbv-computed__value">{formatAggregation(result, targetDef ?? undefined)}</span>
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
			<span className="dbv-computed__error" title={result.error}>
				⚠
			</span>
		);
	}
	return <span className="dbv-computed__value">{result.value.toLocaleString()}</span>;
}

/** Dispatch on the column's computed kind — the one read-only cell every
 *  card / list surface mounts for a rollup or formula column, resolving the
 *  rollup lookups from context. `null` for a non-computed column (the caller
 *  then renders its normal editable / painted cell). */
export function ComputedCell({
	column,
	entity,
}: {
	column: ColumnSpec;
	entity: EntityRow;
}): ReactElement | null {
	const lookups = useComputedCells();
	if (column.rollup) {
		return (
			<RollupCell
				rollup={column.rollup}
				entity={entity}
				byId={lookups.byId}
				targetDef={lookups.targetDefs.get(column.propertyId) ?? null}
			/>
		);
	}
	if (column.formula) return <FormulaCell formula={column.formula} entity={entity} />;
	return null;
}

/** The display label for a computed column — its user-given (or generated)
 *  name; the synthetic `propertyId` would humanize to noise. `null` for a
 *  non-computed column. */
export function computedColumnLabel(column: ColumnSpec): string | null {
	if (column.rollup) return column.rollup.name;
	if (column.formula) return column.formula.name;
	return null;
}

/** The plain-text face of a computed column for a card's read-only chip strip
 *  (board / gallery with no editor). `null` when the column isn't computed or
 *  a formula errors — the caller falls back to `renderCell` / drops the chip. */
export function computedChipText(
	entity: EntityRow,
	column: ColumnSpec,
	lookups: RollupLookups,
): string | null {
	if (column.rollup) {
		const result = computeRollup(entity, columnRollupToSpec(column.rollup), lookups.byId);
		const def = lookups.targetDefs.get(column.propertyId) ?? undefined;
		return formatAggregation(result, def);
	}
	if (column.formula) {
		const compiled = compileFormula(column.formula.expression);
		if (!compiled.ok) return null;
		const result = compiled.formula.evaluate((key) => entity.properties[key]);
		return result.ok ? result.value.toLocaleString() : null;
	}
	return null;
}

export type CardChip = { id: string; text: string; color: string | null };

/** The read-only chip strip for a card (board / gallery with no editor): one
 *  chip per visible non-title column with a non-empty value — computed
 *  columns contribute their computed value (the synthetic propertyId resolves
 *  to nothing through `renderCell`). */
export function cardChips(
	entity: EntityRow,
	columns: ReadonlyArray<ColumnSpec>,
	lookups: RollupLookups,
): CardChip[] {
	const out: CardChip[] = [];
	for (const column of columns) {
		if (column.visible === false) continue;
		// The title/name column is the card heading, never a chip.
		if (column.propertyId === "title" || column.propertyId === "name") continue;
		if (column.rollup || column.formula) {
			const text = computedChipText(entity, column, lookups);
			if (text) out.push({ id: column.propertyId, text, color: null });
			continue;
		}
		const data = renderCell(entity, column.propertyId);
		if (data.kind !== "empty") {
			out.push({ id: column.propertyId, text: data.text, color: data.color });
		}
	}
	return out;
}
