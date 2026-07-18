/**
 * The Agent → Notes seam (F-241 / doc 75) — the frozen payload contract for
 * the target-addressed `insert` intent: "append this markdown at the end of
 * the named entity". Doc 17's `insert` sketch is at-selection (focused
 * editor); this is the target-addressed variant — the dispatcher names the
 * entity to insert into, and the intents bus routes on `entityType` to the
 * type's registered handler, exactly like the composer verbs.
 *
 * Shared by both sides so dispatcher and handler cannot drift:
 *   - the Agent app builds the payload with {@link buildNoteInsertPayload};
 *   - Notes parses it FAIL-CLOSED with {@link parseNoteInsertPayload} — a
 *     malformed / oversized / wrong-position payload is `null` (refused),
 *     never a best-effort write.
 *
 * SECURITY (doc 75 §Capability + security model): this module is only the
 * wire shape. The write chain is gated by the verb-scoped
 * `intents.dispatch:insert` ledger grant at the broker, the manifest
 * `(insert, entityType)` registration at the bus, and the owner-side
 * re-validation + locked-note refusal in the handler.
 */

/** The intent verb this contract rides — `ContributedVerb.Insert`'s literal,
 *  re-declared here so the payload module stays dependency-free. */
export const INSERT_INTENT_VERB = "insert";

/** Where the content lands. v1 is append-only (doc 75 §v1 scope); the enum
 *  exists so a future at-position variant extends rather than forks. */
export const InsertPosition = {
	End: "end",
} as const;
export type InsertPosition = (typeof InsertPosition)[keyof typeof InsertPosition];

/** Upper bound on the markdown payload, in UTF-16 code units. Generous for a
 *  chat reply (~64 KB) but bounded so a runaway dispatcher can't stuff
 *  megabytes into a note in one intent. Parse fails closed above it. */
export const INSERT_MARKDOWN_MAX = 65_536;

/** The target-addressed `insert` payload. `entityType` is what the intents
 *  bus routes on; `entityId` is the document the handler appends into. */
export type NoteInsertPayload = {
	/** The entity (note) to insert into. */
	entityId: string;
	/** The target's entity type — routes the dispatch to the registered
	 *  handler (Notes for `io.brainstorm.notes/Note/v1`). */
	entityType: string;
	/** v1: always `InsertPosition.End`. */
	position: InsertPosition;
	/** The content to append, as markdown (the interchange form both the
	 *  Agent renderer and the Notes editor already speak). */
	markdown: string;
};

/** Build a valid payload. Throws on an empty target or empty/oversized
 *  markdown — dispatch-side misuse is a programming error, not a runtime
 *  condition to smuggle over the wire. */
export function buildNoteInsertPayload(input: {
	entityId: string;
	entityType: string;
	markdown: string;
}): NoteInsertPayload {
	const entityId = input.entityId.trim();
	const entityType = input.entityType.trim();
	if (entityId.length === 0) throw new Error("insert payload: entityId is required");
	if (entityType.length === 0) throw new Error("insert payload: entityType is required");
	if (input.markdown.trim().length === 0) throw new Error("insert payload: markdown is empty");
	if (input.markdown.length > INSERT_MARKDOWN_MAX) {
		throw new Error(`insert payload: markdown exceeds ${INSERT_MARKDOWN_MAX} chars`);
	}
	return {
		entityId,
		entityType,
		position: InsertPosition.End,
		markdown: input.markdown,
	};
}

/**
 * Fail-closed parse of an untrusted intent payload (the handler side).
 * Returns `null` — refuse, never coerce — unless every field is present,
 * well-typed, and in bounds. `expectedEntityType`, when given, additionally
 * pins the target type (Notes passes its own Note type so a mis-routed
 * payload for another type is refused rather than appended).
 */
export function parseNoteInsertPayload(
	payload: unknown,
	expectedEntityType?: string,
): NoteInsertPayload | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const raw = payload as Record<string, unknown>;
	const entityId = nonEmptyString(raw.entityId);
	const entityType = nonEmptyString(raw.entityType);
	const markdown = nonEmptyString(raw.markdown);
	if (!entityId || !entityType || !markdown) return null;
	if (raw.position !== InsertPosition.End) return null;
	if (markdown.length > INSERT_MARKDOWN_MAX) return null;
	if (expectedEntityType !== undefined && entityType !== expectedEntityType) return null;
	return { entityId, entityType, position: InsertPosition.End, markdown };
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}
