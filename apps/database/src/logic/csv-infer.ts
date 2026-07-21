/**
 * Generic CSV column detection + type inference (9.12.19, import half).
 *
 * The Contacts mapper maps known headers to `Person/v1` fields; this is the
 * type-agnostic path: take any CSV, treat the first row as a header, and infer
 * a property `ValueType` per column by sampling its cells. The output is a
 * column schema (name + inferred type) + the data rows aligned to it — the
 * pure keystone a future "import as a new list" flow consumes to mint property
 * defs and per-row values. No DOM, no entities service, never throws.
 *
 * Inference order per column matters: a column of `0`/`1` is Number, not
 * Boolean; `2024-01-15` is Date, not Number (the numeric test is strict so it
 * never claims a dashed date). An all-blank column falls back to Text.
 */

import { ValueType } from "@brainstorm-os/sdk-types";
import { parseCsvRows } from "./csv";

export type InferredCsvColumn = {
	/** Zero-based column index in each data row. */
	index: number;
	/** Header label, trimmed; `Column N` (1-based) when the header cell is blank. */
	name: string;
	/** Inferred base value type — one of Text / Number / Boolean / Date.
	 *  EntityRef / RichText are never inferred from a flat cell. */
	valueType: ValueType;
};

export type CsvInference = {
	columns: InferredCsvColumn[];
	/** Rows after the header, each a string-cell array (ragged rows tolerated). */
	dataRows: string[][];
};

const NUMERIC_RE = /^[+-]?\d+(\.\d+)?$/;
const BOOLEAN_TOKENS = new Set(["true", "false", "yes", "no"]);
const DATE_SEP_RE = /[-/]/;

function isNumeric(cell: string): boolean {
	return NUMERIC_RE.test(cell.trim());
}

function isBooleanToken(cell: string): boolean {
	return BOOLEAN_TOKENS.has(cell.trim().toLowerCase());
}

/** Date-ish: parses as a date AND carries a date separator (so a bare integer
 *  year like `2024` — which `Date.parse` happily accepts — is left to the
 *  Number test, which runs first anyway). */
function isDateish(cell: string): boolean {
	const trimmed = cell.trim();
	if (!DATE_SEP_RE.test(trimmed)) return false;
	if (isNumeric(trimmed)) return false;
	return !Number.isNaN(Date.parse(trimmed));
}

/** Classify a column from its non-empty sample cells. All-empty → Text. */
function inferColumnType(cells: readonly string[]): ValueType {
	const values = cells.map((c) => c.trim()).filter((c) => c.length > 0);
	if (values.length === 0) return ValueType.Text;
	if (values.every(isBooleanToken)) return ValueType.Boolean;
	if (values.every(isNumeric)) return ValueType.Number;
	if (values.every(isDateish)) return ValueType.Date;
	return ValueType.Text;
}

/**
 * Parse CSV text and infer a column schema. Returns `null` when there is no
 * header row (empty / whitespace-only input). The first non-blank row is the
 * header; every later row is data. A column's type is inferred from all data
 * cells at its index (missing cells in short rows are treated as empty).
 */
export function inferCsvColumns(text: string): CsvInference | null {
	const matrix = parseCsvRows(text);
	if (matrix.length === 0) return null;
	const header = matrix[0] ?? [];
	if (header.length === 0) return null;
	const dataRows = matrix.slice(1);
	const columns: InferredCsvColumn[] = header.map((raw, index) => {
		const name = raw.trim().length > 0 ? raw.trim() : `Column ${index + 1}`;
		const cells = dataRows.map((row) => row[index] ?? "");
		return { index, name, valueType: inferColumnType(cells) };
	});
	return { columns, dataRows };
}
