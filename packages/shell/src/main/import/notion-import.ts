/**
 * IE-6 — Notion workspace migration importer (export-zip path; core).
 *
 * The "page-database migration" handler (doc 45 §ownership map) and the switch-in
 * keystone. Parses the official Notion `Export → Markdown & CSV` output (the
 * zero-credential, offline path): a folder tree of one `.md` per page, `.csv`
 * files for databases, and attachment files. Like the IE-5 Obsidian core this is
 * pure + transport-injected — it takes the already-extracted file list (the
 * wizard owns the zip read + its path-traversal / size guards, mirroring the
 * Obsidian folder walk) and produces a {@link NotionImportPlan}: entity drafts
 * (page properties + body), the page-tree parent relations Notion encodes as
 * sibling folders, and the resolved internal-link graph. The vault binding
 * ({@link importNotionExport}) walks that plan through the same privileged
 * create + link path the seeder / bundle restore / Obsidian importer use.
 *
 * Database `.csv` files become rows tagged with their source database. The IE-2
 * **Map tail** now lands here: each database mints a typed `List/v1` Collection
 * (manual membership of its rows) and registers its columns as vault PropertyDefs
 * (column → {@link inferValueType}), so an imported Notion database arrives as a
 * first-class, typed, queryable collection rather than a loose pile of rows.
 * Callout / toggle / column block conversion remains a later refinement: Notion's
 * *markdown* export already flattens those to plain markdown (so nothing is lost),
 * and richer fidelity is tied to the HTML-export path + the editor block dialect.
 */

import { LIST_ENTITY_TYPE, listToEntityProperties } from "@brainstorm/sdk";
import type { List, MemberInclude, PropertyDef } from "@brainstorm/sdk-types";
import { ulid } from "ulid";
import { AssetKind } from "../assets/asset-types";
import { servedMimeForName } from "../files/upload-mime";
import { EntitiesRepository } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";
import type { ApplyDocUpdate } from "../welcome/seed-deps";
import { inferValueType } from "./import-map";
import { parseTable } from "./import-parse";
import { IMPORT_EXTERNAL_ID_PROP, ImportFormat } from "./import-types";
import { bodyMarkdownFromProperties, plantImportMarkdownBody } from "./plant-import-body";

/** One extracted text file from the Notion export (`.md`, `.csv`, or `.html`).
 *  `path` is export-relative (e.g. `Workspace/Tasks abc123.../Do it def456....md`). */
export type NotionFile = {
	readonly path: string;
	readonly text: string;
};

/** A non-text attachment (image / pdf / …) referenced by a page — `bytes` are
 *  sealed into the AssetStore and surfaced as a `File/v1` entity on import. */
export type NotionAttachment = {
	readonly path: string;
	readonly bytes: Uint8Array;
};

export enum NotionLinkKind {
	/** A markdown link from one page to another. */
	Reference = "reference",
	/** A page nested under another via Notion's sibling-folder convention. */
	Parent = "parent",
}

export type NotionEntityDraft = {
	readonly title: string;
	/** Page properties (database column values / parsed property block) + `body`. */
	readonly properties: Record<string, unknown>;
	/** Source database display name when this row came from a `.csv`, else null. */
	readonly database: string | null;
	/** Stable source key for idempotent re-import (the export-relative path,
	 *  or `<csv-path>#<row-key>` for a database row). */
	readonly externalId: string;
};

export type NotionLinkSpec = {
	readonly from: string;
	readonly to: string;
	readonly kind: NotionLinkKind;
};

export type NotionAttachmentLink = {
	readonly fromPage: string;
	readonly attachmentPath: string;
};

export type NotionImportPlan = {
	readonly entities: readonly NotionEntityDraft[];
	/** Parent + reference links whose endpoints both exist in the page set. */
	readonly links: readonly NotionLinkSpec[];
	readonly attachmentLinks: readonly NotionAttachmentLink[];
	readonly referencedAttachments: readonly string[];
	/** Markdown links to a `.md`/`.csv` target that isn't in the export. */
	readonly unresolved: ReadonlyArray<{ readonly from: string; readonly target: string }>;
};

export const NOTION_LINK_TYPE = "brainstorm/notion/links-to";
export const NOTION_PARENT_TYPE = "brainstorm/notion/child-of";
export const FILE_TYPE = "brainstorm/File/v1";

const MARKDOWN_EXT = /\.md$/i;
const CSV_EXT = /\.csv$/i;
/** Notion appends ` <32 hex>` (a dashless uuid) to every page/db name. */
const NOTION_ID_SUFFIX = /\s+[0-9a-f]{32}$/i;
/** Markdown inline link: `[label](target)` — target captured for resolution. */
const MD_LINK_RE = /\[(?:[^\]]*)\]\(([^)]+)\)/g;

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx < 0 ? "" : path.slice(0, idx);
}

