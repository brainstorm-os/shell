/**
 * `@brainstorm-os/sdk/note-references` — the **single** cross-entity reference
 * walker over a Lexical `SerializedEditorState` note body (B6.5).
 *
 * Before this, the Notes app (`editor/extract-references.ts`, for backlinks /
 * outgoing-edge UI) and the shell main process (`entities/extract-note-
 * references.ts`, for the Graph edges + entities-service indexing) each kept
 * a byte-for-byte copy of the same recursive walk. They had to agree on the
 * persisted node shape anyway — so the walk itself belongs in one shared,
 * dependency-free module both import. Both sites now re-export from here.
 *
 * The `MentionNode` / `BlockEmbedNode` / `TransclusionNode` `type` strings and
 * the `brainstorm://entity/<id>` URI prefix are **protocol** — they're
 * persisted in note bodies on disk, so the Lexical nodes (whose `getType()`
 * returns the same literal) and this walker must agree. A Notes-side parity
 * test pins the node constants to the ones declared here.
 */

export const MENTION_NODE_TYPE = "mention" as const;
export const BLOCK_EMBED_NODE_TYPE = "block-embed" as const;
export const TRANSCLUSION_NODE_TYPE = "transclusion" as const;
/** B11.1 — the inline (text-run) counterpart to the block-level
 *  `TransclusionNode`. A distinct persisted `type` so the two don't conflate
 *  on paste, but it surfaces the **same** `NoteReferenceKind.Transclusion` edge
 *  (an inline + block transclusion of the same entity dedupe to one edge). */
export const INLINE_TRANSCLUSION_NODE_TYPE = "inline-transclusion" as const;
export const LINK_NODE_TYPE = "link" as const;
const BRAINSTORM_ENTITY_PREFIX = "brainstorm://entity/";

/** B11.13 — fragment prefix that addresses a specific block within an entity's
 *  body: `brainstorm://entity/<id>#block-<blockId>`. Kept here next to the
 *  scheme so the parser, the formatter, and the (future) "Copy link to block"
 *  affordance all agree on it. */
const BLOCK_FRAGMENT_PREFIX = "block-";

/** Max block-id length the fragment will carry — blocks use short stable ids;
 *  a longer fragment is rejected (treated as no block anchor) so a hand-edited
 *  URI can't smuggle an unbounded token. */
const MAX_BLOCK_ID_LEN = 128;

/** Hostile / malformed bodies could be deeply nested; cap recursion so a
 *  walk in the privileged main process can't overflow the stack. */
const MAX_DEPTH = 64;

export enum NoteReferenceKind {
	Mention = "mention",
	Link = "link",
	Embed = "embed",
	Transclusion = "transclusion",
}

export type NoteReference = {
	entityId: string;
	entityType: string;
	kind: NoteReferenceKind;
	/** The display label captured at insertion time (mention chips carry one);
	 *  lets a consumer denormalise a name without resolving the entity. */
	label?: string;
};

/** Clamp on the denormalised label lifted off a peer-writable body. */
const REF_LABEL_MAX_LEN = 256;

/** Walk a note body (a parsed `SerializedEditorState`, or its on-disk JSON
 *  form) and surface every cross-entity reference: `@`-mention chips, block
 *  embeds, transclusions, and `link` nodes whose `url` is a
 *  `brainstorm://entity/<id>` URI. Tolerates legacy string bodies and
 *  malformed shapes — returns `[]` rather than throwing. */
export function extractNoteReferences(body: unknown): NoteReference[] {
	if (!body || typeof body !== "object") return [];
	const root = (body as { root?: unknown }).root;
	const out: NoteReference[] = [];
	walk(root, out, 0);
	return dedupe(out);
}

const NOTE_REFERENCE_KINDS: ReadonlySet<string> = new Set<string>(Object.values(NoteReferenceKind));

/** Validate a persisted `bodyRefs` blob (e.g. read back off an entity's
 *  `properties.bodyRefs`) into typed refs. Returns `null` when the field is
 *  absent or not an array — so a caller can distinguish "no persisted refs,
 *  fall back" from `[]` ("explicitly no refs"). Drops malformed entries. */
export function coerceNoteReferences(raw: unknown): NoteReference[] | null {
	if (!Array.isArray(raw)) return null;
	const out: NoteReference[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const { entityId, kind, entityType } = item as Record<string, unknown>;
		if (typeof entityId !== "string" || entityId.length === 0) continue;
		if (typeof kind !== "string" || !NOTE_REFERENCE_KINDS.has(kind)) continue;
		out.push({
			entityId,
			kind: kind as NoteReferenceKind,
			entityType: typeof entityType === "string" ? entityType : "",
		});
	}
	return out;
}

