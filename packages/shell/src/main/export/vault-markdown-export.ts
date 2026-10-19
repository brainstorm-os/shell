/**
 * IE-13 — whole-vault Markdown export: a plain folder tree a person can open
 * in any editor, with no Brainstorm required to read it.
 *
 *   <dest>/Brainstorm export 2026-10-18/
 *     ├── Notes/Roadmap.md        one file per object, grouped by type
 *     ├── Tasks/Ship it.md
 *     └── assets/<asset-id>.png   attachments the exported objects use
 *
 * Each file is YAML front matter (the object's properties, plus its type and
 * timestamps) over the rich-text body read straight out of its Y.Doc
 * (`serializedStateFromDoc` → `serializedStateToMarkdown`). Links between
 * objects become relative links between the files; a link, mention or
 * relation to an object that is NOT exported (deleted, or internal plumbing)
 * becomes its plain label — an entity id never reaches the output.
 *
 * Streamed: one object is loaded, rendered and written at a time, yielding to
 * the event loop every {@link EXPORT_YIELD_EVERY} objects so a large vault
 * never stalls the main process. Aborting removes the partial folder.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
	TextFormat,
	serializedStateFromDoc,
	serializedStateToMarkdown,
} from "@brainstorm-os/editor";
import { friendlyTypeName, isPlumbingEntityType } from "@brainstorm-os/sdk/system-entities";
import { deriveEntityTitle } from "../entities/derive-title";
import { STRUCTURAL_ENTITY_TYPES } from "../entities/vault-entities-service";
import { yieldToEventLoop } from "../import/import-engine";
import { IMPORT_BODY_HASH_PROP, IMPORT_EXTERNAL_ID_PROP } from "../import/import-types";
import { EntitiesRepository, type EntityRow } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";

const EXPORT_YIELD_EVERY = 25;
const MAX_NAME_CHARS = 80;
const MAX_PROPERTY_DEPTH = 6;
const ASSETS_DIR = "assets";
const UNTITLED = "Untitled";
const ENTITY_URL_PREFIX = "brainstorm://entity/";
const ASSET_URL_RE = /brainstorm:\/\/asset\/([A-Za-z0-9_-]+)/g;
const OMITTED_PROPS = new Set(["body", IMPORT_EXTERNAL_ID_PROP, IMPORT_BODY_HASH_PROP]);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** Schemes a link may keep. Anything else (`javascript:`, `data:`, `file:`,
 *  `vbscript:` …) would run or reach local files from the exported Markdown
 *  in whatever viewer opens it, so the link degrades to its label. */
const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto"]);
const URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"image/svg+xml": "svg",
	"image/x-icon": "ico",
	"image/vnd.microsoft.icon": "ico",
	"application/pdf": "pdf",
	"audio/mpeg": "mp3",
	"video/mp4": "mp4",
	"text/plain": "txt",
};

type Node = { type?: unknown; children?: unknown; [k: string]: unknown };

/** How the rewrite pass resolves a reference found in a body or property. */
export type ReferenceResolver = {
	/** Relative link from the current file to an exported object, else null. */
	entityLink(entityId: string): string | null;
	/** True when the id names an object this vault knows (exported or not). */
	isKnownEntity(entityId: string): boolean;
	/** A human label for an object, for references that must degrade to text. */
	entityLabel(entityId: string): string;
	/** Relative link from the current file to a copied asset, else null. */
	assetLink(assetId: string): string | null;
};

export type MarkdownExportOptions = {
	/** The folder the user picked; the export creates its own folder inside. */
	readonly destDir: string;
	readonly now: number;
	readonly onProgress?: (done: number, total: number) => void;
	readonly signal?: AbortSignal;
};

export type MarkdownExportResult = {
	readonly path: string;
	readonly entities: number;
	readonly assets: number;
};

/** A name that is safe as one path segment on macOS, Windows and Linux. */
export function fileSafeName(raw: string, fallback: string = UNTITLED): string {
	const spaced = raw
		.normalize("NFC")
		.replace(/[\p{Cc}\p{Cs}]/gu, " ")
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, "");
	// Cut by code point, never by UTF-16 unit: a slice through a surrogate
	// pair leaves half an emoji, which some file systems refuse outright.
	const cleaned = Array.from(spaced).slice(0, MAX_NAME_CHARS).join("").trim();
	if (cleaned.length === 0) return fallback;
	return WINDOWS_RESERVED.test(cleaned) ? `${cleaned}_` : cleaned;
}

