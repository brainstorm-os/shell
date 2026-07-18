/**
 * F-241 / doc 75 — the Agent side of the Agent → Notes seam. Pure helpers
 * behind the per-message "Add to note" affordance:
 *
 *   - {@link noteCandidates} — the searchable note list (filtered from the
 *     vault snapshot the app already holds; no new read surface);
 *   - {@link buildAddToNoteMarkdown} — the markdown that lands in the note:
 *     the reply with its bare-entity-id citation links rewritten to real
 *     `brainstorm://entity/…` links (so they work — and project graph
 *     edges — inside Notes) plus a provenance line naming the source
 *     conversation, or (link mode) just the conversation link;
 *   - {@link buildInsertIntentEnvelope} — the `(verb, payload)` pair for the
 *     cap-checked `intents.dispatch` (`intents.dispatch:insert`; the shell
 *     broker re-checks the ledger, the bus routes to Notes, Notes appends
 *     in its own sandbox — the Agent never writes note bytes).
 *
 * Pure + framework-free so every rewrite / assembly rule is unit-tested
 * without a runtime.
 */

import {
	INSERT_INTENT_VERB,
	INSERT_MARKDOWN_MAX,
	buildNoteInsertPayload,
} from "@brainstorm/sdk-types";
import { CITATION_ID_SOURCE } from "./citation-format";

/** The Note entity type the affordance targets (doc 75 v1: Notes is the one
 *  registered handler; Journal etc. are follow-ups). */
export const NOTE_ENTITY_TYPE = "io.brainstorm.notes/Note/v1";

/** What the user files into the note. */
export const AddToNoteMode = {
	/** Append the reply's content (+ a provenance link to this chat). */
	InsertReply: "insert-reply",
	/** Append just a link to this conversation. */
	LinkChat: "link-chat",
} as const;
export type AddToNoteMode = (typeof AddToNoteMode)[keyof typeof AddToNoteMode];

/** A pickable target note. */
export type NoteCandidate = { id: string; title: string };

/** Max rows the picker shows (mirrors the composer-context typeahead cap). */
export const NOTE_CANDIDATES_MAX = 8;

type SnapshotEntity = { id: string; type: string; properties: Record<string, unknown> };

function titleOf(e: SnapshotEntity): string {
	const raw = e.properties.title;
	return typeof raw === "string" ? raw.trim() : "";
}

/** Filter the vault snapshot to notes whose title matches `query`
 *  (case-insensitive substring; empty query lists the first `max`).
 *  Untitled notes are excluded — the picker needs a recognisable label. */
export function noteCandidates(
	entities: readonly SnapshotEntity[],
	query: string,
	max: number = NOTE_CANDIDATES_MAX,
): NoteCandidate[] {
	const q = query.trim().toLowerCase();
	const out: NoteCandidate[] = [];
	for (const e of entities) {
		if (e.type !== NOTE_ENTITY_TYPE) continue;
		const title = titleOf(e);
		if (!title) continue;
		if (q && !title.toLowerCase().includes(q)) continue;
		out.push({ id: e.id, title });
		if (out.length >= max) break;
	}
	return out;
}

/** `](<bare-id>)` markdown-link targets — the transcript's citation-link
 *  protocol renders `[title](<entityId>)` with a BARE id (resolved by the
 *  in-app `<Markdown>` click handler). Inside a note that link must be a
 *  real `brainstorm://entity/<id>` URI to route through the linking
 *  protocol. Ids must carry a digit (every minted id embeds a base36
 *  timestamp), mirroring `linkifyEntityRefs`' prose guard. */
const BARE_ID_LINK = new RegExp(`\\]\\((${CITATION_ID_SOURCE})\\)`, "g");

/** Rewrite bare-entity-id link targets to `brainstorm://entity/…` URIs.
 *  Links that already carry a scheme (`https://…`, `brainstorm://…`) don't
 *  match the id shape and pass through untouched. */
export function rewriteCitationLinksForNote(markdown: string): string {
	return markdown.replace(BARE_ID_LINK, (match, id: string) =>
		/[0-9]/.test(id) ? `](brainstorm://entity/${id})` : match,
	);
}

/** `brainstorm://entity/<id>` markdown link for a conversation. Bracket
 *  characters in the title are stripped so the label can't break out of the
 *  link syntax. */
function conversationLink(conversationId: string, conversationTitle: string): string {
	const label = conversationTitle.replace(/[[\]()]/g, "").trim() || conversationId;
	return `[${label}](brainstorm://entity/${conversationId})`;
}

/**
 * Assemble the markdown the `insert` intent carries. Insert mode = the
 * rewritten reply + an em-dash provenance line linking the source
 * conversation (doc 75 — the write stays attributable at rest); link mode =
 * just the conversation link. Clamped to the wire bound so the payload
 * builder can never throw on size.
 */
export function buildAddToNoteMarkdown(input: {
	mode: AddToNoteMode;
	replyMarkdown: string;
	conversationId: string;
	conversationTitle: string;
}): string {
	const link = conversationLink(input.conversationId, input.conversationTitle);
	if (input.mode === AddToNoteMode.LinkChat) return link;
	const body = rewriteCitationLinksForNote(input.replyMarkdown.trim());
	const suffix = `\n\n— ${link}`;
	const budget = INSERT_MARKDOWN_MAX - suffix.length;
	const clamped = body.length > budget ? `${body.slice(0, budget - 1)}…` : body;
	return `${clamped}${suffix}`;
}

/** The dispatch-ready envelope. Throws on an empty note id / markdown —
 *  caller misuse, not a runtime state. */
export function buildInsertIntentEnvelope(
	noteId: string,
	markdown: string,
): { verb: typeof INSERT_INTENT_VERB; payload: Record<string, unknown> } {
	return {
		verb: INSERT_INTENT_VERB,
		payload: buildNoteInsertPayload({
			entityId: noteId,
			entityType: NOTE_ENTITY_TYPE,
			markdown,
		}),
	};
}
