/**
 * IE-7 rung 3 — the Notion **API Source**: a fetched workspace → the same
 * {@link NotionImportPlan} the export-zip path produces.
 *
 * This is the whole point of the IE-2 Source/Parse split: the credentialed API
 * walk lands in the identical IR, so the Map → Project → Dedupe → Write tail
 * (typed `List/v1` per database, PropertyDefs per column, idempotent
 * external-id dedupe, body planting) is reused unchanged — `importNotionExport`
 * writes an API plan exactly as it writes an export plan.
 *
 * Two conversions are genuinely new versus the zip path:
 *  - **property values**: the API returns typed JSON per property kind
 *    (`select.name`, `date.start`, `formula.number`, …) where the export gave
 *    CSV strings. {@link notionPropertyValue} flattens each to the scalar shape
 *    the Map stage's `inferValueType` reads, and returns `null` for an empty or
 *    un-flattenable property so a blank cell stays blank instead of becoming a
 *    guess.
 *  - **bodies**: page content is a block tree, rendered by rung 1's
 *    {@link notionBlocksToMarkdown} into the dialect the planter parses.
 *
 * Robustness posture matches the client's: one page's failed block fetch costs
 * that page's body, not the import; archived pages are skipped; every text
 * value is clamped. Nothing here is credentialed — the transport is injected.
 */

import { notionBlocksToMarkdown } from "./notion-api-blocks";
import {
	type NotionObject,
	type NotionTransport,
	fetchPageBlocks,
	queryDatabaseRows,
	retrieveDatabase,
	searchWorkspace,
} from "./notion-api-client";
import type { NotionEntityDraft, NotionImportPlan } from "./notion-import";

/** Length cap on any single imported text value (the API has no useful bound). */
const MAX_TEXT_LENGTH = 10_000;

/** External-id namespace, so an API-imported row is idempotent across runs and
 *  distinguishable from the same page imported from an export zip. */
const EXTERNAL_ID_PREFIX = "notion:";

/** Which stage the walk is in, for the wizard's progress line. */
export type NotionApiProgressStage = "search" | "databases" | "pages";

export type NotionApiPlanOptions = {
	readonly onProgress?: (stage: NotionApiProgressStage, done: number, total: number) => void;
};

function clamp(text: string): string {
	return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

function plainText(rich: unknown): string {
	if (!Array.isArray(rich)) return "";
	let out = "";
	for (const seg of rich) {
		const text = (seg as { plain_text?: unknown } | null)?.plain_text;
		if (typeof text === "string") out += text;
	}
	return clamp(out);
}

function namesOf(value: unknown, key = "name"): string {
	if (!Array.isArray(value)) return "";
	const names: string[] = [];
	for (const item of value) {
		const name = (item as Record<string, unknown> | null)?.[key];
		if (typeof name === "string" && name.length > 0) names.push(name);
	}
	return clamp(names.join(", "));
}

function emptyToNull(value: string): string | null {
	return value.length > 0 ? value : null;
}

/**
 * Flatten one Notion property value to the scalar the Map stage can type.
 * `null` means "no value" — the caller omits the column for that row, so an
 * empty Notion cell stays an empty vault cell.
 *
 * `relation` deliberately returns null: a relation is a set of page ids, and
 * projecting ids as text would fabricate a value that looks like data. Relations
 * ride the link graph in a later rung, not the property bag.
 */
export function notionPropertyValue(property: unknown): string | number | boolean | null {
	const prop = property as Record<string, unknown> | null | undefined;
	const type = typeof prop?.type === "string" ? prop.type : "";
	if (!prop || !type) return null;
	const raw = prop[type];
	switch (type) {
		case "title":
		case "rich_text":
			return emptyToNull(plainText(raw));
		case "number":
			return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
		case "checkbox":
			return typeof raw === "boolean" ? raw : null;
		case "select":
		case "status": {
			const name = (raw as { name?: unknown } | null)?.name;
			return typeof name === "string" ? emptyToNull(clamp(name)) : null;
		}
		case "multi_select":
			return emptyToNull(namesOf(raw));
		case "date": {
			const start = (raw as { start?: unknown } | null)?.start;
			return typeof start === "string" ? emptyToNull(start) : null;
		}
		case "url":
		case "email":
		case "phone_number":
			return typeof raw === "string" ? emptyToNull(clamp(raw)) : null;
		case "created_time":
		case "last_edited_time":
			return typeof raw === "string" ? emptyToNull(raw) : null;
		case "people":
			return emptyToNull(namesOf(raw));
		case "files":
			return emptyToNull(namesOf(raw));
		case "unique_id": {
			const id = raw as { prefix?: unknown; number?: unknown } | null;
			if (typeof id?.number !== "number") return null;
			return typeof id.prefix === "string" && id.prefix.length > 0
				? `${id.prefix}-${id.number}`
				: id.number;
		}
		case "formula":
		case "rollup":
			// Both wrap a COMPUTED value whose own `type` names a primitive
			// (`string`/`number`/`boolean`/`date`) rather than a property kind.
			return computedValue(raw);
		default:
			return null;
	}
}

/** The value inside a `formula` / `rollup` wrapper: its `type` names a
 *  primitive, not a property kind. A rollup `array` flattens to its members'
 *  values (comma-joined) — the same shape a `multi_select` lands as. */
function computedValue(raw: unknown): string | number | boolean | null {
	const inner = raw as Record<string, unknown> | null;
	switch (typeof inner?.type === "string" ? inner.type : "") {
		case "string":
			return typeof inner?.string === "string" ? emptyToNull(clamp(inner.string)) : null;
		case "number":
			return typeof inner?.number === "number" && Number.isFinite(inner.number) ? inner.number : null;
		case "boolean":
			return typeof inner?.boolean === "boolean" ? inner.boolean : null;
		case "date": {
			const start = (inner?.date as { start?: unknown } | null)?.start;
			return typeof start === "string" ? emptyToNull(start) : null;
		}
		case "array": {
			const parts: string[] = [];
			for (const item of Array.isArray(inner?.array) ? inner.array : []) {
				const value = notionPropertyValue(item) ?? computedValue(item);
				if (value !== null) parts.push(String(value));
			}
			return emptyToNull(clamp(parts.join(", ")));
		}
		default:
			return null;
	}
}

/** A page's title: its `title`-typed property (whatever the user named that
 *  column), else a database object's own `title`, else "Untitled". */
export function notionPageTitle(object: NotionObject): string {
	for (const property of Object.values(object.properties ?? {})) {
		const prop = property as Record<string, unknown> | null;
		if (prop?.type === "title") {
			const text = plainText(prop.title);
			if (text.length > 0) return text;
		}
	}
	const own = plainText(object.title);
	return own.length > 0 ? own : "Untitled";
}

/** Every non-title property of a page, flattened. The title rides `title`, so
 *  it is emitted under its own column name too (the export path does the same —
 *  a database's title column is a real column). */
function propertiesOf(object: NotionObject): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, property] of Object.entries(object.properties ?? {})) {
		const value = notionPropertyValue(property);
		if (value !== null) out[name] = value;
	}
	return out;
}