/** Strip Notion's ` <32hex>` id suffix and the file extension from a name.
 *  `Tasks abc…def.md` → `Tasks`; `Roadmap abc…def_all.csv` → `Roadmap`. */
export function stripNotionId(name: string): string {
	let stem = basename(name).replace(MARKDOWN_EXT, "").replace(CSV_EXT, "");
	// Notion's "_all" CSV variant carries the unfiltered view; same database.
	if (stem.endsWith("_all")) stem = stem.slice(0, -"_all".length);
	return stem.replace(NOTION_ID_SUFFIX, "").trim();
}

/** Resolve a relative export URL against the linking page's directory, folding
 *  `.`/`..` and URL-decoding, into an export-relative path. Returns null for an
 *  absolute / external URL (`http:`, `mailto:`, `/abs`, anchors). */
export function resolveNotionPath(baseDir: string, rawUrl: string): string | null {
	let url = rawUrl.trim();
	const hash = url.indexOf("#");
	if (hash >= 0) url = url.slice(0, hash);
	const query = url.indexOf("?");
	if (query >= 0) url = url.slice(0, query);
	if (url.length === 0) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/")) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(url);
	} catch {
		decoded = url;
	}
	const segments = baseDir.length > 0 ? baseDir.split("/") : [];
	for (const segment of decoded.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length > 0) segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.join("/");
}

/** Parse a Notion-exported markdown page: the leading `# H1` is the title, an
 *  immediately-following contiguous block of `Key: value` lines is the database
 *  property block (Notion emits one for database pages), and everything after is
 *  the body. A page with no property block keeps its whole content as `body`. */
export function parseNotionPage(
	text: string,
	fallbackTitle: string,
): { title: string; properties: Record<string, unknown>; body: string } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let cursor = 0;
	let title = fallbackTitle;
	// Skip leading blanks, then a single H1 heading → title.
	while (cursor < lines.length && (lines[cursor] ?? "").trim() === "") cursor++;
	const h1 = /^#\s+(.+?)\s*$/.exec(lines[cursor] ?? "");
	if (h1?.[1]) {
		title = h1[1];
		cursor++;
	}
	while (cursor < lines.length && (lines[cursor] ?? "").trim() === "") cursor++;
	// A contiguous `Key: value` run with no blank line is the property block.
	const properties: Record<string, unknown> = {};
	let sawProperty = false;
	const propStart = cursor;
	while (cursor < lines.length) {
		const line = lines[cursor] ?? "";
		if (line.trim() === "") break;
		const prop = /^([^:\n]{1,80}):\s+(.*)$/.exec(line);
		if (!prop?.[1]) break;
		properties[prop[1].trim()] = (prop[2] ?? "").trim();
		sawProperty = true;
		cursor++;
	}
	if (!sawProperty) cursor = propStart;
	const body = lines.slice(cursor).join("\n").trim();
	return { title, properties, body };
}

/** Prefer the `_all.csv` (unfiltered) variant when both it and the plain export
 *  of the same database are present, so a database imports once. */
function dedupeCsvFiles(csvFiles: readonly NotionFile[]): NotionFile[] {
	const byDatabase = new Map<string, NotionFile>();
	for (const file of csvFiles) {
		const key = `${dirname(file.path)}::${stripNotionId(file.path).toLowerCase()}`;
		const existing = byDatabase.get(key);
		if (!existing || basename(file.path).toLowerCase().includes("_all")) {
			byDatabase.set(key, file);
		}
	}
	return [...byDatabase.values()];
}

/** Parse a Notion export (already-extracted text files) into entity drafts + a
 *  resolved link graph. Pure — no vault, no filesystem. */
