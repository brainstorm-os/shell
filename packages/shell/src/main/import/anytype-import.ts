/**
 * IE-7 — Anytype space migration importer (JSON-export path; core).
 *
 * Parses the official Anytype `Export → Any-Block (JSON)` output (the
 * zero-credential, offline path): one `<objectId>.pb.json` protobuf-JSON
 * snapshot per object plus a `files/` directory of attachment binaries. Like
 * the IE-5/IE-6 cores this is pure + transport-injected — it takes the
 * already-extracted entries (the wizard owns the zip read + its guards) and
 * produces an {@link AnytypeImportPlan}: entity drafts (details → properties,
 * block tree → markdown body), the object-link graph (link blocks + inline
 * mentions), file references, and Collection membership. The vault binding
 * ({@link importAnytypeExport}) walks that plan through the same privileged
 * create + link path the Notion / Obsidian importers use.
 *
 * The export's schema objects are consumed, not imported: `STType` snapshots
 * name each object's type (carried as `anytypeType`), `STRelation` snapshots
 * name custom relation keys, and `STRelationOption` snapshots resolve
 * tag/select option ids to their labels. Per-type PropertyDefs are derived
 * from the drafts (IE-2 Map tail, column → {@link inferValueType}), and each
 * Anytype Collection mints a typed `List/v1` of its imported members. Sets
 * (live queries) have no member list in the export and are imported as plain
 * pages; dataview fidelity is a later refinement.
 */

import { LIST_ENTITY_TYPE, listToEntityProperties } from "@brainstorm/sdk";
import {
	CARDINALITY_HARD_MAX,
	type List,
	type MemberInclude,
	type PropertyDef,
} from "@brainstorm/sdk-types";
import { ulid } from "ulid";
import { AssetKind } from "../assets/asset-types";
import { servedMimeForName } from "../files/upload-mime";
import { EntitiesRepository } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";
import type { ApplyDocUpdate } from "../welcome/seed-deps";
import { anytypeBlocksToLexical, anytypeDateToMs } from "./anytype-blocks-to-lexical";
import { inferValueType } from "./import-map";
import { IMPORT_EXTERNAL_ID_PROP } from "./import-types";
import { type ImportedBodyState, plantImportSerializedBody } from "./plant-import-body";

/** Deep-clone a Lexical state, rewriting `image.src` values that match a
 *  known file name to their AssetStore URL. Returns null when nothing changed. */
function rewriteImageSrcs(
	state: ImportedBodyState,
	srcByName: ReadonlyMap<string, string>,
): ImportedBodyState | null {
	if (srcByName.size === 0) return null;
	let changed = false;
	const walk = (node: Record<string, unknown>): Record<string, unknown> => {
		const next: Record<string, unknown> = { ...node };
		if (next.type === "image" && typeof next.src === "string") {
			const mapped =
				srcByName.get(next.src) ?? srcByName.get(next.src.slice(next.src.lastIndexOf("/") + 1));
			if (mapped && mapped !== next.src) {
				next.src = mapped;
				changed = true;
			}
		}
		if (Array.isArray(next.children)) {
			next.children = (next.children as Record<string, unknown>[]).map(walk);
		}
		return next;
	};
	const root = walk(state.root as unknown as Record<string, unknown>);
	return changed ? ({ ...state, root } as unknown as ImportedBodyState) : null;
}

/** One extracted `.pb.json` snapshot from the Anytype export. `path` is
 *  export-relative; `text` is the raw JSON. */
export type AnytypeFile = {
	readonly path: string;
	readonly text: string;
};

/** A binary from the export's `files/` directory — sealed into the AssetStore
 *  and surfaced as a `File/v1` entity when a page references it. */
export type AnytypeAttachment = {
	readonly path: string;
	readonly bytes: Uint8Array;
};

export type AnytypeEntityDraft = {
	readonly title: string;
	/** Resolved details (relation key → value) + `body` snippet when present. */
	readonly properties: Record<string, unknown>;
	/** Resolved display name of the object's Anytype type (e.g. "Task"). */
	readonly anytypeType: string | null;
	/** The Anytype object id — stable key for idempotent re-import. */
	readonly externalId: string;
	/** Lexical editor state built from Anytype blocks — planted into the
	 *  universal-body Y.Doc so Notes opens with real structure (not markdown). */
	readonly bodyState: ImportedBodyState | null;
};

export type AnytypeLinkSpec = {
	readonly from: string;
	readonly to: string;
};

export type AnytypeFileLink = {
	readonly fromObject: string;
	/** The referenced file *object* id (resolved to a binary at commit). */
	readonly fileObjectId: string;
};

/** An Anytype Collection: explicit membership, minted as a `List/v1`. */
export type AnytypeCollectionDraft = {
	readonly id: string;
	readonly name: string;
	readonly memberIds: readonly string[];
};

export type AnytypeImportPlan = {
	readonly entities: readonly AnytypeEntityDraft[];
	/** Link-block + mention edges whose endpoints both exist in the object set. */
	readonly links: readonly AnytypeLinkSpec[];
	readonly fileLinks: readonly AnytypeFileLink[];
	/** File object id → export-relative binary path (`files/<name>`). */
	readonly fileBinaryByObject: ReadonlyMap<string, string>;
	readonly collections: readonly AnytypeCollectionDraft[];
	/** Link/mention targets not present in the export (dangling edges). */
	readonly unresolved: ReadonlyArray<{ readonly from: string; readonly target: string }>;
	/** Objects skipped as archived or deleted. */
	readonly skippedArchived: number;
	/** Space-chrome objects (dashboard, profile, templates…) skipped. */
	readonly skippedSystem: number;
	/** References to file objects whose binary isn't in the export (Anytype's
	 *  protobuf/JSON export can omit files) — reported, never fatal. */
	readonly filesMissingBinary: number;
};