function isDatabase(object: NotionObject): boolean {
	return object.object === "database";
}

function isDatabaseRow(object: NotionObject): boolean {
	return object.parent?.type === "database_id";
}

/**
 * Walk an authorized Notion workspace and build the import plan: one draft per
 * database row (tagged with its database's name, so the Map tail mints the
 * typed Collection) and one per standalone page (body rendered from its blocks).
 *
 * Rows are fetched per database rather than taken from `search`, because search
 * results carry properties but not a stable per-database ordering — and a
 * database the user shared but whose rows they didn't should still fail closed
 * at the API, not here.
 */
export async function planNotionApiImport(
	transport: NotionTransport,
	options: NotionApiPlanOptions = {},
): Promise<NotionImportPlan> {
	const progress = options.onProgress ?? (() => undefined);
	progress("search", 0, 0);
	const found = await searchWorkspace(transport);
	const live = found.filter((object) => object.archived !== true);

	const databases = live.filter(isDatabase);
	const entities: NotionEntityDraft[] = [];
	const seen = new Set<string>();

	let doneDatabases = 0;
	for (const database of databases) {
		progress("databases", doneDatabases, databases.length);
		doneDatabases += 1;
		let name = notionPageTitle(database);
		try {
			name = notionPageTitle(await retrieveDatabase(transport, database.id));
		} catch {
			// Schema fetch is a nicety — the rows carry their own property names.
		}
		let rows: NotionObject[] = [];
		try {
			rows = await queryDatabaseRows(transport, database.id);
		} catch {
			continue; // One unreadable database doesn't sink the import.
		}
		for (const row of rows) {
			if (row.archived === true || seen.has(row.id)) continue;
			seen.add(row.id);
			entities.push({
				title: notionPageTitle(row),
				properties: propertiesOf(row),
				database: name,
				externalId: `${EXTERNAL_ID_PREFIX}${row.id}`,
			});
		}
	}
	progress("databases", databases.length, databases.length);

	// Standalone pages: everything that isn't a database and isn't a row of one
	// (rows were already taken, with their database's name attached).
	const pages = live.filter((object) => !isDatabase(object) && !isDatabaseRow(object));
	let donePages = 0;
	for (const page of pages) {
		progress("pages", donePages, pages.length);
		donePages += 1;
		if (seen.has(page.id)) continue;
		seen.add(page.id);
		const properties = propertiesOf(page);
		try {
			const body = notionBlocksToMarkdown(await fetchPageBlocks(transport, page.id));
			if (body.length > 0) properties.body = body;
		} catch {
			// A page with no body still belongs in the vault.
		}
		entities.push({
			title: notionPageTitle(page),
			properties,
			database: null,
			externalId: `${EXTERNAL_ID_PREFIX}${page.id}`,
		});
	}
	progress("pages", pages.length, pages.length);

	// Links + attachments ride later rungs: page mentions need the block-level
	// mention walk, and attachments need byte fetches through the egress broker.
	// Emitting nothing is honest — `unresolved` stays empty rather than listing
	// links this Source never looked for.
	return {
		entities,
		links: [],
		attachmentLinks: [],
		referencedAttachments: [],
		unresolved: [],
	};
}