/** The identity a file system gives a name: APFS / NTFS fold case, and APFS
 *  folds Unicode normalisation (`é` precomposed == `e` + combining accent). */
function collisionKey(path: string): string {
	return path.normalize("NFC").toLowerCase();
}

/** id → `Folder/Name.md` for every exported object. Names are unique per
 *  folder under {@link collisionKey}, with ` (2)` suffixes in the given row
 *  order, so no export overwrites another. */
export function planEntityPaths(
	rows: ReadonlyArray<{ id: string; type: string; title: string }>,
): Map<string, string> {
	const out = new Map<string, string>();
	const taken = new Set<string>();
	for (const row of rows) {
		const folder = fileSafeName(friendlyTypeName(row.type), "Objects");
		const base = fileSafeName(row.title);
		let name = base;
		for (let n = 2; taken.has(collisionKey(`${folder}/${name}`)); n += 1) name = `${base} (${n})`;
		taken.add(collisionKey(`${folder}/${name}`));
		out.set(row.id, `${folder}/${name}.md`);
	}
	return out;
}

/** A Markdown link target from one exported file to another, each segment
 *  percent-encoded so spaces and parentheses survive every renderer. */
export function relativeLink(fromFile: string, toFile: string): string {
	const rel = posix.relative(posix.dirname(fromFile), toFile);
	return rel
		.split("/")
		.map((segment) => (segment === ".." ? segment : encodeURIComponent(segment)))
		.join("/");
}

function assetFileName(assetId: string, mime: string): string {
	return `${assetId}.${MIME_EXTENSIONS[mime.toLowerCase()] ?? "bin"}`;
}

function escapeHtmlOpen(text: string): string {
	return text.replace(/</g, "\\<");
}

function textNode(text: string): Node {
	return { type: "text", text: escapeHtmlOpen(text), format: 0 };
}