export const ANYTYPE_LINK_TYPE = "brainstorm/anytype/links-to";
export const FILE_TYPE = "brainstorm/File/v1";

const JSON_EXT = /\.(pb\.json|json)$/i;

/** Snapshot kinds that are schema/system, never imported as entities. The
 *  export names them via the protobuf `SmartBlockType` enum's JSON form. */
const SYSTEM_SB_TYPES: ReadonlySet<string> = new Set([
	"STRelation",
	"STType",
	"STRelationOption",
	"SubObject",
	"Template",
	"Workspace",
	"Widget",
	"SpaceView",
	"Participant",
	"ProfilePage",
	"Archive",
	"Home",
	"AccountOld",
	"MissingObject",
]);

/** Object types that are space chrome, not user content — skipped. */
const SYSTEM_OBJECT_TYPES: ReadonlySet<string> = new Set([
	"ot-dashboard",
	"ot-space",
	"ot-spaceView",
	"ot-participant",
	"ot-profile",
	"ot-template",
]);

/** File-bearing snapshot kinds — consumed as the attachment index. */
const FILE_SB_TYPES: ReadonlySet<string> = new Set(["FileObject", "File"]);

/** Detail keys that are Anytype-internal bookkeeping, not user data. */
const SYSTEM_DETAIL_KEYS: ReadonlySet<string> = new Set([
	"id",
	"type",
	"layout",
	"layoutAlign",
	"isArchived",
	"isDeleted",
	"isHidden",
	"isHiddenDiscovery",
	"isFavorite",
	"isReadonly",
	"iconImage",
	"iconOption",
	"coverId",
	"coverType",
	"coverX",
	"coverY",
	"coverScale",
	"featuredRelations",
	"links",
	"backlinks",
	"mentions",
	"workspaceId",
	"spaceId",
	"identity",
	"lastUsedDate",
	"lastOpenedDate",
	"lastModifiedBy",
	/** Extracted into `createdAt` / `updatedAt` (ms) — not generic properties. */
	"createdDate",
	"lastModifiedDate",
	"addedDate",
	"creator",
	"restrictions",
	"internalFlags",
	"snippet",
	"sizeInBytes",
	"fileMimeType",
	"fileExt",
	"fileId",
	"fileIndexingStatus",
	"fileBackupStatus",
	"fileSyncStatus",
	"revision",
	"resolvedLayout",
	"origin",
	"sourceFilePath",
	"oldAnytypeID",
	"uniqueKey",
	"relationKey",
	"relationFormat",
	"spaceDashboardId",
	"chatId",
	"syncDate",
	"syncStatus",
	"syncError",
	"importType",
	"apiObjectKey",
	"createdInContext",
	"createdInContextRef",
	"pluralName",
	"iconName",
	"migrationObjectContext",
	"autoWidgetTargets",
	"globalName",
	"homepage",
	"identityProfileLink",
	"participantPermissions",
	"participantStatus",
	"spaceType",
	"spaceUxType",
	"templateIsBundled",
]);

/** Anytype system relation → Brainstorm canonical property. Values matched
 *  here land under the vault's own keys (the ones apps read), never under the
 *  relation's display name — `description` stays `description`, `iconEmoji`
 *  becomes the entity `icon`, `tag` feeds the cross-app `tags` array, a
 *  bookmark's `source` becomes `url`. createdDate/lastModifiedDate are
 *  handled separately (entity `createdAt`/`updatedAt`). */
const SYSTEM_PROPERTY_MAP: Readonly<Record<string, string>> = {
	description: "description",
	iconEmoji: "icon",
	tag: "tags",
	source: "url",
	done: "done",
};

/** Block ids Anytype reserves for chrome (title/description live in details). */
const CHROME_BLOCK_IDS: ReadonlySet<string> = new Set([
	"header",
	"title",
	"description",
	"featuredRelations",
]);

