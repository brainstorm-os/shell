/**
 * SYNC-4b — the client half of the gated-admission handshake.
 *
 * The `WebSocketRelayPort` is relay-blind (no crypto/credential imports — the
 * `relay-noble-import-check` CI fence enforces it on `sync/*relay*.ts`), so it
 * delegates the challenge response to this injected callback. This module IS
 * credential-aware (it signs with the device identity key and reads the cached
 * entitlement token) — the same posture as the collab bridge's sealing side,
 * and it is deliberately NOT named `*relay*` so it sits outside the fence.
 *
 * Given the server's nonce, it returns `{token, account, sig}`:
 *   - `account` = the device's wire `sender` = base64url(identity pubkey);
 *   - `sig`     = Ed25519(identity key, raw nonce bytes) — proves control of
 *                 that account so the node scopes the catalog/emission to it;
 *   - `token`   = the cached `brainstorm-cloud` entitlement token.
 *
 * Returns null (stay unauthenticated) when there's no open vault session or no
 * cached token — which is the v1 state (managed/gated sync rides 14.3's token
 * refresh; an open node never challenges anyway).
 */

import { CHALLENGE_NONCE_BYTES } from "./lan-admission";
import type { AuthResponse } from "./websocket-relay-port";

export type ChallengeResponderDeps = {
	/** The device's wire account (base64url identity pubkey), or null (no session). */
	account: () => string | null;
	/** Sign the raw nonce bytes with the device identity key, or null (no session). */
	signNonce: (nonce: Uint8Array) => Uint8Array | null;
	/** The cached entitlement token, or null when none is cached (v1 default). */
	loadToken: () => Promise<string | null> | string | null;
};

function b64urlDecode(s: string): Uint8Array {
	return new Uint8Array(Buffer.from(s, "base64url"));
}

function b64urlEncode(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** Build the `onChallenge` callback the `WebSocketRelayPort` invokes. */
export function makeChallengeResponder(
	deps: ChallengeResponderDeps,
): (nonce: string) => Promise<AuthResponse | null> {
	return async (nonce: string): Promise<AuthResponse | null> => {
		const account = deps.account();
		if (!account) return null;
		const token = await deps.loadToken();
		if (!token) return null;

		let nonceBytes: Uint8Array;
		try {
			nonceBytes = b64urlDecode(nonce);
		} catch {
			return null;
		}
		// SECURITY — refuse any nonce that is not the exact minted shape.
		//
		// `signNonce` is the SOVEREIGN USER key, which also signs `add-device`
		// roster records over `canonicalAddDeviceBytes` (unprefixed JSON). The
		// NODE chooses the nonce, and the blind relay is untrusted by design, so
		// a malicious node could otherwise send
		// `nonce = canonicalAddDeviceBytes(<its device>)` and get back a valid
		// roster record for the victim's vault. A canonical record is never 32
		// bytes, so this length check closes that oracle.
		//
		// The principled fix is domain separation (the LAN path already prefixes
		// `CHALLENGE_DOMAIN_TAG` — see `lan-admission.ts`), but the cloud
		// verifier is DEPLOYED SEPARATELY and still checks the untagged nonce
		// (`sync/src/admission.ts` `#verifyIdentity`), so tagging here
		// unilaterally would lock clients out. Sequencing: teach the node to
		// accept both, deploy it, then tag here and drop the legacy branch.
		if (nonceBytes.length !== CHALLENGE_NONCE_BYTES) return null;

		const sig = deps.signNonce(nonceBytes);
		if (!sig) return null;

		return { token, account, sig: b64urlEncode(sig) };
	};
}
