/**
 * LAN-2 — roster-verified admission for the LAN transport (crypto-aware half).
 *
 * ⚠️ NOT SHIPPABLE FROM THIS PASS. The real LAN listener + this admission gate
 * MUST pass a dedicated `/security-review` + `/pentester` before any binding to
 * a real external network interface (see `docs/data/lan-p2p-sync.md` §4). This
 * module + `lan-relay-host.ts` are the in-process / localhost proof only; the
 * external-interface bind is deliberately withheld until that review.
 *
 * Why this file is CRYPTO-AWARE and NOT named `*relay*`: the relay-blind CI
 * fence (`tools/mcp-server/src/tools/relay-noble-import-check.ts`) matches
 * `**\/sync/**\/*relay*.ts`. The blind host (`lan-relay-host.ts`) does the
 * socket/connection plumbing and calls an INJECTED `admit(...)` callback; the
 * signature-verify + roster-membership check live HERE, outside the fence,
 * exactly as `challenge-responder.ts` sits outside it for the client side.
 *
 * The design INVERTS SYNC-4b: the cloud rule is "an open node never
 * challenges"; the LAN rule is "the host ALWAYS challenges, and the client
 * verifies the host back" (mutual). Proof of admission = an Ed25519 signature
 * over the host's nonce, checked against the vault's signed device roster
 * (`meta.devices`) both paired peers already hold. No new key material, no new
 * primitive — only a roster-membership verifier.
 */

import { ed25519Verify } from "@brainstorm-os/native";
import { base64UrlToBytes } from "../pairing/pairing-channel";
import type { AuthResponse } from "./websocket-relay-port";

/** OQ-LAN-2 (LOCKED) — deterministic host election by device id: the lower
 *  device id hosts the embedded blind relay; the peer connects as guest. String
 *  enum per CLAUDE.md (no raw string discriminators). */
export enum LanRole {
	Host = "host",
	Guest = "guest",
}

/**
 * OQ-LAN-2 lock — decide this device's LAN role from the two device ids.
 * Deterministic + symmetric: both peers compute the same split, so exactly one
 * hosts with no negotiation round-trip. Lower id (lexicographic on the wire
 * account string = base64url device pubkey) hosts.
 */
export function electLanRole(selfDeviceId: string, peerDeviceId: string): LanRole {
	if (!selfDeviceId || !peerDeviceId) {
		throw new Error("electLanRole: both device ids must be non-empty");
	}
	if (selfDeviceId === peerDeviceId) {
		throw new Error("electLanRole: self and peer device ids must differ");
	}
	return selfDeviceId < peerDeviceId ? LanRole.Host : LanRole.Guest;
}

/** Placeholder token the LAN client sends in the `auth` control. LAN admission
 *  proves ROSTER MEMBERSHIP (the signed device roster), not a metered
 *  entitlement, so there is no `brainstorm-cloud` token here — the host ignores
 *  the value and verifies `account` + `sig` against the roster. Non-empty so it
 *  satisfies the existing `auth` control shape the `WebSocketRelayPort` sends. */
export const LAN_ADMISSION_TOKEN = "lan/v1";

export type LanAdmissionVerifierDeps = {
	/** Is this wire account (base64url device pubkey) in the vault's signed
	 *  device roster? Supplied by the wiring over `meta.devices` (OQ-LAN-7). */
	isRosterMember: (account: string) => boolean;
	/** Ed25519 verify. Default = native `ed25519Verify(pub, msg, sig)`. Injectable
	 *  for deterministic tests. */
	verify?: (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
};

/**
 * Build the host-side `admit(account, sig, nonce)` callback the blind
 * `LanRelayHost` invokes on a connecting peer's `auth` control. Returns true
 * ONLY when the account is a roster member AND the signature verifies over the
 * exact nonce bytes the host issued — otherwise false (the host closes the
 * socket). Fail-closed: any decode/verify throw ⇒ false.
 *
 * `account`, `sig`, `nonce` are all base64url strings on the wire; this decodes
 * them and checks `Ed25519.verify(pubkey=account, msg=nonceBytes, sig)`.
 */
export function makeLanAdmissionVerifier(
	deps: LanAdmissionVerifierDeps,
): (account: string, sig: string, nonce: string) => boolean {
	const verify = deps.verify ?? ((pub, msg, sig) => ed25519Verify(pub, msg, sig));
	return (account: string, sig: string, nonce: string): boolean => {
		try {
			if (!account || !sig || !nonce) return false;
			if (!deps.isRosterMember(account)) return false;
			const pubkey = base64UrlToBytes(account);
			const sigBytes = base64UrlToBytes(sig);
			const nonceBytes = base64UrlToBytes(nonce);
			if (pubkey.length !== 32 || sigBytes.length !== 64 || nonceBytes.length === 0) {
				return false;
			}
			return verify(pubkey, nonceBytes, sigBytes);
		} catch {
			return false;
		}
	};
}

export type LanChallengeResponderDeps = {
	/** This device's wire account (base64url identity/device pubkey), or null
	 *  when there's no open session. */
	account: () => string | null;
	/** Sign the raw nonce bytes with the device identity key, or null (no
	 *  session). The secret never leaves the closure. */
	signNonce: (nonce: Uint8Array) => Uint8Array | null;
};

/**
 * Build the CLIENT-side `onChallenge` the `WebSocketRelayPort` invokes when a
 * LAN host challenges. Signs the nonce bytes with the device key and returns
 * `{token: LAN_ADMISSION_TOKEN, account, sig}` (all base64url). Returns null
 * (stay unauthenticated) when there's no session — the host's auth deadline
 * then closes the socket and the reconnect path retries. Mirrors
 * `makeChallengeResponder` but roots proof in roster membership, not a token.
 */
export function makeLanChallengeResponder(
	deps: LanChallengeResponderDeps,
): (nonce: string) => Promise<AuthResponse | null> {
	return async (nonce: string): Promise<AuthResponse | null> => {
		const account = deps.account();
		if (!account) return null;
		let nonceBytes: Uint8Array;
		try {
			nonceBytes = base64UrlToBytes(nonce);
		} catch {
			return null;
		}
		if (nonceBytes.length === 0) return null;
		const sig = deps.signNonce(nonceBytes);
		if (!sig) return null;
		return {
			token: LAN_ADMISSION_TOKEN,
			account,
			sig: bytesToBase64Url(sig),
		};
	};
}

/** Local base64url encode — inlined to keep this module's dependency surface
 *  small (the decode we reuse from `pairing-channel`). */
function bytesToBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}
