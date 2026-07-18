/**
 * IE-8 — per-entity export serializers (the inverse of the IE-2/IE-4 parse
 * adapters). Pure, dependency-free functions that turn vault entities into
 * Markdown / CSV / JSON text. These back both the per-entity `export` intent and
 * the Automations `export.*` workflow actions (doc 45 §Supported export formats):
 * the serialization is one shared, tested core so the two surfaces can't drift.
 *
 * Symmetry with import: Markdown export writes the same `--- key: value ---`
 * frontmatter + body that `parseFrontmatter` reads back; CSV export writes the
 * RFC-4180 shape `parseCsvRows` parses; JSON export round-trips through the JSON
 * adapter. The internal `importExternalId` dedupe marker is stripped so an export
 * is clean authored content, not engine bookkeeping.
 */

import { IMPORT_BODY_HASH_PROP, IMPORT_EXTERNAL_ID_PROP } from "../import/import-types";

export enum ExportFormat {
	Json = "json",
	Csv = "csv",
	Markdown = "markdown",
}

/** The minimal entity shape the exporters need (id + type + properties). */
export type ExportEntity = {
	readonly id: string;
	readonly type: string;
	readonly properties: Record<string, unknown>;
};

/** Properties never written to an export (engine bookkeeping, not user content). */
const OMITTED_PROPS = new Set([IMPORT_EXTERNAL_ID_PROP, IMPORT_BODY_HASH_PROP]);
/** The property used as the document body in Markdown export. */
const BODY_PROP = "body";

function isScalar(value: unknown): value is string | number | boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Render a property value as a single export cell/line. Arrays of scalars join
 *  with `; `; everything non-scalar falls back to compact JSON so nothing is
 *  silently dropped. */
export function exportScalar(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (isScalar(value)) return String(value);
	if (Array.isArray(value) && value.every(isScalar)) return value.map(String).join("; ");
	return JSON.stringify(value);
}

function exportableEntries(properties: Record<string, unknown>): [string, unknown][] {
	return Object.entries(properties).filter(([key]) => !OMITTED_PROPS.has(key));
}

/** Quote a CSV cell per RFC 4180 when it contains a comma, quote, or newline. */
function csvCell(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize entities to JSON — the id + type + clean properties of each, as a
 *  single object when given one entity, else an array. */
export function entitiesToJson(entities: readonly ExportEntity[]): string {
	const docs = entities.map((e) => ({
		id: e.id,
		type: e.type,
		properties: Object.fromEntries(exportableEntries(e.properties)),
	}));
	return JSON.stringify(docs.length === 1 ? docs[0] : docs, null, 2);
}

/** Serialize entities to a CSV table. Columns are the union of scalar/array
 *  property keys in first-seen order, with a leading `id` column. */
export function entitiesToCsv(entities: readonly ExportEntity[]): string {
	const columns: string[] = ["id"];
	const seen = new Set(columns);
	for (const entity of entities) {
		for (const [key] of exportableEntries(entity.properties)) {
			if (!seen.has(key)) {
				seen.add(key);
				columns.push(key);
			}
		}
	}
	const header = columns.map(csvCell).join(",");
	const rows = entities.map((entity) =>
		columns
			.map((col) => csvCell(col === "id" ? entity.id : exportScalar(entity.properties[col])))
			.join(","),
	);
	return [header, ...rows].join("\n");
}

/** Serialize one entity to Markdown: scalar properties as a YAML-ish frontmatter
 *  fence, then the `body` property (if any) as the document body. The frontmatter
 *  round-trips through {@link parseFrontmatter}. */
export function entityToMarkdown(entity: ExportEntity): string {
	const lines: string[] = [];
	for (const [key, value] of exportableEntries(entity.properties)) {
		if (key === BODY_PROP) continue;
		lines.push(`${key}: ${exportScalar(value)}`);
	}
	const body = entity.properties[BODY_PROP];
	const bodyText = typeof body === "string" ? body : "";
	const frontmatter = lines.length > 0 ? `---\n${lines.join("\n")}\n---\n` : "";
	return bodyText.length > 0 ? `${frontmatter}${frontmatter ? "\n" : ""}${bodyText}\n` : frontmatter;
}

/** Serialize entities in the chosen format. Markdown joins multiple entities
 *  with a `---`-fenced separator (one document each); JSON/CSV produce one
 *  document over the whole set. */
export function exportEntities(format: ExportFormat, entities: readonly ExportEntity[]): string {
	switch (format) {
		case ExportFormat.Json:
			return entitiesToJson(entities);
		case ExportFormat.Csv:
			return entitiesToCsv(entities);
		case ExportFormat.Markdown:
			return entities.map(entityToMarkdown).join("\n\n");
	}
}

/** File extension for an export format (for the save dialog + Automations sink). */
export function extensionFor(format: ExportFormat): string {
	switch (format) {
		case ExportFormat.Json:
			return "json";
		case ExportFormat.Csv:
			return "csv";
		case ExportFormat.Markdown:
			return "md";
	}
}
