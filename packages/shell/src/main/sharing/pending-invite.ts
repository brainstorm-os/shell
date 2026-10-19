/**
 * Collab-C7 — the one invite a `brainstorm://invite/<token>` deep link has
 * delivered, waiting for the owner to act on it.
 *
 * NEW ATTACK SURFACE: the link comes from outside the app — any web page or
 * mail client can make the OS open one. So the slot is deliberately inert:
 *   - the token must parse strictly AND verify (a forged or malformed invite
 *     never reaches the slot);
 *   - holding it grants nothing and contacts no one. The only consumer is the
 *     share dialog, which PRE-FILLS its code field with it — the owner still
 *     picks the object, the role (defaulting to Viewer) and presses Add;
 *   - one slot, short-lived ({@link PENDING_INVITE_TTL_MS}), consumed on read,
 *     cleared on vault switch — a planted link cannot linger until some later
 *     unrelated share;
 *   - FIRST WINS: while an invite is waiting, a different link is refused
 *     ({@link InviteOfferOutcome.Busy}) rather than swapped in, so a planted
 *     link can never silently replace the one the owner meant to act on.
 */

import { type PendingInvite, parseInviteLink, sanitizeTraceText } from "@brainstorm-os/sdk-types";
import { fingerprintOf } from "../collab/profile-store";
import { inviteProfile } from "../collab/share-invite";
import { verifyInviteToken } from "./sharing-service";

export const PENDING_INVITE_TTL_MS = 10 * 60 * 1000;
export const PENDING_INVITE_LABEL_MAX = 80;

export const InviteOfferOutcome = {
	/** Parked; the share dialog will pre-fill it. */
	Held: "held",
	/** The same invite is already waiting — nothing changed. */
	Duplicate: "duplicate",
	/** A different invite is already waiting; this one was dropped. */
	Busy: "busy",
	/** Not an invite link, or it failed verification. */
	Refused: "refused",
} as const;
export type InviteOfferOutcome = (typeof InviteOfferOutcome)[keyof typeof InviteOfferOutcome];

export type InviteOffer =
	| { outcome: typeof InviteOfferOutcome.Refused; pending: null }
	| {
			outcome: Exclude<InviteOfferOutcome, typeof InviteOfferOutcome.Refused>;
			pending: PendingInvite;
	  };

const REFUSED: InviteOffer = { outcome: InviteOfferOutcome.Refused, pending: null };

/** The label is sender-chosen: strip spoofing codepoints and anything shaped
 *  like a key fingerprint, so it cannot pose as the identity printed next to it. */
export function sanitizeInviteLabel(label: unknown): string {
	return sanitizeTraceText(
		sanitizeTraceText(label, 512).replace(/ed25519\s*:\s*[0-9a-f:\s]*/gi, ""),
		PENDING_INVITE_LABEL_MAX,
	);
}

export class PendingInviteSlot {
	#held: PendingInvite | null = null;

	/** Accept a deep-link URL. See {@link InviteOfferOutcome}. */
	offerLink(url: unknown, now: number): InviteOffer {
		const token = parseInviteLink(url);
		if (!token) return REFUSED;
		const invite = verifyInviteToken(token);
		if (!invite) return REFUSED;
		let fingerprint: string;
		try {
			fingerprint = fingerprintOf(invite.userPubB64);
		} catch {
			return REFUSED;
		}
		const waiting = this.#live(now);
		if (waiting) {
			return {
				outcome: waiting.invite === token ? InviteOfferOutcome.Duplicate : InviteOfferOutcome.Busy,
				pending: waiting,
			};
		}
		this.#held = {
			invite: token,
			label: sanitizeInviteLabel(inviteProfile(invite)?.displayName ?? invite.label),
			fingerprint,
			receivedAt: now,
		};
		return { outcome: InviteOfferOutcome.Held, pending: this.#held };
	}

	/** Hand the waiting invite to its one consumer and forget it. */
	take(now: number): PendingInvite | null {
		const held = this.#live(now);
		this.#held = null;
		return held;
	}

	clear(): void {
		this.#held = null;
	}

	#live(now: number): PendingInvite | null {
		const held = this.#held;
		if (!held) return null;
		if (now - held.receivedAt > PENDING_INVITE_TTL_MS) {
			this.#held = null;
			return null;
		}
		return held;
	}
}
