/**
 * Test-only crypto helpers backed by `@brainstorm-os/native` + `node:crypto`.
 *
 * The production code dropped its noble-curves dependency in NAPI-3e; the
 * test suites that used the noble `ed25519` / `x25519` objects (keygen /
 * sign / verify) for fixture keys and oracle checks route through these
 * shims instead, so the whole package — tests included — depends on no
 * third-party JS crypto library. The method shapes mirror noble-curves v2
 * (`keygen()` → `{ secretKey, publicKey }`, `sign(msg, secret)`,
 * `verify(sig, msg, pub)`) so call sites port over with no logic change.
 *
 * Not for production: this lives under `test-support/` (coverage-excluded)
 * and must never be imported by non-test code.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
	ed25519GetPublicKey,
	ed25519Sign,
	ed25519Verify,
	x25519GetPublicKey,
} from "@brainstorm-os/native";

export function randomBytes(length: number): Uint8Array {
	return new Uint8Array(nodeRandomBytes(length));
}

export type TestKeypair = {
	secretKey: Uint8Array;
	publicKey: Uint8Array;
};

export const ed25519 = {
	keygen(): TestKeypair {
		const secretKey = randomBytes(32);
		const publicKey = new Uint8Array(ed25519GetPublicKey(secretKey));
		return { secretKey, publicKey };
	},
	getPublicKey(secretKey: Uint8Array): Uint8Array {
		return new Uint8Array(ed25519GetPublicKey(secretKey));
	},
	sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
		return new Uint8Array(ed25519Sign(secretKey, message));
	},
	verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
		return ed25519Verify(publicKey, message, signature);
	},
} as const;

export const x25519 = {
	keygen(): TestKeypair {
		const secretKey = randomBytes(32);
		const publicKey = new Uint8Array(x25519GetPublicKey(secretKey));
		return { secretKey, publicKey };
	},
	getPublicKey(secretKey: Uint8Array): Uint8Array {
		return new Uint8Array(x25519GetPublicKey(secretKey));
	},
} as const;
