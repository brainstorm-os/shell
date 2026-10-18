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
 *     unrelated share.
 */

import { type PendingInvite, parseInviteLink } from "@brainstorm-os/sdk-types";
import { fingerprintOf } from "../collab/profile-store";
import { inviteProfile } from "../collab/share-invite";
import { verifyInviteToken } from "./sharing-service";

export const PENDING_INVITE_TTL_MS = 10 * 60 * 1000;

export class PendingInviteSlot {
	#held: PendingInvite | null = null;

	/** Accept a deep-link URL. Returns the pending invite, or null when the
	 *  URL is not an invite link or the invite does not verify. */
	offerLink(url: unknown, now: number): PendingInvite | null {
		const token = parseInviteLink(url);
		if (!token) return null;
		const invite = verifyInviteToken(token);
		if (!invite) return null;
		let fingerprint: string;
		try {
			fingerprint = fingerprintOf(invite.userPubB64);
		} catch {
			return null;
		}
		this.#held = {
			invite: token,
			label: inviteProfile(invite)?.displayName ?? invite.label,
			fingerprint,
			receivedAt: now,
		};
		return this.#held;
	}

	/** Hand the waiting invite to its one consumer and forget it. */
	take(now: number): PendingInvite | null {
		const held = this.#held;
		this.#held = null;
		if (!held || now - held.receivedAt > PENDING_INVITE_TTL_MS) return null;
		return held;
	}

	clear(): void {
		this.#held = null;
	}
}