export function parseNotionExport(
	files: readonly NotionFile[],
	attachmentPaths: readonly string[] = [],
): NotionImportPlan {
	const mdFiles = files.filter((f) => MARKDOWN_EXT.test(f.path));
	const csvFiles = dedupeCsvFiles(files.filter((f) => CSV_EXT.test(f.path)));
	const entities: NotionEntityDraft[] = [];
	const pagePaths = new Set<string>(); // export-relative path of every md page
	const attachmentByPath = new Set(attachmentPaths);

	for (const file of mdFiles) {
		const { title, properties, body } = parseNotionPage(file.text, stripNotionId(file.path));
		const props: Record<string, unknown> = { ...properties };
		if (body.length > 0) props.body = body;
		entities.push({ title, properties: props, database: null, externalId: file.path });
		pagePaths.add(file.path);
	}

	for (const file of csvFiles) {
		const database = stripNotionId(file.path);
		const table = parseTable(ImportFormat.Csv, file.text, database);
		const titleColumn = table.columns[0];
		table.records.forEach((record, index) => {
			const rawTitle = titleColumn ? record.fields[titleColumn] : undefined;
			const title =
				typeof rawTitle === "string" && rawTitle.trim().length > 0
					? rawTitle.trim()
					: `${database} ${index + 1}`;
			// Key on the row POSITION, not the title: two rows sharing a title
			// (common for blank/duplicate names) would otherwise collide on the
			// dedupe key and silently overwrite each other. Notion CSV export row
			// order is stable, so position is a sound idempotency key.
			entities.push({
				title,
				properties: { ...record.fields, notionDatabase: database },
				database,
				externalId: `${file.path}#${index + 1}`,
			});
		});
	}

	const links: NotionLinkSpec[] = [];
	const attachmentLinks: NotionAttachmentLink[] = [];
	const referenced = new Set<string>();
	const unresolved: Array<{ from: string; target: string }> = [];

	for (const file of mdFiles) {
		// Page-tree parent: a child lives inside the parent's sibling folder, so
		// `<dir>.md` (the folder name + .md, a sibling of the folder) is the parent.
		const dir = dirname(file.path);
		if (dir.length > 0) {
			const parentPath = `${dir}.md`;
			if (pagePaths.has(parentPath)) {
				links.push({ from: file.path, to: parentPath, kind: NotionLinkKind.Parent });
			}
		}
		// Internal markdown links → references / attachment refs.
		let match: RegExpExecArray | null = MD_LINK_RE.exec(file.text);
		while (match !== null) {
			const resolved = resolveNotionPath(dir, match[1] ?? "");
			if (resolved) {
				if (pagePaths.has(resolved)) {
					links.push({ from: file.path, to: resolved, kind: NotionLinkKind.Reference });
				} else if (attachmentByPath.has(resolved)) {
					attachmentLinks.push({ fromPage: file.path, attachmentPath: resolved });
					referenced.add(resolved);
				} else if (MARKDOWN_EXT.test(resolved) || CSV_EXT.test(resolved)) {
					unresolved.push({ from: file.path, target: resolved });
				}
			}
			match = MD_LINK_RE.exec(file.text);
		}
	}

	return { entities, links, attachmentLinks, referencedAttachments: [...referenced], unresolved };
}

/** Columns carried on a row draft that are structural, not user data — excluded
 *  from the derived schema (they're the importer's own bookkeeping). */
const NON_SCHEMA_COLUMNS: ReadonlySet<string> = new Set([
	"notionDatabase",
	"body",
	"title",
	IMPORT_EXTERNAL_ID_PROP,
]);

/** A database's derived schema: a stable property key + the PropertyDefs its
 *  columns map to (column name → {@link inferValueType} over the column's
 *  values across every row). The IE-2 Map stage, applied per Notion database. */
export type NotionDatabaseSchema = {
	database: string;
	properties: PropertyDef[];
};

/** Turn a column display name into a stable property key (slug). Two columns
 *  that slug to the same key collapse — the first one's def wins. */
function columnKey(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "field"
	);
}

/** Derive a typed schema per Notion database from the parsed plan's row drafts.
 *  Pure — the vault binding registers the PropertyDefs + mints the Collection.
 *  Preserves first-seen column order; infers each column's ValueType from its
 *  values across all rows of that database. Databases with no extractable
 *  columns yield an empty `properties` (still a valid collection grouping). */
export function deriveDatabaseSchemas(plan: NotionImportPlan): NotionDatabaseSchema[] {
	const rowsByDb = new Map<string, NotionEntityDraft[]>();
	for (const draft of plan.entities) {
		if (draft.database === null) continue;
		const rows = rowsByDb.get(draft.database) ?? [];
		rows.push(draft);
		rowsByDb.set(draft.database, rows);
	}
	const schemas: NotionDatabaseSchema[] = [];
	for (const [database, rows] of rowsByDb) {
		const columns: string[] = [];
		const seen = new Set<string>();
		for (const row of rows) {
			for (const name of Object.keys(row.properties)) {
				if (NON_SCHEMA_COLUMNS.has(name) || seen.has(name)) continue;
				seen.add(name);
				columns.push(name);
			}
		}
		const properties: PropertyDef[] = columns.map((name) => ({
			key: columnKey(name),
			name,
			icon: null,
			valueType: inferValueType(rows.map((r) => r.properties[name])),
		}));
		schemas.push({ database, properties });
	}
	return schemas;
}