type Snapshot = {
	readonly sbType: string;
	readonly id: string;
	/** `data.key` — on STType snapshots, the type key ("page" → `ot-page`). */
	readonly key: string | null;
	readonly details: Record<string, unknown>;
	readonly objectTypes: readonly string[];
	readonly blocks: readonly Record<string, unknown>[];
	readonly collectionMembers: readonly string[] | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Parse one export entry into a normalized snapshot. Null for corrupt JSON or
 *  a shape that carries no snapshot (defensive — a bad file is skipped, never
 *  fatal). The object id prefers `details.id` and falls back to the filename
 *  stem (exports name each file after its object id). */
function parseSnapshot(file: AnytypeFile): Snapshot | null {
	let root: Record<string, unknown> | null;
	try {
		root = asRecord(JSON.parse(file.text));
	} catch {
		return null;
	}
	if (!root) return null;
	const snapshot = asRecord(root.snapshot);
	const data = snapshot ? asRecord(snapshot.data) : null;
	if (!data) return null;
	const details = asRecord(data.details) ?? {};
	const stem = file.path.slice(file.path.lastIndexOf("/") + 1).replace(JSON_EXT, "");
	const id = asString(details.id) ?? stem;
	// Collection membership: `data.collections.objects` (current exports) with
	// `data.store.objects` accepted as the older spelling.
	const collections = asRecord(data.collections) ?? asRecord(data.store);
	const memberIds = collections ? stringArray(collections.objects) : null;
	return {
		sbType: asString(root.sbType) ?? "Page",
		id,
		key: asString(data.key),
		details,
		objectTypes: stringArray(data.objectTypes),
		blocks: Array.isArray(data.blocks)
			? data.blocks.map((b) => asRecord(b)).filter((b): b is Record<string, unknown> => b !== null)
			: [],
		collectionMembers: memberIds && memberIds.length > 0 ? memberIds : null,
	};
}

/** Anytype's protobuf `RelationFormat` — the JSON export may carry the enum
 *  as its number or its name. Normalized to the names this importer acts on;
 *  formats it doesn't convert (status/tag resolve through options anyway)
 *  return null. */
function normalizeRelationFormat(value: unknown): string | null {
	if (value === 4 || value === "date") return "date";
	if (value === 6 || value === "checkbox") return "checkbox";
	if (value === 100 || value === "object") return "object";
	if (value === 5 || value === "file") return "file";
	return null;
}

/** The export's binary-filename slug: lowercase, runs of anything outside
 *  [a-z0-9_] collapse to a single dash, edge dashes trimmed. */
function slugStem(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** "ot-page" → "Page" — display fallback when the type object isn't present. */
function prettifyTypeKey(key: string): string {
	const stem = key.replace(/^ot-/, "").replace(/[-_]+/g, " ").trim();
	return stem.length > 0 ? stem.charAt(0).toUpperCase() + stem.slice(1) : key;
}

type Mark = {
	readonly from: number;
	readonly to: number;
	readonly type: string;
	readonly param: string;
};

function parseMarks(text: Record<string, unknown>): Mark[] {
	const wrapper = asRecord(text.marks);
	const raw = wrapper && Array.isArray(wrapper.marks) ? wrapper.marks : [];
	const marks: Mark[] = [];
	for (const entry of raw) {
		const mark = asRecord(entry);
		if (!mark) continue;
		const range = asRecord(mark.range);
		const from = typeof range?.from === "number" ? range.from : 0;
		const to = typeof range?.to === "number" ? range.to : 0;
		const type = asString(mark.type);
		if (!type || to <= from) continue;
		marks.push({ from, to, type, param: asString(mark.param) ?? "" });
	}
	return marks;
}

const MARK_WRAPPERS: Readonly<Record<string, string>> = {
	Bold: "**",
	Italic: "_",
	Strikethrough: "~~",
	Keyboard: "`",
};

/** Render one text run to markdown, applying non-overlapping inline marks
 *  (overlapping ranges keep the first; styling is a refinement, never data
 *  loss — the raw text always survives). Mention/Object marks contribute
 *  link-graph edges via `onMention` and render as plain text. */
export function renderTextRun(
	text: string,
	marks: readonly Mark[],
	onMention: (target: string) => void,
): string {
	const applicable = [...marks]
		.filter((m) => m.from >= 0 && m.to <= text.length)
		.sort((a, b) => a.from - b.from || b.to - a.to);
	let out = "";
	let cursor = 0;
	for (const mark of applicable) {
		if (mark.type === "Mention" || mark.type === "Object") {
			if (mark.param.length > 0) onMention(mark.param);
			continue;
		}
		if (mark.from < cursor) continue; // overlap — first one won
		const wrapper = MARK_WRAPPERS[mark.type];
		const isLink = mark.type === "Link" && mark.param.length > 0;
		if (!wrapper && !isLink) continue;
		const run = text.slice(mark.from, mark.to);
		out += text.slice(cursor, mark.from);
		out += isLink ? `[${run}](${mark.param})` : `${wrapper}${run}${wrapper}`;
		cursor = mark.to;
	}
	return out + text.slice(cursor);
}

type BlockContext = {
	readonly byId: ReadonlyMap<string, Record<string, unknown>>;
	readonly lines: string[];
	readonly onMention: (target: string) => void;
	readonly onLinkBlock: (target: string) => void;
	readonly onFileBlock: (fileObjectId: string, name: string | null, image: boolean) => void;
	/** Numbered-list counters keyed by depth. */
	readonly counters: Map<number, number>;
	readonly visited: Set<string>;
};

const HEADER_STYLES: Readonly<Record<string, string>> = {
	Header1: "# ",
	Header2: "## ",
	Header3: "### ",
	Header4: "#### ",
};

/** Render one block (and its children) into markdown lines. Depth indents
 *  nested list items; unknown block kinds degrade to their text or nothing. */
function renderBlock(id: string, depth: number, ctx: BlockContext): void {
	if (ctx.visited.has(id) || CHROME_BLOCK_IDS.has(id)) return;
	ctx.visited.add(id);
	const block = ctx.byId.get(id);
	if (!block) return;
	const indent = "  ".repeat(Math.max(0, depth));
	let childDepth = depth;

	const text = asRecord(block.text);
	const file = asRecord(block.file);
	const link = asRecord(block.link);
	const bookmark = asRecord(block.bookmark);
	if (asRecord(block.div)) {
		ctx.lines.push("---");
	} else if (text) {
		const style = asString(text.style) ?? "Paragraph";
		const raw = typeof text.text === "string" ? text.text : "";
		const rendered = renderTextRun(raw, parseMarks(text), ctx.onMention);
		const header = HEADER_STYLES[style];
		if (header) {
			ctx.lines.push(`${header}${rendered}`);
		} else if (style === "Marked" || style === "Toggle") {
			ctx.lines.push(`${indent}- ${rendered}`);
			childDepth = depth + 1;
		} else if (style === "Numbered") {
			const n = (ctx.counters.get(depth) ?? 0) + 1;
			ctx.counters.set(depth, n);
			ctx.lines.push(`${indent}${n}. ${rendered}`);
			childDepth = depth + 1;
		} else if (style === "Checkbox") {
			ctx.lines.push(`${indent}- [${text.checked === true ? "x" : " "}] ${rendered}`);
			childDepth = depth + 1;
		} else if (style === "Quote" || style === "Callout") {
			ctx.lines.push(`> ${rendered}`);
		} else if (style === "Code") {
			ctx.lines.push("```", raw, "```");
		} else if (rendered.length > 0 || style === "Paragraph") {
			if (rendered.length > 0) ctx.lines.push(`${indent}${rendered}`);
		}
		if (style !== "Numbered") ctx.counters.delete(depth);
	} else if (file) {
		const target = asString(file.targetObjectId) ?? asString(file.hash);
		const name = asString(file.name);
		// Keep a trace of the attachment in the body (Notion parity: the link
		// may be dead until the asset lands, but the reference survives).
		if (name) {
			const targetRef = /\s/.test(name) ? `<${name}>` : name;
			ctx.lines.push(`${file.type === "Image" ? "!" : ""}[${name}](${targetRef})`);
		}
		if (target) ctx.onFileBlock(target, name, file.type === "Image");
	} else if (link) {
		const target = asString(link.targetBlockId);
		if (target) ctx.onLinkBlock(target);
	} else if (bookmark) {
		const url = asString(bookmark.url);
		if (url) ctx.lines.push(`[${asString(bookmark.title) ?? url}](${url})`);
	}

	for (const child of stringArray(block.childrenIds)) renderBlock(child, childDepth, ctx);
}

/** Parse an Anytype export (already-extracted entries) into entity drafts + a
 *  resolved link graph + collection membership. Pure — no vault, no fs. */
export function parseAnytypeExport(
	files: readonly AnytypeFile[],
	attachmentPaths: readonly string[] = [],
): AnytypeImportPlan {
	const snapshots: Snapshot[] = [];
	for (const file of files) {
		if (!JSON_EXT.test(file.path)) continue;
		const snapshot = parseSnapshot(file);
		if (snapshot) snapshots.push(snapshot);
	}

	// Pass 1 — schema indices: type names, relation names + formats, option
	// labels, a global id → name index, and the file-object → binary index.
	const typeNameByKey = new Map<string, string>(); // uniqueKey AND object id → name
	const relationNameByKey = new Map<string, string>();
	const relationFormatByKey = new Map<string, string>();
	const optionLabelById = new Map<string, string>();
	const nameById = new Map<string, string>();
	const fileBinaryByObject = new Map<string, string>();
	const fileObjectIds = new Set<string>();
	// Index every attachment path by several lookup keys so export layouts
	// that put binaries under `files/`, `filesObjects/`, or the root still
	// resolve: basename, full path, stem (no extension), and slugged stem —
	// real with-files exports write binaries under SLUGIFIED names
	// ("Screenshot 2026-03-20 at 09.21.27" → screenshot-2026-03-20-at-09-21-27.png:
	// lowercased, runs outside [a-z0-9_] collapsed to a dash) and TRUNCATE
	// long stems (observed cap 46 chars), so display names never match
	// verbatim (F-396 — a 460MB export reported all 406 files missing).
	const attachmentByKey = new Map<string, string>();
	const stemsByExt = new Map<string, Array<{ stem: string; path: string }>>();
	for (const path of attachmentPaths) {
		const base = path.slice(path.lastIndexOf("/") + 1);
		attachmentByKey.set(path, path);
		attachmentByKey.set(base, path);
		const dot = base.lastIndexOf(".");
		if (dot > 0) {
			const stem = base.slice(0, dot);
			const ext = base.slice(dot + 1).toLowerCase();
			attachmentByKey.set(stem, path);
			attachmentByKey.set(`slug:${slugStem(stem)}.${ext}`, path);
			const pool = stemsByExt.get(ext) ?? [];
			pool.push({ stem: slugStem(stem), path });
			stemsByExt.set(ext, pool);
		}
	}
	/** Slug-aware lookup: exact slugged stem+ext first, then the unique
	 *  truncation match (the on-disk stem is a ≥8-char prefix of the full
	 *  slugged name). Ambiguity returns nothing — never guess. */
	const findBySlug = (stem: string, ext: string): string | undefined => {
		const slugged = slugStem(stem);
		if (slugged.length === 0) return undefined;
		const exact = attachmentByKey.get(`slug:${slugged}.${ext}`);
		if (exact) return exact;
		const prefixed = (stemsByExt.get(ext) ?? []).filter(
			(e) => e.stem.length >= 8 && slugged.startsWith(e.stem),
		);
		return prefixed.length === 1 ? prefixed[0]?.path : undefined;
	};
	const findBinary = (...candidates: Array<string | null | undefined>): string | undefined => {
		for (const c of candidates) {
			if (!c) continue;
			const base = c.slice(c.lastIndexOf("/") + 1);
			const hit = attachmentByKey.get(c) ?? attachmentByKey.get(base);
			if (hit) return hit;
			const dot = base.lastIndexOf(".");
			if (dot > 0) {
				const slugHit = findBySlug(base.slice(0, dot), base.slice(dot + 1).toLowerCase());
				if (slugHit) return slugHit;
			}
		}
		return undefined;
	};
	for (const snap of snapshots) {
		const name = asString(snap.details.name);
		if (name) nameById.set(snap.id, name);
		if (snap.sbType === "STType") {
			if (name) {
				typeNameByKey.set(snap.id, name);
				const unique = asString(snap.details.uniqueKey);
				if (unique) typeNameByKey.set(unique, name);
				if (snap.key) {
					typeNameByKey.set(snap.key, name);
					typeNameByKey.set(`ot-${snap.key}`, name);
				}
			}
		} else if (snap.sbType === "STRelation") {
			const key = asString(snap.details.relationKey);
			if (key && name) relationNameByKey.set(key, name);
			const format = normalizeRelationFormat(snap.details.relationFormat);
			if (key && format) relationFormatByKey.set(key, format);
		} else if (snap.sbType === "STRelationOption") {
			if (name) optionLabelById.set(snap.id, name);
		} else if (FILE_SB_TYPES.has(snap.sbType)) {
			fileObjectIds.add(snap.id);
			// The file object's display name usually lacks the extension the
			// binary carries (`fileExt` is a separate detail) — try both, plus
			// the object id itself (some exports name the binary after it).
			const ext = asString(snap.details.fileExt);
			const binary = findBinary(
				name,
				ext && name ? `${name}.${ext}` : null,
				snap.id,
				ext ? `${snap.id}.${ext}` : null,
				asString(snap.details.fileId),
			);
			if (binary) fileBinaryByObject.set(snap.id, binary);
		}
	}

	// Pass 2 — importable objects.
	let skippedSystem = 0;
	const importable = snapshots.filter((s) => {
		if (SYSTEM_SB_TYPES.has(s.sbType) || FILE_SB_TYPES.has(s.sbType)) return false;
		if (s.objectTypes.some((t) => SYSTEM_OBJECT_TYPES.has(t))) {
			skippedSystem++;
			return false;
		}
		return true;
	});
	const objectIds = new Set(importable.map((s) => s.id));
	// Value conversion per the relation's declared format: unix-second dates →
	// ISO strings, object/file references → their display names; everything
	// else resolves tag/select option ids to labels and passes through.
	const resolveValue = (key: string, value: unknown): unknown => {
		const format = relationFormatByKey.get(key);
		const one = (v: unknown): unknown => {
			if (format === "date" && typeof v === "number" && Number.isFinite(v)) {
				return new Date(v * 1000).toISOString();
			}
			if ((format === "object" || format === "file") && typeof v === "string") {
				return nameById.get(v) ?? v;
			}
			if (typeof v === "string") return optionLabelById.get(v) ?? v;
			return v;
		};
		return Array.isArray(value) ? value.map(one) : one(value);
	};

	const entities: AnytypeEntityDraft[] = [];
	const links: AnytypeLinkSpec[] = [];
	const fileLinks: AnytypeFileLink[] = [];
	const unresolved: Array<{ from: string; target: string }> = [];
	const collections: AnytypeCollectionDraft[] = [];
	const seenLink = new Set<string>();
	let skippedArchived = 0;
	let filesMissingBinary = 0;

	for (const snap of importable) {
		if (snap.details.isArchived === true || snap.details.isDeleted === true) {
			skippedArchived++;
			continue;
		}
		const addLink = (target: string): void => {
			const key = `${snap.id}→${target}`;
			if (seenLink.has(key) || target === snap.id) return;
			seenLink.add(key);
			if (objectIds.has(target)) links.push({ from: snap.id, to: target });
			else if (fileBinaryByObject.has(target))
				fileLinks.push({ fromObject: snap.id, fileObjectId: target });
			else if (fileObjectIds.has(target)) filesMissingBinary++;
			else unresolved.push({ from: snap.id, target });
		};
		const addFileLink = (target: string, name: string | null): void => {
			// A file block that misses the object index can still match an export
			// binary by its inline file name (the block carries name/mime/size).
			if (!fileObjectIds.has(target) && !fileBinaryByObject.has(target) && name) {
				const path = findBinary(name);
				if (path) {
					const pseudoId = `path:${path}`;
					fileBinaryByObject.set(pseudoId, path);
					const key = `${snap.id}→${pseudoId}`;
					if (seenLink.has(key)) return;
					seenLink.add(key);
					fileLinks.push({ fromObject: snap.id, fileObjectId: pseudoId });
					return;
				}
			}
			addLink(target);
		};

		const byId = new Map(snap.blocks.map((b) => [asString(b.id) ?? "", b] as const));
		// Root children: prefer the smartblock root's childrenIds; fall back to
		// every non-chrome block id in file order when the root is missing.
		const rootChildren = byId.has(snap.id)
			? stringArray(byId.get(snap.id)?.childrenIds)
			: snap.blocks.map((b) => asString(b.id) ?? "").filter((id) => id.length > 0 && id !== snap.id);
		const { state: bodyState, snippet } = anytypeBlocksToLexical(byId, rootChildren, {
			onMention: addLink,
			onLinkBlock: addLink,
			onFileBlock: addFileLink,
			nameOf: (id) => nameById.get(id) ?? null,
		});

		const properties: Record<string, unknown> = {};
		for (const [key, raw] of Object.entries(snap.details)) {
			if (SYSTEM_DETAIL_KEYS.has(key) || key === "name") continue;
			const value = resolveValue(key, raw);
			if (value === null || value === undefined || value === "") continue;
			if (Array.isArray(value) && value.length === 0) continue;
			properties[SYSTEM_PROPERTY_MAP[key] ?? relationNameByKey.get(key) ?? key] = value;
		}
		const typeCandidates = [snap.objectTypes[0], asString(snap.details.type)].filter(
			(k): k is string => typeof k === "string" && k.length > 0,
		);
		const mapped = typeCandidates.map((k) => typeNameByKey.get(k)).find((n) => n !== undefined);
		const first = typeCandidates[0];
		const anytypeType = mapped ?? (first !== undefined ? prettifyTypeKey(first) : null);
		if (anytypeType) properties.anytypeType = anytypeType;
		// Search snippet (plain text) — the editor body is the Lexical state.
		if (snippet.length > 0) properties.body = snippet;
		// Notes/Journal read these property-bag timestamps when present.
		const createdMs = anytypeDateToMs(snap.details.createdDate);
		const updatedMs = anytypeDateToMs(snap.details.lastModifiedDate) ?? createdMs;
		if (createdMs !== null) properties.createdAt = createdMs;
		if (updatedMs !== null) properties.updatedAt = updatedMs;

		// F-394 — mirror the user-facing relations into the `values` bag the
		// shared property panel reads (`@brainstorm/sdk/property-ui` value-store:
		// per-entity property values live under `properties.values`, keyed by
		// PropertyDef.key). Notes' Properties panel renders exactly the keys in
		// that bag that have a registered PropertyDef, so without this the
		// imported tags/relations were stored but never surfaced. Keys are the
		// same slug {@link propertyKey} that {@link deriveTypeSchemas} mints, so
		// value keys and registered defs always agree. Top-level keys stay as-is
		// (Database columns, search snippets, and timestamps read those).
		const values: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(properties)) {
			if (NON_SCHEMA_KEYS.has(key)) continue;
			values[propertyKey(key)] = value;
		}
		if (Object.keys(values).length > 0) properties.values = values;

		// Anytype Notes carry no `name`; the Title chrome block (when the user
		// typed one) outranks the snippet-derived fallback.
		const titleBlock = snap.blocks.find((b) => asString(asRecord(b.text)?.style) === "Title");
		const title =
			asString(snap.details.name) ??
			asString(asRecord(titleBlock?.text)?.text) ??
			asString(snap.details.snippet)?.split("\n")[0]?.trim() ??
			"Untitled";
		entities.push({
			title,
			properties,
			anytypeType,
			externalId: snap.id,
			bodyState: snippet.length > 0 ? bodyState : null,
		});

		if (snap.collectionMembers) {
			collections.push({
				id: snap.id,
				name: title,
				memberIds: snap.collectionMembers.filter((m) => objectIds.has(m)),
			});
		}
	}

	// Drop links whose source got skipped as archived (their drafts don't exist).
	const draftIds = new Set(entities.map((e) => e.externalId));
	return {
		entities,
		links: links.filter((l) => draftIds.has(l.from) && draftIds.has(l.to)),
		fileLinks: fileLinks.filter((l) => draftIds.has(l.fromObject)),
		fileBinaryByObject,
		collections,
		unresolved: unresolved.filter((u) => draftIds.has(u.from)),
		skippedArchived,
		skippedSystem,
		filesMissingBinary,
	};
}

/** Draft properties that are the importer's own bookkeeping or entity-level
 *  chrome/meta, not user schema: they never become PropertyDefs and never land
 *  in the `values` bag (`createdAt`/`updatedAt` are entity timestamps the
 *  panel already shows as meta rows; `icon` is the entity's icon; `values` is
 *  the bag itself). */
const NON_SCHEMA_KEYS: ReadonlySet<string> = new Set([
	"anytypeType",
	"body",
	"title",
	"values",
	"icon",
	"createdAt",
	"updatedAt",
	IMPORT_EXTERNAL_ID_PROP,
]);

export type AnytypeTypeSchema = {
	type: string;
	properties: PropertyDef[];
};

function propertyKey(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "field"
	);
}

