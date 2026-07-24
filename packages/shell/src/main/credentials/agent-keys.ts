/**
 * Agent key custody (Agent-Teams-1b) — each agent is a distinct principal with
 * its OWN Ed25519 keypair (doc 69 §Identity). The PUBLIC key + fingerprint go on
 * the agent's syncing `Agent/v1` entity; the SECRET is sealed at rest in the
 * per-vault `CredentialStore` (under the vault master key) and NEVER leaves the
 * main process — callers sign through `signWithAgent` and receive a signature,
 * never the key. Same custody posture as the sovereign identity + MCP auth
 * (crypto-routing rule: only `main/credentials/` touches raw keys).
 *
 * A sealed agent secret is device-local (it does not sync), so an agent can only
 * sign on the device that minted (or was granted) its key. Cross-device agent
 * identity is deferred to the Collab-C5 track (doc 69 §Phasing) — until then a
 * device without the key fails closed (cannot sign as the agent).
 */

import { fingerprintPublicKey, generateIdentity, publicKeyToBase64, signPayload } from "./identity";
import type { CredentialKey, CredentialStore } from "./store";

const AGENT_KEYS_APP = "io.brainstorm.agent-keys";

/** The public identity of a minted agent key — the halves safe to persist on the
 *  syncing `Agent/v1` entity. The secret is sealed in the store, never returned. */
export type AgentKeyIdentity = {
	/** base64 Ed25519 public key. */
	pubkey: string;
	/** `ed25519:<hex>` fingerprint — the store key + roster anchor. */
	fingerprint: string;
};

/** The `CredentialStore` key for an agent's sealed secret, namespaced by the
 *  agent fingerprint (an agent's durable id). */
export function agentKeyCredentialKey(fingerprint: string): CredentialKey {
	return { app: AGENT_KEYS_APP, key: fingerprint };
}

/** Mint a new agent identity: generate an Ed25519 keypair, seal the secret at
 *  rest, and return only the public halves. The working copy of the secret is
 *  zeroed once sealed; it never leaves this call unsealed. */
export async function createAgentKey(store: CredentialStore): Promise<AgentKeyIdentity> {
	const kp = generateIdentity();
	const pubkey = publicKeyToBase64(kp.publicKey);
	const fingerprint = fingerprintPublicKey(kp.publicKey);
	try {
		await store.set(agentKeyCredentialKey(fingerprint), kp.secretKey);
	} finally {
		kp.secretKey.fill(0);
	}
	return { pubkey, fingerprint };
}

/** True if a sealed secret for this agent is held on THIS device. */
export async function hasAgentKey(store: CredentialStore, fingerprint: string): Promise<boolean> {
	return (await store.get(agentKeyCredentialKey(fingerprint))) !== null;
}

/** Sign `payload` as the agent — the secret is loaded, used, and zeroed inside
 *  main; only the 64-byte signature is returned. Throws (fail-closed) if no key
 *  is held for this agent on this device, so a device that never minted or was
 *  granted the key can never sign as the agent. */
export async function signWithAgent(
	store: CredentialStore,
	fingerprint: string,
	payload: Uint8Array,
): Promise<Uint8Array> {
	const secret = await store.get(agentKeyCredentialKey(fingerprint));
	if (!secret) throw new Error(`agent-keys: no key held for ${fingerprint}`);
	try {
		return signPayload(secret, payload);
	} finally {
		secret.fill(0);
	}
}

/** Remove an agent's sealed secret (delete-agent / key revocation). Returns true
 *  when a key was removed. The public `Agent/v1` record + any ledger revocation
 *  are the caller's concern. */
export async function removeAgentKey(
	store: CredentialStore,
	fingerprint: string,
): Promise<boolean> {
	return store.delete(agentKeyCredentialKey(fingerprint));
}
