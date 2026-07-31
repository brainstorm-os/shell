/**
 * Self-asserted display profile — the human-facing identity layer (Collab-C6).
 *
 * The access record (access-record.ts) keys membership on raw sovereign Ed25519
 * pubkeys; a pubkey can't render in a member list. Each identity therefore
 * publishes a `Profile/v1` entity — a singleton in its own vault carrying
 * `{ displayName, avatarRef?, pubkey, sig }`, signed by the sovereign key. The
 * pubkey stays the sole identity; the name is a self-asserted hint a collaborator
 * can verify (the signature binds name+avatar to the pubkey) and override with a
 * local petname. Per §Self-asserted
 * display profile.
 *
 * The entity id is derived deterministically from the pubkey, so a second device
 * of the same identity edits the *same* entity (one master copy that syncs across
 * the user's own devices, never two racing singletons — OQ-ID-1).
 *
 * Signing happens here, in the main process — the sovereign secret never crosses
 * IPC (the crypto-routing invariant). Apps reach this only through the
 * capability-gated `roster` service.
 */

import { sha256 } from "@brainstorm-os/native";
import { bytesToBase64 } from "../credentials/crypto";
import { fingerprintPublicKey, publicKeyFromBase64 } from "../credentials/identity";
import { EntitiesRepository } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";
import {
	type ProfileSnapshot,
	type ResolvedProfile,
	isProfileSnapshot,
	profilePayload,
	resolveProfileProperties,
	sanitizeDisplayName,
	verifyProfileSnapshot,
} from "./profile-snapshot";

export {
	DISPLAY_NAME_MAX,
	type ProfileSnapshot,
	type ResolvedProfile,
	resolveProfileProperties,
	sanitizeDisplayName,
	verifyProfileSnapshot,
} from "./profile-snapshot";

/** The shell-owned display-profile entity type. */
export const PROFILE_TYPE = "brainstorm/Profile/v1";

/** `created_by` stamp for the shell-provisioned profile entity (not any app). */
const PROFILE_ACTOR = "brainstorm.shell";

/** Deterministic, opaque singleton id for an identity's profile — a hash of the
 *  pubkey so every device of that identity writes the same entity (idempotent,
 *  CRDT-merge-safe). Entity ids are local opaque strings, so a derived constant
 *  is a valid id. */
export function profileEntityId(pubkeyBase64: string): string {
	const digest = sha256(publicKeyFromBase64(pubkeyBase64));
	const hex = Array.from(digest)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `brainstorm/profile/${hex}`;
}

/** Read the live, signature-checked profile for one pubkey from `entities.db`,
 *  or null when no profile entity exists for it yet. */
export function readProfile(
	repo: EntitiesRepository,
	pubkeyBase64: string,
): ResolvedProfile | null {
	const row = repo.get(profileEntityId(pubkeyBase64));
	if (!row || row.type !== PROFILE_TYPE) return null;
	return resolveProfileProperties(pubkeyBase64, row.properties);
}

/** The local user's own profile (or a default empty one when unset). */
export async function readSelfProfile(session: VaultSession): Promise<ResolvedProfile> {
	const db = await session.dataStores.open("entities");
	const repo = new EntitiesRepository(db);
	const pubkey = session.identity.publicKeyBase64;
	return readProfile(repo, pubkey) ?? { pubkey, displayName: "", avatarRef: null, verified: true };
}

/** Sign + upsert the local user's display profile. The signature is minted in
 *  this process under the sovereign key for the session's OWN pubkey, so a caller
 *  can never write another identity's profile. Returns the stored, re-resolved
 *  profile. */
