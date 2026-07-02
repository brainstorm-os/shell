/**
 * Agent-4 — broker-assembled hybrid retrieval + cited-answer link descriptors.
 *
 * The Agent app has NO `entities.read:*` (Agent-1's design note: "the broker
 * assembles retrieval"). So grounding rides the capability-gated `search`
 * service ONLY: on a user turn the app calls `services.search.hybrid(...)`
 * (RRF lexical+semantic fusion, Stage 11 / 9.22) over the user's query, then
 * injects a compact, BOUNDED context block (id + title + snippet per hit) into
 * the model's instruction region so it can ground its answer and cite REAL
 * vault-object ids. The model returns those ids in its `{"final", "citations"}`
 * protocol; the UI renders them as clickable links labelled by the entity's
 * title and opens each via the SAME cap-checked `open` intent Agent-3 wired.
 *
 * Everything here is pure + deterministic — no React, no DOM, no SDK runtime —
 * so the bounded / fail-soft behaviour is unit-testable in isolation.
 */

import type { SearchHit, SearchQuery, SearchService } from "@brainstorm/sdk-types";
import { formatCitationLine } from "./citation-format";

/** Top-K hits fetched per turn — bounds both the search cost and the number of
 *  ids the model can ground/cite against. */
export const RETRIEVAL_TOP_K = 6;

/** Hard ceiling on a single hit's snippet length injected into the context
 *  block, so a pathological note body can't blow up the prompt. */
export const RETRIEVAL_SNIPPET_MAX = 220;

/** A retrieved vault object, reduced to exactly what grounding + citation
 *  rendering need (id + title + a short snippet). Derived from a `SearchHit`. */
export type RetrievalContextItem = {
	entityId: string;
	type: string;
	title: string;
	snippet: string;
};

/** FTS5 snippets wrap matched tokens in `<mark>…</mark>`; strip the markup and
 *  collapse whitespace so the model (and any future plain-text render) sees a
 *  clean excerpt. */
function plainSnippet(snippet: string): string {
	return snippet
		.replace(/<\/?mark>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Truncate to a bound, appending an ellipsis when cut. */
function clamp(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Reduce raw `SearchHit`s to bounded {@link RetrievalContextItem}s: take the
 *  top-K (the service already orders by fused rank), strip + clamp the snippet.
 *  Pure — the fetch + fail-soft wrapper is {@link retrieveContext}. */
export function hitsToContextItems(
	hits: readonly SearchHit[],
	topK: number = RETRIEVAL_TOP_K,
): RetrievalContextItem[] {
	return hits.slice(0, Math.max(0, topK)).map((hit) => ({
		entityId: hit.entityId,
		type: hit.type,
		title: hit.title,
		snippet: clamp(plainSnippet(hit.snippet), RETRIEVAL_SNIPPET_MAX),
	}));
}

/**
 * Render the retrieval context items as a compact instruction block appended to
 * the agent's system region. Empty items → empty string (the caller appends
 * nothing, so an empty/failed search degrades to ungrounded chat). Each line
 * carries the entity id so the model can cite it verbatim in its `citations`.
 */
export function buildRetrievalContextBlock(items: readonly RetrievalContextItem[]): string {
	if (items.length === 0) return "";
	const lines = ["Relevant objects from the user's vault (cite the ones you use by their id):"];
	for (const item of items) {
		const title = item.title.trim() || item.entityId;
		const snippet = item.snippet ? ` — ${item.snippet}` : "";
		lines.push(formatCitationLine(item.entityId, `${title}${snippet}`));
	}
	return lines.join("\n");
}

/** Append a non-empty retrieval block to a base instruction, separated by a
 *  blank line. A blank block leaves the instruction untouched. */
export function withRetrievalContext(baseInstructions: string, block: string): string {
	return block ? `${baseInstructions}\n\n${block}` : baseInstructions;
}

/**
 * Broker-assembled retrieval, fail-soft. Runs `search.hybrid` over the query
 * and reduces to bounded context items. ANY failure (no service, throw, empty
 * query) resolves to `[]` so the turn degrades to ungrounded chat rather than
 * crashing — retrieval is grounding, never a hard dependency.
 *
 * SECURITY: the only vault access is through the capability-gated `search`
 * service; the app holds no `entities.read:*`.
 */
export async function retrieveContext(
	search: SearchService | null | undefined,
	query: string,
	topK: number = RETRIEVAL_TOP_K,
	excludeTypes: readonly string[] = [],
): Promise<RetrievalContextItem[]> {
	const text = query.trim();
	if (!search || !text) return [];
	const q: SearchQuery = {
		text,
		limit: topK,
		...(excludeTypes.length > 0 ? { excludeTypes } : {}),
	};
	try {
		const hits = await search.hybrid(q);
		return hitsToContextItems(hits, topK);
	} catch (error) {
		console.warn("[agent] hybrid retrieval failed; answering ungrounded:", error);
		return [];
	}
}

// ─── Cited answers → clickable link descriptors ──────────────────────────────

/** A citation rendered as a clickable vault-object link: the entity id plus the
 *  title to label it. The UI opens `entityId` via the cap-checked `open`
 *  intent (Agent-3's path); the label is resolved from the turn's retrieval
 *  hits, falling back to the id when the title is unknown. */
export type CitationLink = {
	entityId: string;
	label: string;
};

/**
 * Map a turn's citation ids to link descriptors, labelling each by its title
 * from a id→title map (the retrieval hits the same turn fetched). Bounded +
 * deduplicated: blank ids dropped, duplicates collapsed (first wins), order
 * preserved. An id with no known title falls back to the id as its own label,
 * so a citation always renders a clickable link.
 */
export function citationsToLinks(
	citations: readonly string[] | null | undefined,
	titleById: ReadonlyMap<string, string>,
): CitationLink[] {
	if (!citations || citations.length === 0) return [];
	const seen = new Set<string>();
	const links: CitationLink[] = [];
	for (const raw of citations) {
		const entityId = typeof raw === "string" ? raw.trim() : "";
		if (!entityId || seen.has(entityId)) continue;
		seen.add(entityId);
		const title = titleById.get(entityId)?.trim();
		links.push({ entityId, label: title && title.length > 0 ? title : entityId });
	}
	return links;
}

/** Build the id→title map a turn's citations resolve against, from its
 *  retrieval items. */
export function titleMapFromItems(items: readonly RetrievalContextItem[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const item of items) {
		const title = item.title.trim();
		if (title) map.set(item.entityId, title);
	}
	return map;
}
