/**
 * IE-5 — Obsidian vault migration importer (core).
 *
 * The "wiki-vault migration" handler (doc 45 §ownership map). Pure + transport-
 * injected so the parse + two-pass link resolution is exhaustively testable
 * without a vault or the filesystem: it takes an in-memory list of markdown
 * files and produces an {@link ObsidianImportPlan} — entity drafts (frontmatter
 * → properties, body, tags) plus a resolved `[[wikilink]]` / `![[embed]]` graph.
 * The vault binding ({@link importObsidianVault}) walks that plan through the
 * privileged create + link path the seeder / bundle restore use.
 *
 * Frontmatter parsing reuses the IE-4 `parseFrontmatter` adapter, so a single
 * markdown file and an Obsidian vault speak the same property shape. Referenced
 * attachments (`![[image.png]]` / `[[doc.pdf]]`) are sealed into the AssetStore
 * and surfaced as `File/v1` entities linked from the embedding note. `.canvas` →
 * Whiteboard and the separately-installable app packaging ride later rungs (this
 * is the engine core, the same way IE-1/IE-2 landed their cores first).
 */

import { ulid } from "ulid";
import { AssetKind } from "../assets/asset-types";
import { servedMimeForName } from "../files/upload-mime";
import { EntitiesRepository } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";
import type { ApplyDocUpdate } from "../welcome/seed-deps";
import { parseFrontmatter } from "./import-parse";
import { IMPORT_EXTERNAL_ID_PROP } from "./import-types";
import { bodyMarkdownFromProperties, plantImportMarkdownBody } from "./plant-import-body";

/** One source markdown file. `path` is vault-relative (e.g. `notes/Idea.md`). */
export type ObsidianFile = {
	readonly path: string;
	readonly text: string;
};

/** A non-markdown attachment (image / pdf / …) — `bytes` are sealed into the
 *  AssetStore and surfaced as a `File/v1` entity on import. */
export type ObsidianAttachment = {
	readonly path: string;
	readonly bytes: Uint8Array;
};

export enum ObsidianLinkKind {
	Reference = "reference",
	Embed = "embed",
}

/** A resolved `[[file.png]]` / `![[doc.pdf]]` reference to an attachment file
 *  (vs a note). `attachmentPath` is the vault-relative source path. */
export type ObsidianAttachmentLink = {
	readonly fromNote: string;
	readonly attachmentPath: string;
	readonly kind: ObsidianLinkKind;
};

export type ObsidianEntityDraft = {
	/** Basename without extension — the name `[[wikilinks]]` resolve against. */
	readonly noteName: string;
	readonly title: string;
	/** Frontmatter fields + `body` (the markdown after the fence). */
	readonly properties: Record<string, unknown>;
	readonly tags: readonly string[];
	/** Stable source key (the vault-relative path) for idempotent re-import. */
	readonly externalId: string;
};

export type ObsidianLinkSpec = {
	readonly fromNote: string;
	readonly toNote: string;
	readonly kind: ObsidianLinkKind;
};

export type ObsidianImportPlan = {
	readonly entities: readonly ObsidianEntityDraft[];
	/** Links whose target note exists in the vault set. */
	readonly links: readonly ObsidianLinkSpec[];
	/** `[[file.ext]]` / `![[file.ext]]` references resolved to attachment files. */
	readonly attachmentLinks: readonly ObsidianAttachmentLink[];
	/** Distinct attachment paths referenced by at least one note. */
	readonly referencedAttachments: readonly string[];
	/** `[[targets]]` with no matching note OR attachment — surfaced, not dropped. */
	readonly unresolved: ReadonlyArray<{ readonly fromNote: string; readonly target: string }>;
};

/** Link types written for the two reference kinds (parallels the graph link
 *  vocabulary; `brainstorm/<kind>` reverse-DNS-ish, never dereferenced). */
export const OBSIDIAN_LINK_TYPE = "brainstorm/obsidian/links-to";
export const OBSIDIAN_EMBED_TYPE = "brainstorm/obsidian/embeds";
/** The `File/v1` entity type imported attachments become. */
export const FILE_TYPE = "brainstorm/File/v1";

const MARKDOWN_EXT = /\.md$/i;
const WIKILINK_RE = /(!?)\[\[([^\]]+)\]\]/g;
const TAG_RE = /(?:^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;

/** Basename without directory or `.md`, lowercased for case-insensitive match
 *  (Obsidian resolves `[[X]]` by basename, case-insensitively). */
function noteKey(name: string): string {
	const base = name.slice(name.lastIndexOf("/") + 1);
	return base.replace(MARKDOWN_EXT, "").toLowerCase();
}

function noteName(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1);
	return base.replace(MARKDOWN_EXT, "");
}