export async function writeSelfProfile(
	session: VaultSession,
	input: { displayName: string; avatarRef?: string | null },
	now: number = Date.now(),
): Promise<ResolvedProfile> {
	const pubkey = session.identity.publicKeyBase64;
	const displayName = sanitizeDisplayName(input.displayName);
	const avatarRef = input.avatarRef && input.avatarRef.length > 0 ? input.avatarRef : null;
	const sig = bytesToBase64(
		session.signPayload(profilePayload(pubkey, displayName, avatarRef ?? "")),
	);
	const properties: Record<string, unknown> = {
		pubkey,
		displayName,
		sig,
		updatedAt: now,
		...(avatarRef ? { avatarRef } : {}),
	};
	const db = await session.dataStores.open("entities");
	const repo = new EntitiesRepository(db);
	const id = profileEntityId(pubkey);
	if (repo.get(id)) {
		// Replace wholesale rather than shallow-merge so clearing the avatar (now
		// absent from `properties`) doesn't leave a stale `avatarRef` behind.
		repo.update(id, { ...properties, avatarRef: avatarRef ?? null }, now);
	} else {
		repo.create({ id, type: PROFILE_TYPE, properties, createdBy: PROFILE_ACTOR, now, dekId: null });
	}
	return { pubkey, displayName, avatarRef, verified: true };
}

/**
 * The local user's OWN profile as a portable {@link ProfileSnapshot}, or `null`
 * when they have not set a display name yet (Collab-C6-b).
 *
 * The stored `sig` is reused verbatim rather than re-minted, so what rides an
 * invite is byte-identical to what the profile entity holds — a recipient that
 * later receives the same identity's profile through another channel sees one
 * consistent, verifiable assertion.
 */
export async function readSelfProfileSnapshot(
	session: VaultSession,
): Promise<ProfileSnapshot | null> {
	const db = await session.dataStores.open("entities");
	const repo = new EntitiesRepository(db);
	const pubkey = session.identity.publicKeyBase64;
	const row = repo.get(profileEntityId(pubkey));
	if (!row || row.type !== PROFILE_TYPE) return null;
	const props = row.properties;
	const snapshot = {
		displayName: typeof props.displayName === "string" ? props.displayName : "",
		...(typeof props.avatarRef === "string" && props.avatarRef.length > 0
			? { avatarRef: props.avatarRef }
			: {}),
		sig: typeof props.sig === "string" ? props.sig : "",
	};
	if (!isProfileSnapshot(snapshot)) return null;
	// Round-trip through the same verifier a peer will run: never distribute a
	// snapshot our own consumers would reject.
	return verifyProfileSnapshot(pubkey, snapshot) ? snapshot : null;
}

/**
 * Cache a REMOTE identity's verified profile snapshot into `entities.db`, so
 * `readProfile` resolves it forever after (Collab-C6-b). Returns the resolved
 * profile, or `null` when the snapshot does not verify under `pubkey`.
 *
 * SECURITY: fail-closed on verification, and it refuses to touch the LOCAL
 * user's own profile row — the only writer of self is `writeSelfProfile`, so a
 * replayed or stale snapshot of yourself can never clobber what you set in
 * Settings.
 */
export async function cacheRemoteProfile(
	session: VaultSession,
	pubkey: string,
	snapshot: unknown,
	now: number = Date.now(),
): Promise<ResolvedProfile | null> {
	if (pubkey === session.identity.publicKeyBase64) return null;
	const resolved = verifyProfileSnapshot(pubkey, snapshot);
	if (!resolved) return null;
	const properties: Record<string, unknown> = {
		pubkey,
		displayName: resolved.displayName,
		sig: (snapshot as ProfileSnapshot).sig,
		updatedAt: now,
		...(resolved.avatarRef ? { avatarRef: resolved.avatarRef } : {}),
	};
	const db = await session.dataStores.open("entities");
	const repo = new EntitiesRepository(db);
	const id = profileEntityId(pubkey);
	if (repo.get(id)) {
		repo.update(id, { ...properties, avatarRef: resolved.avatarRef ?? null }, now);
	} else {
		repo.create({ id, type: PROFILE_TYPE, properties, createdBy: PROFILE_ACTOR, now, dekId: null });
	}
	return resolved;
}

/** The `ed25519:<hex>` short fingerprint for a base64 pubkey. */
export function fingerprintOf(pubkeyBase64: string): string {
	return fingerprintPublicKey(publicKeyFromBase64(pubkeyBase64));
}
