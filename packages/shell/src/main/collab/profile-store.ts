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
import { base64ToBytes, bytesToBase64 } from "../credentials/crypto";
import {
	fingerprintPublicKey,
	publicKeyFromBase64,
	verifySignature,
} from "../credentials/identity";
import { EntitiesRepository } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";

/** The shell-owned display-profile entity type. */
export const PROFILE_TYPE = "brainstorm/Profile/v1";

/** `created_by` stamp for the shell-provisioned profile entity (not any app). */
const PROFILE_ACTOR = "brainstorm.shell";

/** Bump only on a wire-incompatible change to the signed payload construction. */
const PROFILE_SIG_VERSION = 1 as const;

const encoder = new TextEncoder();

/** The resolved, signature-checked profile for one pubkey. */
export type ResolvedProfile = {
	pubkey: string;
	displayName: string;
	avatarRef: string | null;
	/** The self-asserted name+avatar signature verified under `pubkey`. */
	verified: boolean;
};

export const DISPLAY_NAME_MAX = 60;

/** Trim, collapse inner whitespace, strip C0/C1/DEL control chars, clamp. Mirrors
 *  the chat-side sanitiser; the codepoint filter keeps biome's
 *  `noControlCharactersInRegex` happy without a suppression. */
export function sanitizeDisplayName(raw: string): string {
	let out = "";
	for (const ch of raw) {
		const code = ch.codePointAt(0) ?? 0;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : ch;
	}
	return out.replace(/\s+/g, " ").trim().slice(0, DISPLAY_NAME_MAX);
}

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

/** Deterministic signed bytes for a profile. Binds scheme version + pubkey so the
 *  name+avatar can't be lifted onto another identity. */
function profilePayload(pubkey: string, displayName: string, avatarRef: string): Uint8Array {
	return encoder.encode(
		`brainstorm/profile/v${PROFILE_SIG_VERSION}|${pubkey}|${displayName}|${avatarRef}`,
	);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Verify + shape a raw profile-entity properties blob for `pubkey`. A tampered
 *  name/avatar (or a missing signature) resolves `verified: false` but still
 *  returns the stored fields — the consumer decides how much to trust an
 *  unverified self-asserted name. */
export function resolveProfileProperties(
	pubkey: string,
	properties: Record<string, unknown>,
): ResolvedProfile {
	const displayName = sanitizeDisplayName(str(properties.displayName));
	const avatarRefRaw = str(properties.avatarRef);
	const avatarRef = avatarRefRaw.length > 0 ? avatarRefRaw : null;
	const sig = str(properties.sig);
	let verified = false;
	if (sig.length > 0) {
		try {
			verified = verifySignature(
				publicKeyFromBase64(pubkey),
				profilePayload(pubkey, displayName, avatarRef ?? ""),
				base64ToBytes(sig),
			);
		} catch {
			verified = false;
		}
	}
	return { pubkey, displayName, avatarRef, verified };
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

/** The `ed25519:<hex>` short fingerprint for a base64 pubkey. */
export function fingerprintOf(pubkeyBase64: string): string {
	return fingerprintPublicKey(publicKeyFromBase64(pubkeyBase64));
}
