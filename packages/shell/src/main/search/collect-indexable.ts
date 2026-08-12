/**
 * collect-indexable — gathers the searchable text for every indexable
 * entity so the FTS5 indexer can write it.
 *
 * Source of truth: the real `entities.db` (every first-party app writes
 * there via the shared entities service). One pass over every non-deleted
 * row, any type — this is what makes cross-app search cover Notes / Tasks /
 * Bookmarks / Calendar / Whiteboard uniformly.
 *
 * The aggregator's snapshot can't be reused directly: `noteToProjection`
 * intentionally drops `body` (Graph doesn't need body text), and search
 * does — so the collector reads the full property bag off the repo itself.
 *
 * Tolerates a throwing / absent repo (degrades to `[]`, never throws).
 */

import { ENTITY_TITLE_KEYS } from "@brainstorm-os/sdk/entity-title";
import { deriveEntityTitle } from "../entities/derive-title";
import { extractNoteBodyText } from "../entities/extract-note-text";
import { STRUCTURAL_ENTITY_TYPES } from "../entities/vault-entities-service";
import type { SharedEntitiesRepo } from "../entities/vault-entities-service";
import type { IndexableEntity } from "./search-indexer";

/** Property keys whose values are surfaced through `title`, are the rich
 *  body itself, or are structural — never folded into the flat body text.
 *  The title half is the shared chain's own key list, so a key added there
 *  can't silently start double-indexing as body text. `path` is
 *  deliberately absent: it names the object AND is worth matching on
 *  ("src/lib"). */
const NON_BODY_KEYS = new Set<string>([...ENTITY_TITLE_KEYS, "body"]);

/** Upper bound on the flat body text per entity. FTS5 copes with large
 *  rows, but a pathological property blob would bloat the index + skew
 *  bm25 ranking; clamp to a generous-but-finite window. */
const MAX_BODY_CHARS = 100_000;

/** Recursion guard for the property walk — real property bags are shallow
 *  (tags arrays, `{ value }` wrappers); anything deeper is structural noise
 *  or a cycle-shaped blob we must not chase. */
const MAX_PROPERTY_DEPTH = 4;

/** Collect every string leaf reachable inside a property value — the value
 *  itself, items of arrays (tags, multi-selects), and values of plain
 *  objects (`{ value: "…" }` wrappers, nested select options). String
 *  leaves only — never `JSON.stringify` (that would index `{}`/key noise),
 *  never numbers/booleans (matching "3" against a priority is noise). */
function collectStringLeaves(value: unknown, depth: number, out: string[]): void {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length > 0) out.push(trimmed);
		return;
	}
	if (depth >= MAX_PROPERTY_DEPTH || value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectStringLeaves(item, depth + 1, out);
		return;
	}
	for (const nested of Object.values(value as Record<string, unknown>)) {
		collectStringLeaves(nested, depth + 1, out);
	}
}

/** Rich-text `body` (Lexical JSON or string) plus every string leaf in the
 *  rest of the property bag — top-level strings, array items (tags), and
 *  nested object values — space-joined and clamped. This is what makes a
 *  Task findable by its description or tags, a Bookmark by its url, an
 *  Event by its location — without a per-type allowlist to maintain. */
function deriveBody(properties: Record<string, unknown>): string {
	const parts: string[] = [];
	const bodyText = extractNoteBodyText(properties.body);
	if (bodyText.length > 0) parts.push(bodyText);
	for (const [key, value] of Object.entries(properties)) {
		if (NON_BODY_KEYS.has(key)) continue;
		collectStringLeaves(value, 0, parts);
	}
	const joined = parts.join(" ");
	return joined.length > MAX_BODY_CHARS ? joined.slice(0, MAX_BODY_CHARS) : joined;
}

/** entities.db pass — every non-deleted row (`repo.query` already filters
 *  `deleted_at`), any type. A throwing / absent repo yields `[]` so the
 *  kv fallback still applies. */
async function collectSharedEntities(
	getEntitiesRepo: (() => Promise<SharedEntitiesRepo | null>) | undefined,
): Promise<IndexableEntity[]> {
	if (!getEntitiesRepo) return [];
	let repo: SharedEntitiesRepo | null;
	try {
		repo = await getEntitiesRepo();
	} catch {
		return [];
	}
	if (!repo) return [];
	let rows: ReturnType<SharedEntitiesRepo["query"]>;
	try {
		rows = repo.query({});
	} catch {
		return [];
	}
	const out: IndexableEntity[] = [];
	for (const row of rows) {
		if (STRUCTURAL_ENTITY_TYPES.has(row.type)) continue;
		const properties = row.properties ?? {};
		const title = deriveEntityTitle(properties);
		const body = deriveBody(properties);
		if (title.length === 0 && body.length === 0) continue;
		out.push({ entityId: row.id, type: row.type, ownerAppId: row.createdBy, title, body });
	}
	return out;
}

/**
 * Every indexable row in `entities.db`. `vaultPath` gates the rebuild (a
 * null vault means no open session → nothing to index); the rows come
 * exclusively from the shared store.
 */
export async function collectIndexableEntities(
	vaultPath: string | null,
	getEntitiesRepo?: () => Promise<SharedEntitiesRepo | null>,
): Promise<IndexableEntity[]> {
	if (!vaultPath) return [];
	return collectSharedEntities(getEntitiesRepo);
}
