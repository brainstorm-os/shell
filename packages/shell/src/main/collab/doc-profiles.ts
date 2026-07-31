/**
 * In-document display-profile cache (Collab-C6-b) — how a member's NAME travels
 * with the entity they are a member of.
 *
 * The `ShareInvite` carries the invitee's signed {@link ProfileSnapshot} to the
 * owner, which solves exactly one direction. The other directions (the invitee
 * seeing the OWNER, and any member seeing any OTHER member) have no invite to
 * ride, so the snapshot is also cached in the entity's own Y.Doc, alongside the
 * signed access record it decorates. That doc is already end-to-end encrypted
 * to exactly the member set, already syncs to every member, and is already
 * where membership itself lives — so names arrive with membership, with no
 * directory service, no new capability and no relay-visible plaintext.
 *
 * SHAPE: `doc.getMap("profiles")`, keyed by the member's base64 sovereign
 * Ed25519 pubkey → a {@link ProfileSnapshot}.
 *
 * SECURITY — the map is unprivileged by construction. Any doc writer can write
 * any key, so this file NEVER trusts the map's structure: every read runs
 * {@link verifyProfileSnapshot} against the KEY the entry is filed under, and a
 * failure yields nothing (the caller then renders the key fingerprint). The
 * residual power of a malicious member is therefore bounded to (a) REPLAYING a
 * genuine self-asserted snapshot of someone who really did assert it, and (b)
 * DELETING an entry, which degrades a name to a fingerprint. Neither can
 * fabricate a name for a key, and neither touches authorization — nothing in
 * the product reads this map to decide anything, only to render.
 */

import type * as Y from "yjs";
import {
	type ProfileSnapshot,
	type ResolvedProfile,
	verifyProfileSnapshot,
} from "./profile-snapshot";

/** Top-level Y.Doc key holding the per-member profile snapshots. */
export const ENTITY_PROFILES_KEY = "profiles" as const;

export function getProfilesMap(doc: Y.Doc): Y.Map<unknown> {
	return doc.getMap<unknown>(ENTITY_PROFILES_KEY);
}

/**
 * Publish `snapshot` as the profile for `pubkey`. Verifies BEFORE writing, so an
 * unverifiable snapshot never reaches the doc (and never syncs to peers who
 * would only reject it anyway). Returns true when it was written.
 *
 * Idempotent: re-publishing the identical snapshot is skipped, so a re-share
 * emits no doc delta and cannot churn the sync stream.
 */
export function publishDocProfile(
	doc: Y.Doc,
	pubkey: string,
	snapshot: ProfileSnapshot | null | undefined,
): boolean {
	if (!snapshot) return false;
	if (!verifyProfileSnapshot(pubkey, snapshot)) return false;
	const map = getProfilesMap(doc);
	const existing = map.get(pubkey);
	if (
		existing &&
		typeof existing === "object" &&
		(existing as ProfileSnapshot).sig === snapshot.sig &&
		(existing as ProfileSnapshot).displayName === snapshot.displayName &&
		(existing as ProfileSnapshot).avatarRef === snapshot.avatarRef
	) {
		return false;
	}
	map.set(pubkey, {
		displayName: snapshot.displayName,
		...(snapshot.avatarRef ? { avatarRef: snapshot.avatarRef } : {}),
		sig: snapshot.sig,
	});
	return true;
}

/** The verified profile cached in the doc for one pubkey, or null. Fail-closed:
 *  an absent, malformed or badly-signed entry is indistinguishable from none. */
export function readDocProfile(doc: Y.Doc, pubkey: string): ResolvedProfile | null {
	return verifyProfileSnapshot(pubkey, getProfilesMap(doc).get(pubkey));
}

/** Every verified profile cached in the doc, keyed by pubkey. Unverifiable
 *  entries are dropped rather than surfaced. */
export function readDocProfiles(doc: Y.Doc): Map<string, ResolvedProfile> {
	const out = new Map<string, ResolvedProfile>();
	for (const [pubkey, value] of getProfilesMap(doc).entries()) {
		const resolved = verifyProfileSnapshot(pubkey, value);
		if (resolved) out.set(pubkey, resolved);
	}
	return out;
}