/** Strip a wikilink target down to the note name: drop a `|alias`, a `#heading`,
 *  a `^block` ref, and any folder path — `[[folder/Note#H|Alias]]` → `Note`. */
function wikilinkTarget(raw: string): string {
	let target = raw.trim();
	const pipe = target.indexOf("|");
	if (pipe >= 0) target = target.slice(0, pipe);
	const hash = target.indexOf("#");
	if (hash >= 0) target = target.slice(0, hash);
	const caret = target.indexOf("^");
	if (caret >= 0) target = target.slice(0, caret);
	target = target.trim();
	return target.slice(target.lastIndexOf("/") + 1).replace(MARKDOWN_EXT, "");
}

/** Basename of a wikilink target WITH its extension (lowercased) — the key an
 *  attachment embed like `![[Pasted image.png]]` resolves against. */
function attachmentKey(raw: string): string {
	let target = raw.trim();
	const pipe = target.indexOf("|");
	if (pipe >= 0) target = target.slice(0, pipe);
	target = target.trim();
	return target.slice(target.lastIndexOf("/") + 1).toLowerCase();
}

function collectTags(body: string): string[] {
	const tags = new Set<string>();
	let match: RegExpExecArray | null = TAG_RE.exec(body);
	while (match !== null) {
		if (match[1]) tags.add(match[1]);
		match = TAG_RE.exec(body);
	}
	return [...tags];
}

/** Parse an Obsidian vault (a set of markdown files) into entity drafts + a
 *  resolved link graph. Non-`.md` files are ignored (attachments ride a later
 *  rung). Pure — no vault, no filesystem.
 *
 *  Two notes sharing a basename in different folders collide in the
 *  name→entity index (last wins), so `[[X]]` resolves to one of them — the same
 *  ambiguity Obsidian itself warns about; full-path link targets are a later
 *  refinement. */
export function parseObsidianVault(
	files: readonly ObsidianFile[],
	attachmentPaths: readonly string[] = [],
): ObsidianImportPlan {
	const mdFiles = files.filter((f) => MARKDOWN_EXT.test(f.path));
	const entities: ObsidianEntityDraft[] = [];
	const byKey = new Map<string, string>(); // noteKey → noteName
	// Attachment basename (with ext, lowercased) → vault-relative path.
	const attachmentByName = new Map<string, string>();
	for (const path of attachmentPaths) {
		attachmentByName.set(path.slice(path.lastIndexOf("/") + 1).toLowerCase(), path);
	}

	for (const file of mdFiles) {
		const name = noteName(file.path);
		const { fields, body } = parseFrontmatter(file.text);
		const properties: Record<string, unknown> = { ...fields };
		if (body.trim().length > 0) properties.body = body.trim();
		const title = typeof fields.title === "string" && fields.title.length > 0 ? fields.title : name;
		entities.push({
			noteName: name,
			title,
			properties,
			tags: collectTags(body),
			externalId: file.path,
		});
		byKey.set(noteKey(file.path), name);
	}

	const links: ObsidianLinkSpec[] = [];
	const attachmentLinks: ObsidianAttachmentLink[] = [];
	const referenced = new Set<string>();
	const unresolved: Array<{ fromNote: string; target: string }> = [];
	for (const file of mdFiles) {
		const from = noteName(file.path);
		const { body } = parseFrontmatter(file.text);
		let match: RegExpExecArray | null = WIKILINK_RE.exec(body);
		while (match !== null) {
			const isEmbed = match[1] === "!";
			const raw = match[2] ?? "";
			const kind = isEmbed ? ObsidianLinkKind.Embed : ObsidianLinkKind.Reference;
			const target = wikilinkTarget(raw);
			const resolvedNote = target.length > 0 ? byKey.get(target.toLowerCase()) : undefined;
			const attachmentPath = attachmentByName.get(attachmentKey(raw));
			if (resolvedNote) {
				links.push({ fromNote: from, toNote: resolvedNote, kind });
			} else if (attachmentPath) {
				attachmentLinks.push({ fromNote: from, attachmentPath, kind });
				referenced.add(attachmentPath);
			} else if (target.length > 0) {
				unresolved.push({ fromNote: from, target });
			}
			match = WIKILINK_RE.exec(body);
		}
	}

	return { entities, links, attachmentLinks, referencedAttachments: [...referenced], unresolved };
}

export type ObsidianImportOptions = {
	/** Vault entity type the notes map onto (e.g. `io.brainstorm.notes/Note/v1`). */
	readonly targetType: string;
	/** Stable source id namespacing the dedupe key (e.g. `obsidian:my-vault`). */
	readonly source: string;
	readonly now: number;
	readonly importedBy: string;
	/** Streaming controls (doc 45 §Streaming): note-import progress + cancel. */
	readonly onProgress?: (done: number, total: number) => void;
	readonly signal?: AbortSignal;
	/** Plant markdown `body` into each note's universal-body Y.Doc. */
	readonly applyDocUpdate?: ApplyDocUpdate;
};

