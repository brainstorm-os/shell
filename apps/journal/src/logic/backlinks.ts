/**
 * Backlinks projection for the Journal app — given a vault snapshot
 * and a note id, return the set of notes that reference it.
 *
 * The vault-entities-service already walks each note's body via
 * `extractNoteReferences` and emits `links` rows with
 * `sourceEntityId` / `destEntityId`. This helper just filters by dest
 * and joins source entities to surface the row data the renderer
 * needs (note title + updatedAt).
 *
 * **Long-term keystone** per [[preview-drop-pattern]]: the renderer
 * never re-walks bodies; the snapshot drives the panel. When the
 * entities service ships at Stage 9.3, the snapshot shape stays the
 * same — only the source swaps from `vaultEntities.list` to
 * `entities.subscribe`. The panel keeps working.
 */

import { entityTitleOr } from "@brainstorm-os/sdk/entity-title";
import { JOURNAL_ENTRY_TYPE, NOTE_ENTITY_TYPE, type VaultSnapshot } from "../runtime";

/** What a nameless backlink row reads as. One constant — the outbound and
 *  inbound walks paint the same label for the same object. */
const UNTITLED_BACKLINK = "(untitled)";

export type Backlink = {
	sourceNoteId: string;
	/** The source entity's real object type — carried so opening the
	 *  backlink routes to the correct app (a note source opens in Notes, a
	 *  journal-entry source in Journal). */
	sourceType: string;
	title: string;
	updatedAt: number;
	linkType: string;
};

/** A backlink source is any rich-text-bodied object that can mention a
 *  journal entry — both Notes and other journal entries qualify. */
const BACKLINK_SOURCE_TYPES: ReadonlySet<string> = new Set([NOTE_ENTITY_TYPE, JOURNAL_ENTRY_TYPE]);

/** Find every note that references `noteId`. Sorted by `updatedAt`
 *  desc so the most recently-touched backlink shows first — the user's
 *  freshest thread of thought. Notes that link to themselves are
 *  filtered out (self-mentions in a body shouldn't paint as a
 *  backlink in their own entry). */
export function findBacklinks(snapshot: VaultSnapshot, noteId: string): Backlink[] {
	if (!noteId) return [];
	const entityById = new Map(snapshot.entities.map((e) => [e.id, e] as const));
	const out: Backlink[] = [];
	const seen = new Set<string>();
	for (const link of snapshot.links) {
		if (link.destEntityId !== noteId) continue;
		if (link.sourceEntityId === noteId) continue;
		if (seen.has(link.sourceEntityId)) continue;
		const source = entityById.get(link.sourceEntityId);
		if (!source) continue;
		if (!BACKLINK_SOURCE_TYPES.has(source.type)) continue;
		if (source.deletedAt !== null) continue;
		seen.add(link.sourceEntityId);
		const title = entityTitleOr(source.properties, UNTITLED_BACKLINK);
		out.push({
			sourceNoteId: source.id,
			sourceType: source.type,
			title,
			updatedAt: source.updatedAt,
			linkType: link.linkType,
		});
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

/** A link this entry points AT (9.16.10) — the outgoing counterpart to a
 *  backlink. The shell already emits a `links` row per body reference, so
 *  outgoing = links whose `sourceEntityId` is this note. Resolved to the
 *  destination entity's title + type so the panel routes opens to the right
 *  app. Self-links are dropped. */
export type OutgoingLink = {
	destNoteId: string;
	destType: string;
	title: string;
	updatedAt: number;
	linkType: string;
};

export function findOutgoingLinks(snapshot: VaultSnapshot, noteId: string): OutgoingLink[] {
	if (!noteId) return [];
	const entityById = new Map(snapshot.entities.map((e) => [e.id, e] as const));
	const out: OutgoingLink[] = [];
	const seen = new Set<string>();
	for (const link of snapshot.links) {
		if (link.sourceEntityId !== noteId) continue;
		if (link.destEntityId === noteId) continue;
		if (seen.has(link.destEntityId)) continue;
		const dest = entityById.get(link.destEntityId);
		if (!dest || dest.deletedAt !== null) continue;
		seen.add(link.destEntityId);
		const title = entityTitleOr(dest.properties, UNTITLED_BACKLINK);
		out.push({
			destNoteId: dest.id,
			destType: dest.type,
			title,
			updatedAt: dest.updatedAt,
			linkType: link.linkType,
		});
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}
