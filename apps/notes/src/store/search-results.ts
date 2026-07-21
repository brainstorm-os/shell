/**
 * Inline-search projection for the Notes app (9.22.3).
 *
 * The sidebar list normally sorts notes by recency. When the user types
 * in the inline search box we instead show the notes the shell's FTS5
 * index matched, in its relevance order. This module turns either a hit
 * list (production) or a raw query (preview / no search service) into the
 * ordered list of note ids the sidebar should render.
 *
 * Pure + DOM-free so the ordering / fallback logic is unit-tested in
 * isolation; the React layer only owns debounce + async plumbing.
 */

import { extractPlainText } from "@brainstorm-os/editor";
import { type RankableHit, orderByHitRank } from "@brainstorm-os/sdk";
import type { StoredNote } from "./note";

/** Note ids present in `hits`, in the index's rank order. Notes the
 *  in-memory map doesn't have (deleted since the query) are skipped. */
export function noteSearchOrder(
	notes: ReadonlyMap<string, StoredNote>,
	hits: readonly RankableHit[],
): string[] {
	return orderByHitRank([...notes.values()], hits, (n) => n.id).map((n) => n.id);
}

/** Local fallback when no search service is available — case-insensitive
 *  substring over the title and the note's plain-text body. Recency
 *  order is preserved (newest first) so the bar still feels like the
 *  list, just filtered. Empty / whitespace `text` → `[]`. */
export function localNoteOrder(notes: ReadonlyMap<string, StoredNote>, text: string): string[] {
	const needle = text.trim().toLowerCase();
	if (needle.length === 0) return [];
	return [...notes.values()]
		.filter((n) => {
			if (n.title.toLowerCase().includes(needle)) return true;
			return extractPlainText(n.body).toLowerCase().includes(needle);
		})
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.map((n) => n.id);
}