/** Stable id for a Notion database's Collection — idempotent so a re-import
 *  updates the same List rather than minting a duplicate. */
export function notionCollectionId(source: string, database: string): string {
	return `notion-list:${source}:${columnKey(database)}`;
}

export type NotionImportOptions = {
	/** Vault entity type the pages + database rows map onto (e.g. `io.brainstorm.notes/Note/v1`). */
	readonly targetType: string;
	/** Stable source id namespacing the dedupe key (e.g. `notion:my-workspace`). */
	readonly source: string;
	readonly now: number;
	readonly importedBy: string;
	/** Streaming controls (doc 45 §Streaming): page-import progress + cancel. */
	readonly onProgress?: (done: number, total: number) => void;
	readonly signal?: AbortSignal;
	/** Plant markdown `body` into each page's universal-body Y.Doc. */
	readonly applyDocUpdate?: ApplyDocUpdate;
};

export type NotionImportReport = {
	readonly created: number;
	readonly updated: number;
	readonly filesCreated: number;
	readonly linked: number;
	readonly unresolved: number;
	/** Typed `List/v1` Collections minted/refreshed — one per Notion database. */
	readonly collectionsCreated: number;
	/** Vault PropertyDefs registered from database columns (IE-2 Map tail). */
	readonly propertiesRegistered: number;
	/** True when an abort cut the page-import short (attachments + links skipped). */
	readonly cancelled?: boolean;
};

/** Yield to the event loop every N pages so progress flushes + a mid-run abort
 *  is observed (the importer runs on the main thread). */
const NOTION_YIELD_EVERY = 50;

/** Commit a parsed Notion export into the vault: idempotent upsert of every page
 *  + database row (keyed on the source path via {@link IMPORT_EXTERNAL_ID_PROP}),
 *  referenced attachments as `File/v1` entities, then the parent + reference link
 *  graph. Re-importing the same export updates rather than duplicates. */
