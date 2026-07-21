/**
 * Map stage (IE-2) — column → property + ValueType inference.
 *
 * The shallow v1 mapping doc 45 §The import flow step 4 specifies: infer a
 * ValueType per column from its sample values, bind each column to a property
 * key, and surface the result as a {@link MappingPlan} the wizard (IE-3) lets
 * the user override. Inference here is deliberately conservative — a bare
 * number stays a Number (never auto-guessed as an epoch Date), and only
 * ISO-ish date strings promote to Date — because a wrong silent guess is worse
 * than a Text the user can re-map.
 */

import { ValueType } from "@brainstorm-os/sdk-types";
import type { ColumnMapping, MappingPlan, ParsedTable } from "./import-types";

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;
const EXTERNAL_ID_COLUMNS = new Set(["id", "externalId", "external_id", "uid", "uuid", "guid"]);

function isMeaningful(value: unknown): boolean {
	return value !== null && value !== undefined && value !== "";
}

function looksLikeDate(value: string): boolean {
	return ISO_DATE_PREFIX.test(value) && !Number.isNaN(Date.parse(value));
}

/** Infer a column's ValueType from its sample values. Empty / mixed columns
 *  fall back to Text. */
export function inferValueType(samples: readonly unknown[]): ValueType {
	const present = samples.filter(isMeaningful);
	if (present.length === 0) return ValueType.Text;
	if (present.every((v) => typeof v === "boolean")) return ValueType.Boolean;
	if (present.every((v) => typeof v === "number")) return ValueType.Number;
	if (present.every((v) => typeof v === "string")) {
		return present.every((v) => looksLikeDate(v as string)) ? ValueType.Date : ValueType.Text;
	}
	return ValueType.Text;
}

/** Build the default mapping for a table targeting a vault type. Every column
 *  is bound and included; the user overrides type/property/inclusion in IE-3.
 *
 *  When `knownProps` is supplied (the target type's existing PropertyDefs,
 *  keyed by property key → ValueType), a column whose name matches an existing
 *  property adopts that property's declared ValueType instead of the
 *  sample-inferred guess — so importing onto an established type lands values in
 *  the shape the type already expects, rather than re-guessing per import. */
export function inferMapping(
	table: ParsedTable,
	targetType: string,
	source: string,
	knownProps?: ReadonlyMap<string, ValueType>,
): MappingPlan {
	const columns: ColumnMapping[] = table.columns.map((column) => ({
		column,
		property: column,
		valueType: knownProps?.get(column) ?? inferValueType(table.records.map((r) => r.fields[column])),
		include: true,
	}));
	const dedupeColumn = table.columns.find((c) => EXTERNAL_ID_COLUMNS.has(c)) ?? null;
	return { source, targetType, columns, dedupeColumn };
}