/** Derive a typed schema per Anytype type from the parsed drafts (IE-2 Map
 *  tail): each relation used by a type's objects becomes a PropertyDef with
 *  its ValueType inferred across that type's values. Pure. */
export function deriveTypeSchemas(plan: AnytypeImportPlan): AnytypeTypeSchema[] {
	const byType = new Map<string, AnytypeEntityDraft[]>();
	for (const draft of plan.entities) {
		if (draft.anytypeType === null) continue;
		const drafts = byType.get(draft.anytypeType) ?? [];
		drafts.push(draft);
		byType.set(draft.anytypeType, drafts);
	}
	const schemas: AnytypeTypeSchema[] = [];
	for (const [type, drafts] of byType) {
		const names: string[] = [];
		const seen = new Set<string>();
		for (const draft of drafts) {
			for (const name of Object.keys(draft.properties)) {
				if (NON_SCHEMA_KEYS.has(name) || seen.has(name)) continue;
				seen.add(name);
				names.push(name);
			}
		}
		const properties: PropertyDef[] = names.map((name) => {
			const samples = drafts.map((d) => d.properties[name]);
			// Anytype tag/multi-relations arrive as arrays — declare the def
			// multi-valued (value-store's coerceValue then wraps the bare
			// elements into the labeled envelope) and infer the element type,
			// so an imported tag list renders as tags instead of a mangled
			// scalar text cell.
			const present = samples.filter((v) => v !== null && v !== undefined && v !== "");
			const isMulti = present.length > 0 && present.every((v) => Array.isArray(v));
			const def: PropertyDef = {
				key: propertyKey(name),
				name,
				icon: null,
				valueType: inferValueType(isMulti ? present.flat() : samples),
			};
			return isMulti ? { ...def, count: { min: 0, max: CARDINALITY_HARD_MAX } } : def;
		});
		schemas.push({ type, properties });
	}
	return schemas;
}