function pushEntityRef(node: unknown, out: NoteReference[], kind: NoteReferenceKind): void {
	const ref = node as { entityId?: unknown; entityType?: unknown; label?: unknown };
	const id = typeof ref.entityId === "string" ? ref.entityId : "";
	const etype = typeof ref.entityType === "string" ? ref.entityType : "";
	const label =
		typeof ref.label === "string" && ref.label.length > 0
			? ref.label.slice(0, REF_LABEL_MAX_LEN)
			: undefined;
	if (id.length > 0)
		out.push({ entityId: id, entityType: etype, kind, ...(label ? { label } : {}) });
}

function walk(node: unknown, out: NoteReference[], depth: number): void {
	if (depth > MAX_DEPTH) return;
	if (!node || typeof node !== "object") return;
	const record = node as { type?: unknown; children?: unknown };
	const type = typeof record.type === "string" ? record.type : null;

	if (type === MENTION_NODE_TYPE) {
		pushEntityRef(node, out, NoteReferenceKind.Mention);
	} else if (type === BLOCK_EMBED_NODE_TYPE) {
		pushEntityRef(node, out, NoteReferenceKind.Embed);
	} else if (type === TRANSCLUSION_NODE_TYPE || type === INLINE_TRANSCLUSION_NODE_TYPE) {
		pushEntityRef(node, out, NoteReferenceKind.Transclusion);
	} else if (type === LINK_NODE_TYPE) {
		const link = node as { url?: unknown };
		if (typeof link.url === "string") {
			const parsed = parseBrainstormEntityUri(link.url);
			if (parsed) out.push({ ...parsed, kind: NoteReferenceKind.Link });
		}
	}

	if (Array.isArray(record.children)) {
		for (const child of record.children) walk(child, out, depth + 1);
	}
}

/** Parse a `brainstorm://entity/<id>` URI into its `entityId` (+ an optional
 *  `blockId` from a `#block-<blockId>` fragment, B11.13). A `?query` is
 *  stripped; a non-`block-` fragment is ignored (entity link, no block anchor).
 *  Returns `null` for non-matching strings (including external `https://`).
 *  `entityType` stays `""` — the scheme carries only the id; callers resolve
 *  the type. Back-compatible: existing readers ignore the new `blockId`. */
export function parseBrainstormEntityUri(
	url: string,
): { entityId: string; entityType: string; blockId?: string } | null {
	if (!url.startsWith(BRAINSTORM_ENTITY_PREFIX)) return null;
	const rest = url.slice(BRAINSTORM_ENTITY_PREFIX.length);
	if (rest.length === 0) return null;
	const hashIdx = rest.indexOf("#");
	const beforeHash = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
	const idOnly = beforeHash.split("?", 1)[0] ?? "";
	if (idOnly.length === 0) return null;
	const result: { entityId: string; entityType: string; blockId?: string } = {
		entityId: idOnly,
		entityType: "",
	};
	if (hashIdx !== -1) {
		const blockId = parseBlockFragment(rest.slice(hashIdx + 1));
		if (blockId) result.blockId = blockId;
	}
	return result;
}

/** A `#block-<blockId>` fragment → the bare blockId, or `null` for any other
 *  fragment shape (empty / wrong prefix / over-length / contains a nested
 *  `#`/`?`). */
function parseBlockFragment(fragment: string): string | null {
	if (!fragment.startsWith(BLOCK_FRAGMENT_PREFIX)) return null;
	const id = fragment.slice(BLOCK_FRAGMENT_PREFIX.length);
	if (id.length === 0 || id.length > MAX_BLOCK_ID_LEN) return null;
	if (/[#?\s]/.test(id)) return null;
	return id;
}

/** Build a `brainstorm://entity/<id>` URI, optionally anchored to a block
 *  (`#block-<blockId>`, B11.13). The single place these URIs are minted so the
 *  fragment grammar matches {@link parseBrainstormEntityUri}. A `blockId`
 *  carrying a fragment-breaking char (`#`/`?`/whitespace) or exceeding the cap
 *  is dropped — a malformed anchor degrades to the plain entity link rather
 *  than producing an unparseable URI. */
export function formatBrainstormEntityUri(entityId: string, blockId?: string | null): string {
	const base = `${BRAINSTORM_ENTITY_PREFIX}${entityId}`;
	if (!blockId || blockId.length > MAX_BLOCK_ID_LEN || /[#?\s]/.test(blockId)) return base;
	return `${base}#${BLOCK_FRAGMENT_PREFIX}${blockId}`;
}

function dedupe(refs: readonly NoteReference[]): NoteReference[] {
	const seen = new Set<string>();
	const out: NoteReference[] = [];
	for (const ref of refs) {
		const key = `${ref.kind}:${ref.entityId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ref);
	}
	return out;
}
