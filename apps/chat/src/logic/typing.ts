/**
 * Chats-4 — the typing indicator over the presence layer (PRES-1..4).
 *
 * Typing is EPHEMERAL: it rides this device's presence payload as a
 * `PresenceActivity`, is never written to an entity, and vanishes with the
 * presence (closing the channel, the app, or the presence timeout).
 *
 * Throttling lives in the publisher: the composer only flips the activity on
 * at the first keystroke of a burst and off after {@link TYPING_IDLE_MS} of
 * quiet (or on send / channel switch), so a burst costs two publishes no
 * matter how fast the user types.
 */

import { PresenceActivity, type PresencePeer } from "@brainstorm-os/sdk/presence-stack";

export const TYPING_IDLE_MS = 4000;

/** Distinct OTHER members currently typing, first-seen order. A member's own
 *  second device typing is not "someone else typing". */
export function typingPeers(peers: readonly PresencePeer[], selfId: string): PresencePeer[] {
	const out: PresencePeer[] = [];
	const seen = new Set<string>();
	for (const p of peers) {
		if (p.activity !== PresenceActivity.Typing || p.id === selfId || seen.has(p.id)) continue;
		seen.add(p.id);
		out.push(p);
	}
	return out;
}

export const TypingLabel = {
	One: "typing.one",
	Two: "typing.two",
	Many: "typing.many",
} as const;

export type TypingLabel = (typeof TypingLabel)[keyof typeof TypingLabel];

/** Which catalog string names the typers — a list shape, not a plural. */
export function typingLabel(
	peers: readonly PresencePeer[],
): { key: TypingLabel; params: Record<string, string> } | null {
	const [a, b] = peers;
	if (!a) return null;
	if (!b) return { key: TypingLabel.One, params: { name: a.name } };
	if (peers.length === 2) return { key: TypingLabel.Two, params: { a: a.name, b: b.name } };
	return { key: TypingLabel.Many, params: {} };
}
