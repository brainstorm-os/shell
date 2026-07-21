/**
 * Pure roster join — the merge of the authoritative pubkey roster (the entity's
 * access record) with the local user and the resolved display profiles, into the
 * `RosterMember[]` an app renders. No I/O, no crypto, no session: a pure function
 * of plain data so the merge/dedupe/ordering invariants property-test without a
 * vault (the service wrapper does the loading + signing). Per Collab-C6.
 *
 * Invariants this enforces:
 *   - Self is ALWAYS present (the vault owner is implicitly a member of their own
 *     entities, even on a never-shared channel whose access record is empty).
 *   - Every active member appears exactly once (dedupe by pubkey; a duplicate
 *     grant keeps the most-privileged role).
 *   - Silent members (granted access, never posted) are included — the roster is
 *     the access record, not the message authors.
 *   - Order: self first, then by resolved display name (case-insensitive), then
 *     by pubkey, for a stable cross-device reading order.
 */

import { type RosterMember, RosterRole } from "@brainstorm-os/sdk-types";

/** A pubkey + role drawn from the access record (already filtered to active). */
export type ActiveMemberRef = {
	pubkey: string;
	role: RosterRole;
};

/** Best-effort display resolution for one pubkey — always a fingerprint, plus a
 *  name/avatar when a profile has been seen for it. */
export type ResolvedDisplay = {
	fingerprint: string;
	displayName?: string;
	avatarRef?: string;
};

const ROLE_RANK: Readonly<Record<RosterRole, number>> = {
	[RosterRole.Viewer]: 0,
	[RosterRole.Editor]: 1,
	[RosterRole.Owner]: 2,
};

function morePrivileged(a: RosterRole, b: RosterRole): RosterRole {
	return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export function joinRoster(opts: {
	selfPubkey: string;
	active: readonly ActiveMemberRef[];
	resolve: (pubkey: string) => ResolvedDisplay;
}): RosterMember[] {
	const roles = new Map<string, RosterRole>();
	// Self is implicitly an Owner of their own entity; an explicit grant below can
	// only raise this (it is already the max), never lower it.
	roles.set(opts.selfPubkey, RosterRole.Owner);
	for (const m of opts.active) {
		const existing = roles.get(m.pubkey);
		roles.set(m.pubkey, existing ? morePrivileged(existing, m.role) : m.role);
	}

	const members: RosterMember[] = [];
	for (const [pubkey, role] of roles) {
		const display = opts.resolve(pubkey);
		members.push({
			pubkey,
			role,
			isSelf: pubkey === opts.selfPubkey,
			fingerprint: display.fingerprint,
			...(display.displayName ? { displayName: display.displayName } : {}),
			...(display.avatarRef ? { avatarRef: display.avatarRef } : {}),
		});
	}

	return members.sort((a, b) => {
		if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
		// Named members before fingerprint-only ones (a not-yet-resolved profile
		// shouldn't jump to the top of the list on an empty name).
		const aNamed = a.displayName ? 1 : 0;
		const bNamed = b.displayName ? 1 : 0;
		if (aNamed !== bNamed) return bNamed - aNamed;
		const an = (a.displayName ?? "").toLowerCase();
		const bn = (b.displayName ?? "").toLowerCase();
		return an.localeCompare(bn) || a.pubkey.localeCompare(b.pubkey);
	});
}