/** Stable id for an Anytype Collection's `List/v1` — idempotent re-import
 *  updates the same List rather than minting a duplicate.
 *
 *  Must stay inside {@link SAFE_ENTITY_ID_RE} (`[A-Za-z0-9_-]{1,128}`): the
 *  earlier `anytype-list:${source}:${id}` shape used colons / dots and was
 *  rejected by `entities.create`, so collection minting silently no-oped
 *  (the outer try/catch treats schema/list failures as non-fatal). */
export function anytypeCollectionId(source: string, collectionId: string): string {
	// FNV-1a 32-bit — deterministic, no crypto dep, short hex digest.
	let h = 0x811c9dc5;
	const input = `${source}\0${collectionId}`;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	const digest = (h >>> 0).toString(16).padStart(8, "0");
	// Keep a short readable stem of the Anytype object id (usually `bafy…`)
	// so the List is greppable in entities.db, then the digest for uniqueness.
	const stem = collectionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
	const id = stem.length > 0 ? `anytype-list-${stem}-${digest}` : `anytype-list-${digest}`;
	return id.length <= 128 ? id : id.slice(0, 128);
}

export type AnytypeImportOptions = {
	/** Vault entity type the objects map onto (e.g. `io.brainstorm.notes/Note/v1`). */
	readonly targetType: string;
	/** Stable source id namespacing the dedupe key (e.g. `anytype:my-space`). */
	readonly source: string;
	readonly now: number;
	readonly importedBy: string;
	readonly onProgress?: (done: number, total: number) => void;
	readonly signal?: AbortSignal;
	/** Plant markdown `body` into each entity's universal-body Y.Doc so the
	 *  editor is non-empty. When omitted, only the property-bag snippet lands
	 *  (tests that don't care about the editor can skip it). */
	readonly applyDocUpdate?: ApplyDocUpdate;
	/** Precomputed {@link parseAnytypeExport} result — the wizard parses once
	 *  at pick time (for the preview count) and hands the plan to the run so
	 *  the export isn't parsed twice. When omitted the run parses `files`
	 *  itself (tests / other callers are unaffected). */
	readonly plan?: AnytypeImportPlan;
};