function entityIdFromUrl(url: string): string | null {
	if (!url.startsWith(ENTITY_URL_PREFIX)) return null;
	const id = url.slice(ENTITY_URL_PREFIX.length).split(/[/?#]/)[0] ?? "";
	return id.length > 0 ? id : null;
}

/** True for a link target safe to keep: a relative path / anchor (no scheme)
 *  or an allow-listed scheme. Controls and spaces are stripped first, the way
 *  browsers do, so `java\tscript:` is still seen as `javascript:`. */
export function isSafeLinkUrl(url: string): boolean {
	const compact = url.replace(/[\u0000-\u0020\u007f]/g, "");
	const scheme = URL_SCHEME_RE.exec(compact)?.[1];
	return scheme === undefined || SAFE_LINK_SCHEMES.has(scheme.toLowerCase());
}

/** Keep a kept URL inside its `(…)`: an unescaped `)`, space or `<` would end
 *  the link early and turn the rest into live Markdown / HTML. */
function linkSafeUrl(url: string): string {
	return url.replace(
		/[\s()<>]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);
}

function rewriteAssetUrls(value: string, resolve: ReferenceResolver): string {
	return value.replace(ASSET_URL_RE, (_match, id: string) => resolve.assetLink(id) ?? "");
}

function rewriteNode(
	node: Node,
	resolve: ReferenceResolver,
	topLevel: boolean,
	inCode = false,
): Node {
	const type = typeof node.type === "string" ? node.type : "";
	const childInCode = inCode || type === "code";
	const children = Array.isArray(node.children)
		? (node.children as Node[]).map((child) => rewriteNode(child, resolve, false, childInCode))
		: undefined;

	const mentionId = type === "mention" && typeof node.entityId === "string" ? node.entityId : null;
	if (mentionId) {
		const label =
			(typeof node.label === "string" && node.label) ||
			(typeof node.text === "string" && node.text) ||
			resolve.entityLabel(mentionId);
		const link = resolve.entityLink(mentionId);
		return link ? { type: "link", url: link, children: [textNode(label)] } : textNode(label);
	}

	if ((type === "link" || type === "autolink") && typeof node.url === "string") {
		const targetId = entityIdFromUrl(node.url);
		const link = targetId ? resolve.entityLink(targetId) : null;
		if (link) return { ...node, url: link, ...(children ? { children } : {}) };
		if (node.url.startsWith("brainstorm://") || !isSafeLinkUrl(node.url)) {
			return { type: "inline", children: children ?? [] };
		}
		return { ...node, url: linkSafeUrl(node.url), ...(children ? { children } : {}) };
	}

	// Body text is written as-is by the Markdown serializer, so a typed
	// `<a href="javascript:…">` would become live HTML in most viewers.
	// Code spans render `<` literally already; everything else escapes it.
	if (type === "text" && typeof node.text === "string" && !inCode) {
		const format = typeof node.format === "number" ? node.format : 0;
		if ((format & TextFormat.Code) === 0) return { ...node, text: escapeHtmlOpen(node.text) };
	}

	if (type === "title" && topLevel) {
		return { type: "heading", tag: "h1", children: children ?? [] };
	}

	const out: Node = { ...node, ...(children ? { children } : {}) };
	if (typeof out.src === "string") out.src = rewriteAssetUrls(out.src, resolve);
	return out;
}

/** Rewrite a serialized body so every internal reference points at the
 *  exported files: mentions + entity links become relative links (or their
 *  label when the target is not exported), asset URLs point into `assets/`,
 *  and the leading title node becomes the H1. */
export function rewriteBodyTree(
	state: { root?: Node } | null,
	resolve: ReferenceResolver,
): { root: Node } | null {
	const root = state?.root;
	if (!root || !Array.isArray(root.children)) return null;
	return {
		root: {
			...root,
			children: (root.children as Node[]).map((child) => rewriteNode(child, resolve, true)),
		},
	};
}

/** A property value with every internal reference rewritten: an exported
 *  object's id becomes its relative link, any other known object's id its
 *  label, asset ids/URLs their copied file. */
export function rewritePropertyValue(
	value: unknown,
	resolve: ReferenceResolver,
	depth = 0,
): unknown {
	if (typeof value === "string") {
		if (resolve.isKnownEntity(value)) {
			return resolve.entityLink(value) ?? resolve.entityLabel(value);
		}
		const urlTarget = entityIdFromUrl(value);
		if (urlTarget) return resolve.entityLink(urlTarget) ?? resolve.entityLabel(urlTarget);
		const asset = resolve.assetLink(value);
		if (asset) return asset;
		return rewriteAssetUrls(value, resolve);
	}
	if (depth >= MAX_PROPERTY_DEPTH || value === null || typeof value !== "object") return value;
	if (Array.isArray(value))
		return value.map((item) => rewritePropertyValue(item, resolve, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (resolve.isKnownEntity(key)) continue;
		out[key] = rewritePropertyValue(nested, resolve, depth + 1);
	}
	return out;
}

function yamlKey(key: string): string {
	return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

/** YAML front matter. Every value is written as JSON, which is a strict YAML
 *  subset — quoting is always correct, whatever the value contains. */
export function frontMatter(entries: ReadonlyArray<[string, unknown]>): string {
	const lines = entries
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${yamlKey(key)}: ${JSON.stringify(value)}`);
	return lines.length > 0 ? `---\n${lines.join("\n")}\n---\n` : "";
}

export function renderEntityMarkdown(input: {
	row: EntityRow;
	title: string;
	body: { root?: Node } | null;
	resolve: ReferenceResolver;
}): string {
	const { row, title, resolve } = input;
	const entries: Array<[string, unknown]> = [
		["type", friendlyTypeName(row.type)],
		["created", new Date(row.createdAt).toISOString()],
		["updated", new Date(row.updatedAt).toISOString()],
	];
	for (const [key, value] of Object.entries(row.properties)) {
		if (OMITTED_PROPS.has(key)) continue;
		entries.push([key, rewritePropertyValue(value, resolve)]);
	}
	const rewritten = rewriteBodyTree(input.body, resolve);
	let body = rewritten ? serializedStateToMarkdown(rewritten) : "";
	if (!rewritten) {
		const raw = row.properties.body;
		if (typeof raw === "string") body = rewriteAssetUrls(raw.trim(), resolve);
		else if (raw && typeof raw === "object") {
			const fromProps = rewriteBodyTree(raw as { root?: Node }, resolve);
			body = fromProps ? serializedStateToMarkdown(fromProps) : "";
		}
	}
	const heading = title && !body.startsWith("# ") ? `# ${title}\n\n` : "";
	const content = `${heading}${body}`.trim();
	return `${frontMatter(entries)}${content.length > 0 ? `\n${content}\n` : ""}`;
}

/** Create `<parent>/<name>`, or `<name> (2)`, … when it already exists. */
async function createUniqueDir(parent: string, name: string): Promise<string> {
	for (let n = 1; ; n += 1) {
		const candidate = join(parent, n === 1 ? name : `${name} (${n})`);
		try {
			await mkdir(candidate);
			return candidate;
		} catch (error) {
			if ((error as { code?: unknown }).code !== "EEXIST") throw error;
		}
	}
}

function isExportable(row: EntityRow): boolean {
	return !STRUCTURAL_ENTITY_TYPES.has(row.type) && !isPlumbingEntityType(row.type);
}

export async function exportVaultMarkdown(
	session: Pick<VaultSession, "dataStores" | "assetStore" | "ydocStore">,
	options: MarkdownExportOptions,
): Promise<MarkdownExportResult | null> {
	if (options.signal?.aborted) return null;
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	const assetStore = await session.assetStore();
	const live = repo.query({});
	const deleted = repo.listDeleted();
	const known = new Set<string>([...live, ...deleted].map((r) => r.id));
	const titles = new Map<string, string>();
	for (const row of [...live, ...deleted]) titles.set(row.id, deriveEntityTitle(row.properties));

	const rows = live
		.filter(isExportable)
		.sort(
			(a, b) => a.type.localeCompare(b.type) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
		);
	const paths = planEntityPaths(
		rows.map((r) => ({ id: r.id, type: r.type, title: titles.get(r.id) ?? "" })),
	);
	const assets = new Map(assetStore.listBound().map((meta) => [meta.assetId, meta]));

	const day = new Date(options.now).toISOString().slice(0, 10);
	const root = await createUniqueDir(options.destDir, `Brainstorm export ${day}`);
	const createdDirs = new Set<string>();
	const ensureDir = async (relDir: string): Promise<void> => {
		if (createdDirs.has(relDir)) return;
		await mkdir(join(root, ...relDir.split("/")), { recursive: true });
		createdDirs.add(relDir);
	};
	const copiedAssets = new Set<string>();

	try {
		let done = 0;
		for (const row of rows) {
			if (options.signal?.aborted) {
				await rm(root, { recursive: true, force: true });
				return null;
			}
			const filePath = paths.get(row.id);
			if (!filePath) continue;
			const wantedAssets = new Set<string>();
			const resolve: ReferenceResolver = {
				entityLink: (id) => {
					const target = paths.get(id);
					return target ? relativeLink(filePath, target) : null;
				},
				isKnownEntity: (id) => known.has(id),
				entityLabel: (id) => titles.get(id) || UNTITLED,
				assetLink: (id) => {
					const meta = assets.get(id);
					if (!meta) return null;
					wantedAssets.add(id);
					return relativeLink(filePath, `${ASSETS_DIR}/${assetFileName(id, meta.mime)}`);
				},
			};

			const { doc } = await session.ydocStore.load(row.id);
			let body: { root?: Node } | null;
			try {
				body = serializedStateFromDoc(doc) as { root?: Node } | null;
			} finally {
				doc.destroy();
			}
			const markdown = renderEntityMarkdown({
				row,
				title: titles.get(row.id) ?? "",
				body,
				resolve,
			});
			await ensureDir(posix.dirname(filePath));
			await writeFile(join(root, ...filePath.split("/")), markdown, "utf8");

			for (const assetId of wantedAssets) {
				if (copiedAssets.has(assetId)) continue;
				const meta = assets.get(assetId);
				if (!meta) continue;
				let read: Awaited<ReturnType<typeof assetStore.readAsset>> = null;
				try {
					read = await assetStore.readAsset(assetId);
				} catch (error) {
					console.warn(`[brainstorm] markdown export: asset ${assetId} unreadable, skipped:`, error);
				}
				if (!read) continue;
				await ensureDir(ASSETS_DIR);
				await writeFile(join(root, ASSETS_DIR, assetFileName(assetId, meta.mime)), read.bytes);
				copiedAssets.add(assetId);
			}

			done += 1;
			options.onProgress?.(done, rows.length);
			if (done % EXPORT_YIELD_EVERY === 0) await yieldToEventLoop();
		}
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
	return { path: root, entities: rows.length, assets: copiedAssets.size };
}
