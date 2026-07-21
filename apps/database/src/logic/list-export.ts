/**
 * List export (9.12.19) — serialize the active list's rows to CSV / JSON /
 * Markdown. Pure: a string matrix (headers + rows) in, a string out, so the
 * RFC-4180 escaping + Markdown pipe-escaping + JSON shaping are unit-tested
 * without the grid. `buildExportMatrix` assembles the matrix from the
 * Database's `EntityRow` shape (Name column first, then one column per
 * visible property); the host wires the result to `requestSaveBytes`.
 */

import { type EntityRow, readPropertyPath } from "@brainstorm-os/sdk/in-memory-entities";

export enum ListExportFormat {
	Csv = "csv",
	Json = "json",
	Markdown = "markdown",
}

export type ExportColumn = { key: string; header: string };

export type ExportMatrix = { headers: readonly string[]; rows: readonly (readonly string[])[] };

/** Per-format serialization options surfaced by the export popover. All
 *  optional — omitting them reproduces the original defaults (comma CSV with a
 *  header row, pretty-printed JSON). */
export interface ListExportOptions {
	/** CSV field separator. Default `","`. */
	csvDelimiter?: string;
	/** Emit the header row in CSV. Default `true`. */
	csvIncludeHeader?: boolean;
	/** Indent JSON with 2 spaces (vs. minified). Default `true`. */
	jsonPretty?: boolean;
}

/** Stringify a raw property value for a flat export cell. Arrays join with
 *  "; "; objects fall back to JSON; null/undefined are blank. */
export function valueToCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value))
		return value
			.map(valueToCell)
			.filter((s) => s.length > 0)
			.join("; ");
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return "";
		}
	}
	return String(value);
}

/** Build the export matrix: a leading "Name" column (the entity title) then
 *  one column per export column, in order. */
export function buildExportMatrix(
	rows: readonly EntityRow[],
	columns: readonly ExportColumn[],
	titleOf: (row: EntityRow) => string,
	nameHeader = "Name",
): ExportMatrix {
	const headers = [nameHeader, ...columns.map((c) => c.header)];
	const body = rows.map((row) => [
		titleOf(row),
		...columns.map((c) => valueToCell(readPropertyPath(row, c.key))),
	]);
	return { headers, rows: body };
}

/** Neutralize CSV formula injection: a cell whose first character is `=`, `+`,
 *  `-`, `@`, tab, or CR is executable when the file is reopened in Excel /
 *  Sheets (e.g. `=HYPERLINK(...)`). Prefixing a single quote forces the cell to
 *  be read as text — the spreadsheet strips the `'` on display. Applied to all
 *  CSV cells (the spreadsheet-import format); JSON/Markdown don't auto-execute.
 *  OWASP CSV-injection guidance. Exported for tests. */
export function neutralizeCsvFormula(value: string): string {
	return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** RFC-4180 field escaping: neutralize formula injection, then wrap in quotes
 *  when the value carries the field delimiter, a quote, CR, or LF; double any
 *  embedded quote. */
function escapeCsvField(value: string, delimiter: string): string {
	const safe = neutralizeCsvFormula(value);
	const needsQuote = safe.includes(delimiter) || /["\r\n]/.test(safe);
	if (needsQuote) return `"${safe.replace(/"/g, '""')}"`;
	return safe;
}

export function toCsv(matrix: ExportMatrix, options: ListExportOptions = {}): string {
	const delimiter = options.csvDelimiter ?? ",";
	const includeHeader = options.csvIncludeHeader ?? true;
	const source = includeHeader ? [matrix.headers, ...matrix.rows] : matrix.rows;
	const lines = source.map((row) =>
		row.map((cell) => escapeCsvField(cell, delimiter)).join(delimiter),
	);
	// RFC-4180 uses CRLF line endings.
	return lines.join("\r\n");
}

export function toJson(matrix: ExportMatrix, options: ListExportOptions = {}): string {
	const objects = matrix.rows.map((row) => {
		const obj: Record<string, string> = {};
		matrix.headers.forEach((header, i) => {
			obj[header] = row[i] ?? "";
		});
		return obj;
	});
	return JSON.stringify(objects, null, options.jsonPretty === false ? 0 : 2);
}

/** A Markdown cell escapes pipes (the column delimiter) and collapses
 *  newlines to a `<br>` so a multi-line value doesn't break the row. */
function escapeMarkdownCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function toMarkdown(matrix: ExportMatrix): string {
	const header = `| ${matrix.headers.map(escapeMarkdownCell).join(" | ")} |`;
	const divider = `| ${matrix.headers.map(() => "---").join(" | ")} |`;
	const body = matrix.rows.map(
		(row) => `| ${row.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`,
	);
	return [header, divider, ...body].join("\n");
}

export function serializeList(
	format: ListExportFormat,
	matrix: ExportMatrix,
	options: ListExportOptions = {},
): string {
	switch (format) {
		case ListExportFormat.Csv:
			return toCsv(matrix, options);
		case ListExportFormat.Json:
			return toJson(matrix, options);
		case ListExportFormat.Markdown:
			return toMarkdown(matrix);
		default:
			return toCsv(matrix, options);
	}
}

/** File extension for a format (for the save dialog + filename). */
export function extensionFor(format: ListExportFormat): string {
	switch (format) {
		case ListExportFormat.Csv:
			return "csv";
		case ListExportFormat.Json:
			return "json";
		case ListExportFormat.Markdown:
			return "md";
		default:
			return "csv";
	}
}