export type AnytypeImportReport = {
	readonly created: number;
	readonly updated: number;
	readonly filesCreated: number;
	readonly linked: number;
	readonly unresolved: number;
	readonly skippedArchived: number;
	readonly skippedSystem: number;
	readonly filesMissingBinary: number;
	readonly collectionsCreated: number;
	readonly propertiesRegistered: number;
	readonly cancelled?: boolean;
};

const ANYTYPE_YIELD_EVERY = 50;

/** Commit a parsed Anytype export into the vault: idempotent upsert of every
 *  object (keyed on its Anytype id via {@link IMPORT_EXTERNAL_ID_PROP}),
 *  referenced file binaries as `File/v1` entities, the object-link graph,
 *  per-type PropertyDefs, and each Collection as a `List/v1`. Re-importing
 *  the same export updates rather than duplicates. */
export async function importAnytypeExport(
	session: VaultSession,
	files: readonly AnytypeFile[],
	options: AnytypeImportOptions,
	attachments: readonly AnytypeAttachment[] = [],
): Promise<AnytypeImportReport> {
	const plan =
		options.plan ??
		parseAnytypeExport(
			files,
			attachments.map((a) => a.path),
		);
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	// Resolve every dedupe key (objects, referenced files, collections) in one
	// batched query up front — one map hit per row in the loops below instead
	// of one full-table `json_extract` scan per entity.
	const dedupeKeys: string[] = [];
	for (const draft of plan.entities) dedupeKeys.push(`${options.source}:${draft.externalId}`);
	for (const link of plan.fileLinks) {
		dedupeKeys.push(`${options.source}:file:${link.fileObjectId}`);
	}
	for (const draft of plan.collections)
		dedupeKeys.push(anytypeCollectionId(options.source, draft.id));
	const existingByKey = new Map<string, string>();
	for (const { id, value } of repo.listIdsWithPropertyIn(IMPORT_EXTERNAL_ID_PROP, dedupeKeys)) {
		if (!existingByKey.has(value)) existingByKey.set(value, id);
	}
	const idByExternal = new Map<string, string>();
	let created = 0;
	let updated = 0;

	const total = plan.entities.length;
	for (let i = 0; i < total; i++) {
		if (options.signal?.aborted) {
			return {
				created,
				updated,
				filesCreated: 0,
				linked: 0,
				unresolved: plan.unresolved.length,
				skippedArchived: plan.skippedArchived,
				skippedSystem: plan.skippedSystem,
				filesMissingBinary: plan.filesMissingBinary,
				collectionsCreated: 0,
				propertiesRegistered: 0,
				cancelled: true,
			};
		}
		const draft = plan.entities[i] as (typeof plan.entities)[number];
		const externalKey = `${options.source}:${draft.externalId}`;
		const existing = existingByKey.get(externalKey) ?? null;
		const properties: Record<string, unknown> = {
			...draft.properties,
			title: draft.title,
			[IMPORT_EXTERNAL_ID_PROP]: externalKey,
		};
		const createdMs = typeof properties.createdAt === "number" ? properties.createdAt : options.now;
		const updatedMs = typeof properties.updatedAt === "number" ? properties.updatedAt : createdMs;
		let entityId: string;
		if (existing !== null) {
			repo.update(existing, properties, updatedMs);
			idByExternal.set(draft.externalId, existing);
			entityId = existing;
			updated++;
		} else {
			const id = `ent_${ulid()}`;
			repo.create({
				id,
				type: options.targetType,
				properties,
				createdBy: options.importedBy,
				now: createdMs,
				updatedAt: updatedMs,
				dekId: null,
			});
			idByExternal.set(draft.externalId, id);
			// A later draft with the same external id must update, not duplicate
			// (matches the old per-entity re-query semantics).
			existingByKey.set(externalKey, id);
			entityId = id;
			created++;
		}
		// Editor body lives in the Y.Doc — plant the Lexical state built from
		// Anytype blocks (not markdown, which mangled structure).
		if (options.applyDocUpdate && draft.bodyState) {
			try {
				await plantImportSerializedBody(entityId, draft.bodyState, options.applyDocUpdate);
			} catch {
				// Non-fatal: row + snippet still land; body plant retries on re-import.
			}
		}
		options.onProgress?.(i + 1, total);
		if ((i + 1) % ANYTYPE_YIELD_EVERY === 0) await Promise.resolve();
	}

	// Referenced file binaries → File/v1 entities (only ones a page references).
	const assetStore = await session.assetStore();
	const bytesByPath = new Map(attachments.map((a) => [a.path, a.bytes]));
	const idByFileObject = new Map<string, string>();
	let filesCreated = 0;
	for (const link of plan.fileLinks) {
		if (idByFileObject.has(link.fileObjectId)) continue;
		const path = plan.fileBinaryByObject.get(link.fileObjectId);
		const bytes = path ? bytesByPath.get(path) : undefined;
		if (!path || !bytes) continue;
		const name = path.slice(path.lastIndexOf("/") + 1);
		const externalKey = `${options.source}:file:${link.fileObjectId}`;
		const existing = existingByKey.get(externalKey) ?? null;
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
			idByFileObject.set(link.fileObjectId, existing);
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
			idByFileObject.set(link.fileObjectId, id);
			filesCreated++;
		}
	}

	// Re-plant bodies with image srcs rewritten to `brainstorm://asset/…` once
	// the AssetStore has the binaries. Initial plant used file names as src.
	if (options.applyDocUpdate && idByFileObject.size > 0) {
		const srcByName = new Map<string, string>();
		for (const [, fileEntityId] of idByFileObject) {
			const file = repo.get(fileEntityId);
			const assetUrl =
				typeof file?.properties.attachment === "string" ? file.properties.attachment : null;
			const name = typeof file?.properties.name === "string" ? file.properties.name : null;
			if (assetUrl && name) srcByName.set(name, assetUrl);
		}
		for (const draft of plan.entities) {
			if (!draft.bodyState) continue;
			const entityId = idByExternal.get(draft.externalId);
			if (!entityId) continue;
			const rewritten = rewriteImageSrcs(draft.bodyState, srcByName);
			if (!rewritten) continue;
			try {
				await plantImportSerializedBody(entityId, rewritten, options.applyDocUpdate);
			} catch {
				// Non-fatal — asset entities exist even if the re-plant fails.
			}
		}
	}

	// Deterministic link ids so a re-import upserts rather than duplicates.
	const seen = new Set<string>();
	let linked = 0;
	const writeLink = (sourceId: string, destId: string): void => {
		// Link row ids are not entity ids — they may use `:` separators.
		const id = `ln:anytype:${sourceId}:${destId}`;
		if (seen.has(id)) return;
		seen.add(id);
		repo.putLink({
			id,
			sourceEntityId: sourceId,
			destEntityId: destId,
			linkType: ANYTYPE_LINK_TYPE,
			createdAt: options.now,
		});
		linked++;
	};
	for (const link of plan.links) {
		const sourceId = idByExternal.get(link.from);
		const destId = idByExternal.get(link.to);
		if (sourceId && destId) writeLink(sourceId, destId);
	}
	for (const link of plan.fileLinks) {
		const sourceId = idByExternal.get(link.fromObject);
		const destId = idByFileObject.get(link.fileObjectId);
		if (sourceId && destId) writeLink(sourceId, destId);
	}

	// IE-2 Map tail — per-type PropertyDefs + each Collection as a List/v1.
	// Best-effort: a failure here never invalidates the committed objects.
	let collectionsCreated = 0;
	let propertiesRegistered = 0;
	try {
		const schemas = deriveTypeSchemas(plan);
		if (schemas.length > 0) {
			const store = await session.propertiesStore();
			// Register only keys the catalog doesn't have yet — an established
			// def (canonical `tags`, a user-tuned vocabulary/format) must never
			// be clobbered by an inferred import guess. Values still land under
			// the shared key, so they surface through the existing def.
			const existingDefs = store.snapshot().properties;
			for (const schema of schemas) {
				for (const def of schema.properties) {
					if (existingDefs[def.key]) continue;
					store.setProperty(def);
					propertiesRegistered++;
				}
			}
		}
		for (const draft of plan.collections) {
			const include: MemberInclude[] = draft.memberIds
				.map((m) => idByExternal.get(m))
				.filter((id): id is string => id !== undefined)
				.map((entityId) => ({ entityId, addedAt: options.now, by: "user" }));
			const collection: List = {
				id: anytypeCollectionId(options.source, draft.id),
				name: draft.name,
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
			const existing = existingByKey.get(collection.id) ?? null;
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
	} catch {
		// Schema/collection minting is a refinement over the committed rows.
	}

	return {
		created,
		updated,
		filesCreated,
		linked,
		unresolved: plan.unresolved.length,
		skippedArchived: plan.skippedArchived,
		skippedSystem: plan.skippedSystem,
		filesMissingBinary: plan.filesMissingBinary,
		collectionsCreated,
		propertiesRegistered,
	};
}
