/**
 * F-241 / doc 75 — the handler side of the Agent → Notes seam. An `insert`
 * intent arrives over the running-window `app:intent` push or the cold-launch
 * `launch.reason === "intent"` context; this module turns the untrusted
 * envelope into a validated append request, FAIL-CLOSED at every step:
 *
 *   1. wrong verb → not ours (`null`, caller ignores);
 *   2. malformed / oversized / wrong-type payload → `Refused` (the shared
 *      `parseNoteInsertPayload` contract pins shape + bounds + entity type);
 *   3. unknown target note → `Refused` (insert never creates);
 *   4. locked target note → `Refused` (the page lock is advisory for humans,
 *      but a programmatic write path respects it strictly).
 *
 * Pure + framework-free so the refusal matrix is unit-tested without a shell.
 */

import { INSERT_INTENT_VERB, parseNoteInsertPayload } from "@brainstorm/sdk-types";
import { NOTE_TYPE } from "../store/entities-repository";

/** Why an `insert` intent was refused — drives the localized notice. */
export const InsertRefusal = {
	/** Payload failed the fail-closed contract parse (shape/bounds/type). */
	Malformed: "malformed",
	/** The target note does not exist in this vault (insert never creates). */
	UnknownNote: "unknown-note",
	/** The target note is locked (`properties.locked`). */
	Locked: "locked",
} as const;
export type InsertRefusal = (typeof InsertRefusal)[keyof typeof InsertRefusal];

export type InsertDecision =
	| { kind: "accept"; noteId: string; markdown: string }
	| { kind: "refuse"; refusal: InsertRefusal };

/**
 * Decide an inbound intent. Returns `null` for a non-`insert` verb (not this
 * module's intent — the caller's other verb handlers run). `hasNote` /
 * `isLocked` are injected so the decision stays pure over the live store.
 */
export function decideInsertIntent(
	verb: string,
	payload: Record<string, unknown> | undefined,
	store: { hasNote: (id: string) => boolean; isLocked: (id: string) => boolean },
): InsertDecision | null {
	if (verb !== INSERT_INTENT_VERB) return null;
	const parsed = parseNoteInsertPayload(payload ?? null, NOTE_TYPE);
	if (!parsed) return { kind: "refuse", refusal: InsertRefusal.Malformed };
	if (!store.hasNote(parsed.entityId)) {
		return { kind: "refuse", refusal: InsertRefusal.UnknownNote };
	}
	if (store.isLocked(parsed.entityId)) {
		return { kind: "refuse", refusal: InsertRefusal.Locked };
	}
	return { kind: "accept", noteId: parsed.entityId, markdown: parsed.markdown };
}

/** The i18n key for a refusal notice. Key set lives in `i18n/t.ts`. */
export function refusalNoticeKey(refusal: InsertRefusal): string {
	switch (refusal) {
		case InsertRefusal.UnknownNote:
			return "notes.insert.refused.unknownNote";
		case InsertRefusal.Locked:
			return "notes.insert.refused.locked";
		default:
			return "notes.insert.refused.malformed";
	}
}
