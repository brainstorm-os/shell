/**
 * Agent-9 — the Agent side of the "Draft as email…" affordance. A per-reply
 * button dispatches the existing `compose` send-intent (Mailbox-4) with the
 * assistant's text as the seed body; the shell broker re-checks
 * `intents.dispatch:compose` and the IntentsBus routes it to Mailbox's
 * composer, which opens pre-filled. User-gesture only — the Agent never sends
 * (that stays a deliberate action in the composer), so this surfaces no send
 * capability, just the compose hand-off.
 *
 * Pure + framework-free so the payload rule is unit-tested without a runtime.
 */

import { SendIntentVerb } from "@brainstorm-os/sdk-types";

/** Guard against a stray dispatch with nothing to draft — the caller already
 *  gates on a non-empty body, but a pure throw keeps misuse loud in tests. */
export function buildComposeEmailEnvelope(body: string): {
	verb: typeof SendIntentVerb.Compose;
	payload: Record<string, unknown>;
} {
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		throw new Error("buildComposeEmailEnvelope: empty body");
	}
	return {
		verb: SendIntentVerb.Compose,
		payload: { body: trimmed },
	};
}
