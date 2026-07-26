/**
 * SYNC-4b — the client challenge responder: builds the `{token, account, sig}`
 * gated-handshake reply from injected session deps, and stays unauthenticated
 * (null) when there's no session or no cached token.
 */

import { describe, expect, it } from "vitest";
import { makeChallengeResponder } from "./challenge-responder";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
/** A realistic challenge nonce: every challenger (the hosted node's
 *  `NONCE_BYTES`, the LAN host) mints exactly 32 random bytes, and the
 *  responder now refuses anything else — see `CHALLENGE_NONCE_BYTES`. */
const NONCE_BYTES = new Uint8Array(32).map((_, i) => i + 1);
const NONCE = b64url(NONCE_BYTES);

describe("makeChallengeResponder (SYNC-4b)", () => {
	it("returns the signed auth payload when account + token are present", async () => {
		const signed: Uint8Array[] = [];
		const respond = makeChallengeResponder({
			account: () => "ACCOUNT_B64URL",
			signNonce: (nonce) => {
				signed.push(nonce);
				return new Uint8Array([9, 9, 9]);
			},
			loadToken: () => "the-token",
		});
		const result = await respond(NONCE);
		expect(result).toEqual({
			token: "the-token",
			account: "ACCOUNT_B64URL",
			sig: b64url(new Uint8Array([9, 9, 9])),
		});
		// The nonce was decoded from base64url before signing.
		expect([...(signed[0] ?? [])]).toEqual([...NONCE_BYTES]);
	});

	it("returns null when there is no session (no account)", async () => {
		const respond = makeChallengeResponder({
			account: () => null,
			signNonce: () => new Uint8Array([1]),
			loadToken: () => "tok",
		});
		expect(await respond(NONCE)).toBeNull();
	});

	it("returns null when there is no cached token (the v1 default)", async () => {
		const respond = makeChallengeResponder({
			account: () => "ACCT",
			signNonce: () => new Uint8Array([1]),
			loadToken: () => null,
		});
		expect(await respond(NONCE)).toBeNull();
	});

	it("returns null when signing fails (no session at sign time)", async () => {
		const respond = makeChallengeResponder({
			account: () => "ACCT",
			signNonce: () => null,
			loadToken: async () => "tok",
		});
		expect(await respond(NONCE)).toBeNull();
	});

	it("REFUSES a nonce that is not the minted 32-byte shape, without signing", async () => {
		// The node picks these bytes and the signing key is the sovereign user
		// key, so an off-shape nonce is a signing-oracle attempt (a forged
		// add-device roster record) — see lan-challenge-oracle.test.ts.
		for (const size of [8, 31, 33, 200]) {
			let asked = false;
			const respond = makeChallengeResponder({
				account: () => "ACCT",
				signNonce: () => {
					asked = true;
					return new Uint8Array(64);
				},
				loadToken: () => "tok",
			});
			expect(await respond(b64url(new Uint8Array(size)))).toBeNull();
			expect(asked).toBe(false);
		}
	});
});
