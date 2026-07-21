/**
 * Mention notifier (Collab-C6) — turns a just-created mention-bearing entity into
 * a "you were mentioned" notification for the local user.
 *
 * A mention targets a sovereign pubkey (`RosterMember.pubkey`): a chat
 * `Message/v1` carries `Person` attachments (`ref` = pubkey); a `Comment/v1`
 * carries a `mentions: string[]` of pubkeys. When an entity mentioning the local
 * user's pubkey is created — and the author is NOT the local user — we post a
 * notification.
 *
 * Local-vs-sync reality: every entity created *on this device* is authored by the
 * local identity, so `shouldNotify` self-suppresses and nothing fires for your
 * own messages. The notification lights up when (a) an agent/other participant
 * authors a message mentioning you (the author pubkey differs — verifiable today),
 * and (b) a collaborator's mention arrives over the relay once channels/comments
 * sync cross-vault (Collab-C5). The extraction + decision below are the reusable
 * core both paths call; the wiring sits on the entities create-wrap.
 */

import { AttachmentKind, SenderKind } from "@brainstorm-os/sdk-types";

/** The Message/Comment substrate type urls (kept here so the wiring has one
 *  literal home and never drifts from the apps). */
export const MESSAGE_TYPE_URL = "brainstorm/Message/v1";
export const COMMENT_TYPE_URL = "brainstorm/Comment/v1";

export type MentionTargets = {
	/** Sovereign pubkeys mentioned in the entity (deduped, order-preserving). */
	mentioned: string[];
	/** The author's sovereign pubkey, or null when it can't be determined (e.g.
	 *  an AI-authored message — a null author is treated as "not you", so a
	 *  mention of you still notifies). */
	author: string | null;
	/** A human label for the author, for the notification body. */
	authorName: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Extract the mention targets + author from a Message/Comment property bag.
 *  Returns null for any other type (the caller skips). */
export function mentionTargets(
	entityType: string,
	properties: Record<string, unknown>,
): MentionTargets | null {
	if (entityType === MESSAGE_TYPE_URL) {
		const mentioned: string[] = [];
		const seen = new Set<string>();
		const attachments = Array.isArray(properties.attachments) ? properties.attachments : [];
		for (const raw of attachments) {
			const att = asRecord(raw);
			if (!att || att.kind !== AttachmentKind.Person) continue;
			const ref = str(att.ref);
			if (ref && !seen.has(ref)) {
				seen.add(ref);
				mentioned.push(ref);
			}
		}
		const sender = asRecord(properties.sender);
		// Only a human participant has a sovereign pubkey author; an agent/system
		// sender has none (→ null author, so a mention of you still notifies).
		const author =
			sender && sender.kind === SenderKind.Participant ? str(sender.personRef) || null : null;
		const authorName = sender ? str(sender.displayName) : "";
		return { mentioned, author, authorName };
	}
	if (entityType === COMMENT_TYPE_URL) {
		const mentioned: string[] = [];
		const seen = new Set<string>();
		const list = Array.isArray(properties.mentions) ? properties.mentions : [];
		for (const raw of list) {
			const ref = str(raw);
			if (ref && !seen.has(ref)) {
				seen.add(ref);
				mentioned.push(ref);
			}
		}
		const author = str(properties.authorPubkey) || null;
		const authorName = str(properties.authorName);
		return { mentioned, author, authorName };
	}
	return null;
}

/** Should the local user (`selfPubkey`) be notified of this mention? True when
 *  they are among the mentioned AND they are not the author (you never notify
 *  yourself). */
export function shouldNotify(targets: MentionTargets, selfPubkey: string): boolean {
	if (!selfPubkey) return false;
	if (targets.author === selfPubkey) return false;
	return targets.mentioned.includes(selfPubkey);
}
