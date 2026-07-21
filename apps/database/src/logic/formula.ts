/**
 * Database formula-column glue. The pure formula ENGINE moved to the SDK
 * (`@brainstorm-os/sdk/formula`) so a first-class formula PROPERTY can render in
 * any app's property-ui; this module re-exports it for the app's existing
 * call-sites and adds the Database-only `ColumnSpec` builder (a formula COLUMN
 * is a per-view synthetic column, distinct from a formula property).
 */

import type { ColumnSpec } from "@brainstorm-os/sdk-types";

export {
	type CompiledFormula,
	type CompileResult,
	type FormulaResolver,
	type FormulaResult,
	MAX_FORMULA_LENGTH,
	compileFormula,
	evaluateFormula,
	formulaReferences,
} from "@brainstorm-os/sdk/formula";

/** A spec-derived, stable synthetic column id keyed on the expression — so the
 *  same formula is never added twice and React keys stay stable across rebuilds
 *  (mirrors `rollupColumnId`). */
export function formulaColumnId(expression: string): string {
	return `formula:${expression}`;
}

/** Build the `ColumnSpec` for a formula column, ready to append to a view's
 *  columns. */
export function buildFormulaColumn(opts: { expression: string; name: string }): ColumnSpec {
	return {
		propertyId: formulaColumnId(opts.expression),
		visible: true,
		formula: { expression: opts.expression, name: opts.name },
	};
}
