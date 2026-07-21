/**
 * Bulk import / export for the DictionaryEditor (B5.8). Pure, DOM-free.
 *
 * Import accepts CSV / TSV / JSON. The delimited forms map a
 * `label,icon,description` column order (a leading header row naming
 * those columns is detected + skipped). JSON accepts either a bare
 * array of `{ label, icon?, description?, colour? }` or a full
 * `{ items: [...] }` envelope. Parsed rows are returned for review
 * before commit — the caller mints ids + sortIndex.
 */

import type { DictionaryItem } from "@brainstorm-os/sdk-types";

export enum ImportFormat {
	Csv = "csv",
	Tsv = "tsv",
	Json = "json",
}

export type ParsedRow = {
	label: string;
	icon: string | null;
	description?: string;
	colour?: string;
};

export type ImportResult =
	| { ok: true; rows: ParsedRow[]; truncated: boolean }
	| { ok: false; error: string };

/** Hard cap on parsed import rows. Pasting an unbounded CSV/JSON into
 *  the import box would freeze the main thread (the commit loop is
 *  O(rows) and each `addItem`/`patchItem` copies the dictionary). The
 *  overflow is reported, never silently dropped. */
export const MAX_IMPORT_ROWS = 5000;

/** The single hex-colour validator. Re-used by `chipColours` so the
 *  import gate is not the only thing standing between an untrusted
 *  colour string and `color-mix(...)` interpolation. */
export const HEX = /^#[0-9a-f]{6}$/i;

export function detectFormat(raw: string): ImportFormat {
	const trimmed = raw.trim();
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) return ImportFormat.Json;
	const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
	if (firstLine.includes("\t")) return ImportFormat.Tsv;
	return ImportFormat.Csv;
}

export function parseImport(raw: string, format = detectFormat(raw)): ImportResult {
	const text = raw.trim();
	if (text.length === 0) return { ok: false, error: "empty input" };
	if (format === ImportFormat.Json) return parseJson(text);
	return parseDelimited(text, format === ImportFormat.Tsv ? "\t" : ",");
}

function parseJson(text: string): ImportResult {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return { ok: false, error: "invalid JSON" };
	}
	const arr = Array.isArray(data)
		? data
		: data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)
			? (data as { items: unknown[] }).items
			: null;
	if (!arr) return { ok: false, error: "expected an array or { items: [...] }" };
	const rows: ParsedRow[] = [];
	for (const entry of arr) {
		if (!entry || typeof entry !== "object") continue;
		const obj = entry as Record<string, unknown>;
		const label = typeof obj.label === "string" ? obj.label.trim() : "";
		if (label.length === 0) continue;
		rows.push(buildRow(label, obj.icon, obj.description, obj.colour));
	}
	return finalize(rows);
}

function finalize(rows: ParsedRow[]): ImportResult {
	if (rows.length === 0) return { ok: false, error: "no rows with a label" };
	if (rows.length > MAX_IMPORT_ROWS) {
		return { ok: true, rows: rows.slice(0, MAX_IMPORT_ROWS), truncated: true };
	}
	return { ok: true, rows, truncated: false };
}

function parseDelimited(text: string, delim: string): ImportResult {
	const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
	if (lines.length === 0) return { ok: false, error: "no rows" };
	const cells = (line: string): string[] =>
		line.split(delim).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
	let start = 0;
	const head = cells(lines[0] ?? "").map((c) => c.toLowerCase());
	if (head[0] === "label") start = 1;
	const rows: ParsedRow[] = [];
	for (let i = start; i < lines.length; i++) {
		const c = cells(lines[i] ?? "");
		const label = (c[0] ?? "").trim();
		if (label.length === 0) continue;
		rows.push(buildRow(label, c[1], c[2], c[3]));
	}
	return finalize(rows);
}

function buildRow(label: string, icon: unknown, description: unknown, colour: unknown): ParsedRow {
	const row: ParsedRow = {
		label,
		icon: typeof icon === "string" && icon.trim().length > 0 ? icon.trim() : null,
	};
	if (typeof description === "string" && description.trim().length > 0) {
		row.description = description.trim();
	}
	if (typeof colour === "string" && HEX.test(colour.trim())) {
		row.colour = colour.trim().toLowerCase();
	}
	return row;
}

/** Serialise the dictionary's items to a JSON string for clipboard
 *  export (label + icon + description + colour, archived flag dropped). */
export function exportJson(items: readonly DictionaryItem[]): string {
	return JSON.stringify(
		items.map((it) => ({
			label: it.label,
			icon: it.icon,
			...(it.description !== undefined ? { description: it.description } : {}),
			...(it.colour !== undefined ? { colour: it.colour } : {}),
		})),
		null,
		2,
	);
}
