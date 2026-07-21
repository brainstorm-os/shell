/**
 * Generic CSV → entities import (9.12.19) — the type-agnostic flow on top of
 * the `csv-infer.ts` keystone. Where the Contacts mapper owns the
 * header→`Person/v1` mapping, this imports *any* CSV as a fresh collection of
 * generic Objects: the first column becomes each row's title (`name`), the
 * remaining columns become per-row properties keyed by their header, coerced to
 * the inferred type so the Database renders + edits them as the right cell
 * (Number / Boolean / Date / Text) via `effective-def` inference — no catalog
 * registration needed (a user upgrades a column to a typed/select property
 * later through the normal "Add column" path).
 */

import { ValueType } from "@brainstorm-os/sdk-types";
import { type InferredCsvColumn, inferCsvColumns } from "./csv-infer";
import { GENERIC_OBJECT_TYPE } from "./row-create";

export type CsvEntityImport = {
	/** The column whose value becomes each row's title (`name`). */
	nameColumn: InferredCsvColumn;
	/** The remaining columns → the new collection's view columns, keyed by
	 *  header name (the property key each row's value is written under). */
	propertyColumns: InferredCsvColumn[];
	/** One `entities.create`-ready property bag per data row. */
	rows: Record<string, unknown>[];
};

/** Parse + infer a CSV and shape it for import: title column + property
 *  columns + per-row property bags. `null` when the text has no columns. */
export function csvToEntityImport(text: string): CsvEntityImport | null {
	const inferred = inferCsvColumns(text);
	const nameColumn = inferred?.columns[0];
	if (!inferred || !nameColumn) return null;
	const propertyColumns = inferred.columns.slice(1);
	const rows = inferred.dataRows.map((cells) => {
		const props: Record<string, unknown> = { name: (cells[nameColumn.index] ?? "").trim() };
		for (const col of propertyColumns) {
			const value = coerceCell(cells[col.index], col.valueType);
			if (value !== undefined) props[col.name] = value;
		}
		return props;
	});
	return { nameColumn, propertyColumns, rows };
}

/** Coerce a raw cell to the inferred type's storage shape (mirrors what
 *  `effective-def` infers back): a Date becomes a Unix-ms timestamp (so the
 *  Database reads it as a date, not a string), Number a finite number, Boolean
 *  from `true/false/yes/no`, else the trimmed string. A blank / unparseable
 *  cell is `undefined` → the property is omitted (an empty cell, not a `0`). */
function coerceCell(cell: string | undefined, type: ValueType): unknown {
	const v = (cell ?? "").trim();
	if (v === "") return undefined;
	switch (type) {
		case ValueType.Number: {
			const n = Number(v);
			return Number.isFinite(n) ? n : undefined;
		}
		case ValueType.Boolean:
			return parseBoolean(v);
		case ValueType.Date: {
			const ms = Date.parse(v);
			return Number.isNaN(ms) ? undefined : ms;
		}
		default:
			return v;
	}
}

function parseBoolean(v: string): boolean | undefined {
	const lower = v.toLowerCase();
	if (lower === "true" || lower === "yes") return true;
	if (lower === "false" || lower === "no") return false;
	return undefined;
}

/** The minimal entities-service surface the commit needs. */
export type CsvImportEntitiesService = {
	create(type: string, properties: Record<string, unknown>): Promise<{ id: string }>;
};

/** Commit every imported row as a generic Object, returning the created ids
 *  (for pinning into the new collection's manual members). A row that fails to
 *  create is skipped — a partial import beats aborting the whole file. */
export async function commitCsvImport(
	imported: CsvEntityImport,
	entities: CsvImportEntitiesService,
): Promise<string[]> {
	const ids: string[] = [];
	for (const properties of imported.rows) {
		const created = await entities.create(GENERIC_OBJECT_TYPE, properties);
		if (created?.id) ids.push(created.id);
	}
	return ids;
}
