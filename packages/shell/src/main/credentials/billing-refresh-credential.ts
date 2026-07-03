/**
 * The billing-edge account `refreshCredential` as a Tier-2 shell credential
 * (14.6). It is the long-lived secret billing-edge issues at checkout — the
 * only client auth its account routes accept — so it gets the same custody
 * as AI provider keys: sealed in the per-vault `CredentialStore` (encrypted
 * at rest under the master key), read only by the main-process
 * `BillingAccountService` at request time, and **never crossing IPC to any
 * renderer** (the dashboard sends it once on link; it never comes back).
 */

import type { CredentialKey, CredentialStore } from "./store";

/** The credential `app` namespace for the shell-owned billing link. */
const BILLING_APP = "io.brainstorm.billing";

export function billingCredentialKey(): CredentialKey {
	return { app: BILLING_APP, key: "refresh-credential" };
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Read the stored refresh credential, or `null` when no account is linked. */
export async function readBillingCredential(store: CredentialStore): Promise<string | null> {
	const bytes = await store.get(billingCredentialKey());
	if (!bytes) return null;
	const credential = DECODER.decode(bytes).trim();
	return credential.length > 0 ? credential : null;
}

/** Store (or replace) the refresh credential — the account-link write. */
export async function writeBillingCredential(
	store: CredentialStore,
	credential: string,
): Promise<void> {
	await store.set(billingCredentialKey(), ENCODER.encode(credential));
}

/** Remove the stored credential (sign out). Returns false when none was set. */
export async function deleteBillingCredential(store: CredentialStore): Promise<boolean> {
	return store.delete(billingCredentialKey());
}