export async function importNotionExport(
	session: VaultSession,
	files: readonly NotionFile[],
	options: NotionImportOptions,
	attachments: readonly NotionAttachment[] = [],
): Promise<NotionImportReport> {
	const plan = parseNotionExport(
		files,
		attachments.map((a) => a.path),
	);
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	const idByPath = new Map<string, string>(); // externalId → vault entity id
	let created = 0;
	let updated = 0;

	const total = plan.entities.length;
	for (let i = 0; i < total; i++) {
		if (options.signal?.aborted) {
			// Cancelled mid-pages: skip attachments + links (they'd reference
			// entities that may not have been created), report what landed.
			return {
				created,
				updated,
				filesCreated: 0,
				linked: 0,
				unresolved: plan.unresolved.length,
				collectionsCreated: 0,
				propertiesRegistered: 0,
				cancelled: true,
			};
		}
		const draft = plan.entities[i] as (typeof plan.entities)[number];
		const externalKey = `${options.source}:${draft.externalId}`;
		const existing = repo.listIdsWithProperty(IMPORT_EXTERNAL_ID_PROP, externalKey)[0] ?? null;
		const properties: Record<string, unknown> = {
			...draft.properties,
			title: draft.title,
			[IMPORT_EXTERNAL_ID_PROP]: externalKey,
		};
		let entityId: string;
		if (existing !== null) {
			repo.update(existing, properties, options.now);
			idByPath.set(draft.externalId, existing);
			entityId = existing;
			updated++;
		} else {
			const id = `ent_${ulid()}`;
			repo.create({
				id,
				type: options.targetType,
				properties,
				createdBy: options.importedBy,
				now: options.now,
				dekId: null,
			});
			idByPath.set(draft.externalId, id);
			entityId = id;
			created++;
		}
		if (options.applyDocUpdate) {
			const md = bodyMarkdownFromProperties(properties);
			if (md) {
				try {
					await plantImportMarkdownBody(entityId, md, options.applyDocUpdate);
				} catch {
					// Non-fatal — row + snippet still land.
				}
			}
		}
		options.onProgress?.(i + 1, total);
		if ((i + 1) % NOTION_YIELD_EVERY === 0) await Promise.resolve();
	}

	const assetStore = await session.assetStore();
	const bytesByPath = new Map(attachments.map((a) => [a.path, a.bytes]));
	const idByAttachment = new Map<string, string>();
	let filesCreated = 0;
	for (const path of plan.referencedAttachments) {
		const bytes = bytesByPath.get(path);
		if (!bytes) continue;
		const name = basename(path);
		const externalKey = `${options.source}:file:${path}`;
		const existing = repo.listIdsWithProperty(IMPORT_EXTERNAL_ID_PROP, externalKey)[0] ?? null;
		const mime = servedMimeForName(name);
		const { assetId } = await assetStore.writeAsset({ bytes, mime, kind: AssetKind.Upload });
		assetStore.markBound(assetId);
		const properties: Record<string, unknown> = {
			name,
			mime,
			size: bytes.length,
			assetId,
			attachment: `brainstorm://asset/${assetId}`,
			[IMPORT_EXTERNAL_ID_PROP]: externalKey,
		};
		if (existing !== null) {
			repo.update(existing, properties, options.now);
			idByAttachment.set(path, existing);
		} else {
			const id = `ent_${ulid()}`;
			repo.create({
				id,
				type: FILE_TYPE,
				properties,
				createdBy: options.importedBy,
				now: options.now,
				dekId: null,
			});
			idByAttachment.set(path, id);
			filesCreated++;
		}
	}

	// Deterministic link ids (kind, source, dest) so a re-import UPSERTs the same
	// row rather than accumulating duplicates, and a repeated link collapses.
	const seen = new Set<string>();
	let linked = 0;
	const writeLink = (sourceId: string, destId: string, kind: NotionLinkKind): void => {
		const id = `ln:${kind}:${sourceId}:${destId}`;
		if (seen.has(id)) return;
		seen.add(id);
		repo.putLink({
			id,
			sourceEntityId: sourceId,
			destEntityId: destId,
			linkType: kind === NotionLinkKind.Parent ? NOTION_PARENT_TYPE : NOTION_LINK_TYPE,
			createdAt: options.now,
		});
		linked++;
	};
	for (const link of plan.links) {
		const sourceId = idByPath.get(link.from);
		const destId = idByPath.get(link.to);
		if (sourceId && destId) writeLink(sourceId, destId, link.kind);
	}
	for (const link of plan.attachmentLinks) {
		const sourceId = idByPath.get(link.fromPage);
		const destId = idByAttachment.get(link.attachmentPath);
		if (sourceId && destId) writeLink(sourceId, destId, NotionLinkKind.Reference);
	}

	// IE-2 Map tail — each Notion database becomes a typed `List/v1` Collection
	// (manual membership of its rows) and registers its columns as vault
	// PropertyDefs. Both are idempotent: the collection on a stable id, the
	// PropertyDefs by key (the catalog overwrites in place). Best-effort — a
	// failure here never invalidates the already-committed rows.
	let collectionsCreated = 0;
	let propertiesRegistered = 0;
	try {
		const schemas = deriveDatabaseSchemas(plan);
		if (schemas.length > 0) {
			const store = await session.propertiesStore();
			// Group row entity ids by database (rows are keyed `<path>#<n>`).
			const rowIdsByDb = new Map<string, string[]>();
			for (const draft of plan.entities) {
				if (draft.database === null) continue;
				const id = idByPath.get(draft.externalId);
				if (!id) continue;
				const ids = rowIdsByDb.get(draft.database) ?? [];
				ids.push(id);
				rowIdsByDb.set(draft.database, ids);
			}
			for (const schema of schemas) {
				for (const def of schema.properties) {
					store.setProperty(def);
					propertiesRegistered++;
				}
				const include: MemberInclude[] = (rowIdsByDb.get(schema.database) ?? []).map((id) => ({
					entityId: id,
					addedAt: options.now,
					by: "user",
				}));
				const collection: List = {
					id: notionCollectionId(options.source, schema.database),
					name: schema.database,
					icon: null,
					description: "",
					source: null,
					members: { include, exclude: [] },
					views: [],
					defaultViewId: null,
					defaultTemplate: null,
					createdAt: options.now,
					updatedAt: options.now,
				};
				const props = listToEntityProperties(collection);
				const existing = repo.listIdsWithProperty(IMPORT_EXTERNAL_ID_PROP, collection.id)[0] ?? null;
				const withMarker = { ...props, [IMPORT_EXTERNAL_ID_PROP]: collection.id };
				if (existing !== null) {
					repo.update(existing, withMarker, options.now);
				} else {
					repo.create({
						id: collection.id,
						type: LIST_ENTITY_TYPE,
						properties: withMarker,
						createdBy: options.importedBy,
						now: options.now,
						dekId: null,
					});
				}
				collectionsCreated++;
			}
		}
	} catch {
		// Schema/collection minting is a refinement over the committed rows;
		// never let it fail the import (the rows + links already landed).
	}

	return {
		created,
		updated,
		filesCreated,
		linked,
		unresolved: plan.unresolved.length,
		collectionsCreated,
		propertiesRegistered,
	};
}