export type ObsidianImportReport = {
	readonly created: number;
	readonly updated: number;
	/** `File/v1` entities created for referenced attachments. */
	readonly filesCreated: number;
	readonly linked: number;
	readonly unresolved: number;
	/** True when an abort cut the note-import short (attachments + links skipped). */
	readonly cancelled?: boolean;
};

/** Yield to the event loop every N notes so progress flushes + a mid-run abort
 *  is observed (the importer runs on the main thread). */
const OBSIDIAN_YIELD_EVERY = 50;

/** Commit a parsed Obsidian plan into the vault: idempotent upsert of every note
 *  (keyed on the source path via {@link IMPORT_EXTERNAL_ID_PROP}), then the
 *  resolved link graph. Re-importing the same vault updates rather than
 *  duplicates and rebuilds links against the current ids. */
export async function importObsidianVault(
	session: VaultSession,
	files: readonly ObsidianFile[],
	options: ObsidianImportOptions,
	attachments: readonly ObsidianAttachment[] = [],
): Promise<ObsidianImportReport> {
	const plan = parseObsidianVault(
		files,
		attachments.map((a) => a.path),
	);
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	const idByNote = new Map<string, string>(); // noteName → vault entity id
	let created = 0;
	let updated = 0;

	const total = plan.entities.length;
	for (let i = 0; i < total; i++) {
		if (options.signal?.aborted) {
			// Cancelled mid-notes: skip attachments + links (they'd reference
			// entities that may not have been created), report what landed.
			return {
				created,
				updated,
				filesCreated: 0,
				linked: 0,
				unresolved: plan.unresolved.length,
				cancelled: true,
			};
		}
		const draft = plan.entities[i] as (typeof plan.entities)[number];
		const externalKey = `${options.source}:${draft.externalId}`;
		const existing = repo.listIdsWithProperty(IMPORT_EXTERNAL_ID_PROP, externalKey)[0] ?? null;
		const properties: Record<string, unknown> = {
			...draft.properties,
			title: draft.title,
			...(draft.tags.length > 0 ? { tags: draft.tags } : {}),
			[IMPORT_EXTERNAL_ID_PROP]: externalKey,
		};
		let entityId: string;
		if (existing !== null) {
			repo.update(existing, properties, options.now);
			idByNote.set(draft.noteName, existing);
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
			idByNote.set(draft.noteName, id);
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
		if ((i + 1) % OBSIDIAN_YIELD_EVERY === 0) await Promise.resolve();
	}

	// Referenced attachments → a `File/v1` entity each (bytes sealed into the
	// encrypted AssetStore, kind Upload), idempotent on the source path so a
	// re-import re-uses the existing file rather than duplicating. Only files
	// an `![[…]]`/`[[…]]` actually references are imported (no orphan clutter).
	const assetStore = await session.assetStore();
	const bytesByPath = new Map(attachments.map((a) => [a.path, a.bytes]));
	const idByAttachment = new Map<string, string>(); // path → File/v1 id
	let filesCreated = 0;
	for (const path of plan.referencedAttachments) {
		const bytes = bytesByPath.get(path);
		if (!bytes) continue;
		const name = path.slice(path.lastIndexOf("/") + 1);
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

	// Deterministic link ids keyed on (kind, source, dest) so a re-import
	// UPSERTs the same row instead of accumulating duplicates (putLink is
	// INSERT OR REPLACE on the id), and a note referencing the same target
	// twice collapses to one relationship. Ids are opaque PK strings; `:` is
	// safe (ULID + `ent_` ids never contain it).
	const seen = new Set<string>();
	let linked = 0;
	const writeLink = (sourceId: string, destId: string, kind: ObsidianLinkKind): void => {
		const id = `ln:${kind}:${sourceId}:${destId}`;
		if (seen.has(id)) return;
		seen.add(id);
		repo.putLink({
			id,
			sourceEntityId: sourceId,
			destEntityId: destId,
			linkType: kind === ObsidianLinkKind.Embed ? OBSIDIAN_EMBED_TYPE : OBSIDIAN_LINK_TYPE,
			createdAt: options.now,
		});
		linked++;
	};
	for (const link of plan.links) {
		const sourceId = idByNote.get(link.fromNote);
		const destId = idByNote.get(link.toNote);
		if (sourceId && destId) writeLink(sourceId, destId, link.kind);
	}
	for (const link of plan.attachmentLinks) {
		const sourceId = idByNote.get(link.fromNote);
		const destId = idByAttachment.get(link.attachmentPath);
		if (sourceId && destId) writeLink(sourceId, destId, link.kind);
	}

	return { created, updated, filesCreated, linked, unresolved: plan.unresolved.length };
}
