/**
 * The signed, portable `Profile/v1` snapshot (Collab-C6-b) — the unit of
 * cross-identity display-profile distribution.
 *
 * `profile-store.ts` (C6-a) stores each identity's self-asserted profile as an
 * entity in ITS OWN vault, which is why `readProfile` can only ever resolve the
 * local user: nothing carries a *remote* identity's profile across the vault
 * boundary. A snapshot is that carrier — `{displayName, avatarRef?, sig}`, where
 * `sig` is the SAME Ed25519 signature the profile entity stores, minted by the
 * sovereign key over a payload that pins the scheme version AND the pubkey.
 *
 * TRUST MODEL — a snapshot is a CLAIM, never an identity.
 *   - The pubkey remains the sole identity. A snapshot only ever decorates a
 *     pubkey a caller already holds; it can never introduce or rename one.
 *   - `verifyProfileSnapshot` is the ONLY way to turn a snapshot into a
 *     displayable name, and it fails closed: a bad/absent signature, a payload
 *     minted for a different pubkey, or undecodable base64 all resolve to
 *     `null` — the consumer then renders the key fingerprint. So an attacker
 *     cannot forge a name for a key they do not hold; the worst they can do is
 *     REPLAY a genuine self-asserted snapshot, or STRIP one (which degrades to
 *     a fingerprint, the safe direction).
 *   - A verified name is still SELF-ASSERTED: it proves "the holder of this key
 *     calls themselves X", not that X is who they say they are. Consumers must
 *     keep the key fingerprint reachable next to the name and must never let a
 *     name stand in for a key in an authorization decision.
 *
 * Pure: no session, no database, no Y.Doc — so `share-invite.ts` (the wire
 * carrier), `doc-profiles.ts` (the in-doc cache) and `profile-store.ts` (the
 * local entity) can all share one signed-payload construction without a
 * layering cycle.
 */

import { base64ToBytes, bytesToBase64 } from "../credentials/crypto";
import { publicKeyFromBase64, verifySignature } from "../credentials/identity";

/** Bump only on a wire-incompatible change to the signed payload construction. */
export const PROFILE_SIG_VERSION = 1 as const;

export const DISPLAY_NAME_MAX = 60;

const encoder = new TextEncoder();

/** The resolved, signature-checked profile for one pubkey. */
export type ResolvedProfile = {
	pubkey: string;
	displayName: string;
	avatarRef: string | null;
	/** The self-asserted name+avatar signature verified under `pubkey`. */
	verified: boolean;
};

/**
 * A portable, self-signed display profile for ONE identity. Carries its own
 * signature, so it stays verifiable after being detached from whatever
 * transported it (an invite token, an access record, an awareness frame) — the
 * carrier's own integrity is never what makes the name trustworthy.
 */
export type ProfileSnapshot = {
	displayName: string;
	avatarRef?: string;
	/** base64 Ed25519 signature by the profile's pubkey over {@link profilePayload}. */
	sig: string;
};

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

/** Deterministic signed bytes for a profile. Binds scheme version + pubkey so the
 *  name+avatar can't be lifted onto another identity. */
export function profilePayload(pubkey: string, displayName: string, avatarRef: string): Uint8Array {
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

/** Structural type guard — shape only, no crypto. */
export function isProfileSnapshot(value: unknown): value is ProfileSnapshot {
	if (!value || typeof value !== "object") return false;
	const s = value as Partial<ProfileSnapshot>;
	return (
		typeof s.displayName === "string" &&
		typeof s.sig === "string" &&
		(s.avatarRef === undefined || typeof s.avatarRef === "string")
	);
}

/**
 * Turn a snapshot into a displayable profile for `pubkey`, or `null`.
 *
 * FAIL-CLOSED — the security boundary of C6-b. Returns `null` (never a partial
 * or unverified profile) when the shape is wrong, the display name sanitises to
 * empty, or the signature does not verify under `pubkey`. Callers therefore
 * cannot accidentally display an unverified name: there is no unverified value
 * to display.
 */
export function verifyProfileSnapshot(pubkey: string, snapshot: unknown): ResolvedProfile | null {
	if (!isProfileSnapshot(snapshot)) return null;
	const resolved = resolveProfileProperties(pubkey, {
		displayName: snapshot.displayName,
		...(snapshot.avatarRef ? { avatarRef: snapshot.avatarRef } : {}),
		sig: snapshot.sig,
	});
	if (!resolved.verified || resolved.displayName.length === 0) return null;
	return resolved;
}

/** Mint a snapshot from a signing closure (the sovereign secret never leaves the
 *  session). Returns `null` for an empty display name — an identity with no
 *  self-asserted name has nothing to distribute, and an empty snapshot would
 *  only ever overwrite a better one. */
export function signProfileSnapshot(opts: {
	pubkey: string;
	displayName: string;
	avatarRef?: string | null;
	sign: (payload: Uint8Array) => Uint8Array;
}): ProfileSnapshot | null {
	const displayName = sanitizeDisplayName(opts.displayName);
	if (displayName.length === 0) return null;
	const avatarRef = opts.avatarRef && opts.avatarRef.length > 0 ? opts.avatarRef : null;
	const sig = bytesToBase64(opts.sign(profilePayload(opts.pubkey, displayName, avatarRef ?? "")));
	return { displayName, ...(avatarRef ? { avatarRef } : {}), sig };
}
