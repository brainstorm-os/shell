/**
 * Pure decision layer for the "Add formula…" authoring affordance (9.12.17
 * formula slice-2 creation flow). The DOM popover (`ui/view-settings.ts`) is a
 * thin shell over these functions so the validation + column-building grammar
 * is unit-tested without a grid or a live popover — mirroring `rollup-builder`
 * (the rollup column's pure candidate/builder layer).
 *
 * A formula column is authored from a free-text expression (compiled by the
 * existing `formula` engine) plus an optional display name. `validateDraft`
 * turns a draft into either a typed error to surface inline or the
 * ready-to-append `ColumnSpec`; `defaultFormulaName` is the name shown when the
 * user leaves the name field blank.
 */

import type { ColumnSpec } from "@brainstorm-os/sdk-types";
import { MAX_FORMULA_LENGTH, buildFormulaColumn, compileFormula } from "./formula";

/** Why a formula reference can be flagged before the column is built. */
export enum FormulaDraftErrorKind {
	/** The expression is empty / whitespace only. */
	Empty = "empty",
	/** The expression failed to compile (syntax, too long, …). */
	Syntax = "syntax",
	/** A `{key}` reference names a property no row in the list carries — the
	 *  formula would evaluate to an error on every row. Surfaced as a warning the
	 *  author can override (the property may appear once data is added), so it is
	 *  reported separately from a hard compile failure. */
	UnknownReference = "unknown-reference",
}

export type FormulaDraft = {
	readonly expression: string;
	/** Optional display name; blank → `defaultFormulaName`. */
	readonly name?: string;
};

export type FormulaDraftResult =
	| { readonly ok: true; readonly column: ColumnSpec }
	| {
			readonly ok: false;
			readonly kind: FormulaDraftErrorKind;
			readonly message: string;
			/** The offending reference keys, for `UnknownReference`. */
			readonly unknownRefs?: readonly string[];
	  };

/** The name a formula column gets when the author leaves the field blank: the
 *  trimmed expression itself (Notion shows the expression as the column name by
 *  default), capped so a long expression doesn't blow out the header. */
const DEFAULT_NAME_MAX = 40;

export function defaultFormulaName(expression: string): string {
	const trimmed = expression.trim();
	if (trimmed.length <= DEFAULT_NAME_MAX) return trimmed;
	return `${trimmed.slice(0, DEFAULT_NAME_MAX - 1)}…`;
}

/**
 * Validate an authoring draft against the formula engine + the known property
 * keys, returning the column to append or a typed error to surface inline.
 *
 * `knownKeys` are the property keys present on the list's rows (the same set the
 * column-adder offers); a reference to a key outside that set is flagged so the
 * author isn't surprised by an all-error column — but it is *not* a hard block
 * (`UnknownReference` is recoverable; the caller can offer "add anyway").
 */
export function validateFormulaDraft(
	draft: FormulaDraft,
	knownKeys: ReadonlyArray<string>,
): FormulaDraftResult {
	const expression = draft.expression.trim();
	if (expression === "") {
		return { ok: false, kind: FormulaDraftErrorKind.Empty, message: "Enter a formula" };
	}
	const compiled = compileFormula(expression);
	if (!compiled.ok) {
		return { ok: false, kind: FormulaDraftErrorKind.Syntax, message: compiled.error };
	}
	const known = new Set(knownKeys);
	const unknownRefs = compiled.formula.refs.filter((ref) => !known.has(ref));
	if (unknownRefs.length > 0) {
		return {
			ok: false,
			kind: FormulaDraftErrorKind.UnknownReference,
			message:
				unknownRefs.length === 1
					? `No property "${unknownRefs[0]}" on these objects`
					: `Unknown properties: ${unknownRefs.join(", ")}`,
			unknownRefs,
		};
	}
	const name = draft.name?.trim() ? draft.name.trim() : defaultFormulaName(expression);
	return { ok: true, column: buildFormulaColumn({ expression, name }) };
}

/** A formula column duplicates an existing one when the same expression is
 *  already a column (the synthetic id is expression-keyed). */
export function formulaAlreadyAdded(
	columns: ReadonlyArray<ColumnSpec>,
	expression: string,
): boolean {
	const id = buildFormulaColumn({ expression: expression.trim(), name: "" }).propertyId;
	return columns.some((c) => c.propertyId === id);
}

export { MAX_FORMULA_LENGTH };
