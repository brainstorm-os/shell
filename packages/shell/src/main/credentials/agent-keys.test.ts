/**
 * Agent key custody tests (Agent-Teams-1b) — each agent's own Ed25519 secret is
 * sealed in the CredentialStore and never returned; callers only ever get the
 * public identity (create) or a signature (sign). Covers: round-trip sign +
 * verify under the returned pubkey, secret-never-escapes, fail-closed signing on
 * a device without the key, and removal.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	agentKeyCredentialKey,
	createAgentKey,
	hasAgentKey,
	removeAgentKey,
	signWithAgent,
} from "./agent-keys";
import { generateSymmetricKey } from "./crypto";
import { publicKeyFromBase64, verifySignature } from "./identity";
import { CredentialStore } from "./store";

describe("agent-keys (Agent-Teams-1b agent key custody)", () => {
	let vaultDir: string;
	let store: CredentialStore;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-agent-keys-"));
		store = new CredentialStore(vaultDir, generateSymmetricKey());
	});
	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("namespaces the credential key per agent under the agent-keys app", () => {
		expect(agentKeyCredentialKey("ed25519:abcd")).toEqual({
			app: "io.brainstorm.agent-keys",
			key: "ed25519:abcd",
		});
	});

	it("mints a public identity and seals the secret (never returned)", async () => {
		const id = await createAgentKey(store);
		expect(id.pubkey).toMatch(/.+/);
		expect(id.fingerprint).toMatch(/^ed25519:/);
		// The returned identity carries no secret material.
		expect(Object.keys(id).sort()).toEqual(["fingerprint", "pubkey"]);
		expect(await hasAgentKey(store, id.fingerprint)).toBe(true);
	});

	it("signs as the agent; the signature verifies under the returned pubkey", async () => {
		const id = await createAgentKey(store);
		const payload = new TextEncoder().encode("proposed-by-this-agent");
		const sig = await signWithAgent(store, id.fingerprint, payload);
		expect(sig).toHaveLength(64);
		expect(verifySignature(publicKeyFromBase64(id.pubkey), payload, sig)).toBe(true);
		// A different payload does not verify against the same signature.
		const other = new TextEncoder().encode("tampered");
		expect(verifySignature(publicKeyFromBase64(id.pubkey), other, sig)).toBe(false);
	});

	it("fails closed when signing without a held key (no key on this device)", async () => {
		await expect(signWithAgent(store, "ed25519:not-held", new Uint8Array([1]))).rejects.toThrow(
			/no key held/,
		);
	});

	it("removes the sealed secret; signing then fails closed", async () => {
		const id = await createAgentKey(store);
		expect(await removeAgentKey(store, id.fingerprint)).toBe(true);
		expect(await hasAgentKey(store, id.fingerprint)).toBe(false);
		await expect(signWithAgent(store, id.fingerprint, new Uint8Array([1]))).rejects.toThrow();
		// Removing a non-existent key is a no-op false.
		expect(await removeAgentKey(store, "ed25519:never")).toBe(false);
	});

	it("mints distinct principals across agents", async () => {
		const a = await createAgentKey(store);
		const b = await createAgentKey(store);
		expect(a.fingerprint).not.toBe(b.fingerprint);
		expect(a.pubkey).not.toBe(b.pubkey);
	});
});
