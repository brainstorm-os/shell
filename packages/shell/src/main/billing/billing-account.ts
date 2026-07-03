/**
 * 14.6 — BillingAccountService: the main-process orchestrator behind the
 * Settings → Billing panel.
 *
 * Owns the account link lifecycle on this device: the refresh credential
 * (per-vault `CredentialStore`, never crossing IPC back out), the `account`
 * row in `account.db`, and every billing-edge call the panel triggers. The
 * renderer only ever sees narrowed views (`BillingOverviewView`,
 * `BillingAccountSummaryView`, `BillingInvoiceView`) and checkout / invoice
 * URLs — never the credential.
 *
 * Every dependency is injected (closures resolve the active vault session at
 * call time), so the whole service is unit-testable against a real
 * `account.db` with a fake edge client and an in-memory credential slot.
 *
 * Fail-soft throughout: no session → `Unavailable`, no credential →
 * `NotLinked`, transport/credential/service failures pass through the
 * client's reasons. Nothing here throws across IPC.
 */

import {
	type BillingAccountSummaryView,
	type BillingCheckoutCycle,
	type BillingCheckoutPlan,
	type BillingInvoiceView,
	type BillingOverviewView,
	BillingSettingsFailure,
	type BillingSettingsResult,
	asBillingCheckoutCycle,
	asBillingCheckoutPlan,
	billingFail,
} from "../../shared/billing-settings-types";
import type { AccountRepository } from "./account-repo";
import type { BillingEdgeClient } from "./billing-edge-client";
import type { EntitlementRepository } from "./entitlement-repo";
import { type Entitlement, freeEntitlement } from "./plan";

export type BillingAccountRepos = {
	readonly accounts: AccountRepository;
	readonly entitlements: EntitlementRepository;
};

export type BillingAccountDeps = {
	readonly client: BillingEdgeClient;
	/** The account-portal base URL the panel's Manage buttons open. */
	readonly portalUrl: string;
	readonly readCredential: () => Promise<string | null>;
	readonly writeCredential: (credential: string) => Promise<void>;
	readonly deleteCredential: () => Promise<boolean>;
	/** The active vault's `account.db` repos, or null when no vault is open. */
	readonly getRepos: () => Promise<BillingAccountRepos | null>;
	/** The effective (offline-grace) entitlement from `BillingService`. */
	readonly getEntitlement: () => Promise<Entitlement | null>;
	/** Bound upload bytes in the vault's asset store; null = unknown. */
	readonly getStorageBytes: () => Promise<number | null>;
	readonly now?: () => number;
};

export class BillingAccountService {
	private readonly now: () => number;

	constructor(private readonly deps: BillingAccountDeps) {
		this.now = deps.now ?? Date.now;
	}

	/** The panel's local read — account link + entitlement + storage usage.
	 *  Never touches the network. Null when no vault session is open. */
	async overview(): Promise<BillingOverviewView | null> {
		const repos = await this.getReposSafe();
		if (!repos) return null;
		const linked = safe(() => repos.accounts.getLinked(), null);
		const entitlement = (await this.getEntitlementSafe()) ?? freeEntitlement(linked?.id ?? null);
		const storageBytesUsed = await this.getStorageBytesSafe();
		return {
			account: linked
				? { id: linked.id, email: linked.email, plan: linked.plan, linkedAt: linked.linkedAt }
				: null,
			entitlement,
			storageBytesUsed,
			portalUrl: this.deps.portalUrl,
		};
	}

	/** Link this device to a control-plane account: validate the pasted
	 *  credential against `/v1/account/summary`, then seal it + record the
	 *  account row. An invalid credential stores NOTHING. */
	async link(credential: unknown): Promise<BillingSettingsResult<BillingAccountSummaryView>> {
		if (typeof credential !== "string" || credential.trim().length === 0) {
			return billingFail(BillingSettingsFailure.Invalid);
		}
		const repos = await this.getReposSafe();
		if (!repos) return billingFail(BillingSettingsFailure.Unavailable);
		const trimmed = credential.trim();
		const summary = await this.deps.client.accountSummary(trimmed);
		if (!summary.ok) return summary;
		await this.deps.writeCredential(trimmed);
		this.recordSummary(repos.accounts, summary.value);
		return summary;
	}

	/** Live account state from billing-edge, refreshing the cached account
	 *  row on success (email / plan drift after an upgrade in the portal). */
	async refreshSummary(): Promise<BillingSettingsResult<BillingAccountSummaryView>> {
		return this.withCredential(async (credential, repos) => {
			const summary = await this.deps.client.accountSummary(credential);
			if (summary.ok) this.recordSummary(repos.accounts, summary.value);
			return summary;
		});
	}

	/** Sign the device out of the account: credential + account row +
	 *  cached entitlement all go. Returns whether anything was removed. */
	async unlink(): Promise<boolean> {
		const removedCredential = await safeAsync(() => this.deps.deleteCredential(), false);
		const repos = await this.getReposSafe();
		let removedAccount = false;
		if (repos) {
			const linked = safe(() => repos.accounts.getLinked(), null);
			if (linked) {
				safe(() => repos.entitlements.delete(linked.id), false);
				removedAccount = safe(() => repos.accounts.unlink(linked.id), false);
			}
		}
		return removedCredential || removedAccount;
	}

	async invoices(): Promise<BillingSettingsResult<readonly BillingInvoiceView[]>> {
		return this.withCredential(async (credential) => this.deps.client.invoices(credential));
	}

	/** Start a hosted Stripe Checkout for a self-serve tier. Returns the URL
	 *  the renderer opens through the OS-handoff chokepoint — payment never
	 *  renders in-product (sandboxing + PCI posture). */
	async checkout(plan: unknown, cycle: unknown): Promise<BillingSettingsResult<string>> {
		const parsedPlan = asBillingCheckoutPlan(plan);
		const parsedCycle = asBillingCheckoutCycle(cycle);
		if (!parsedPlan || !parsedCycle) return billingFail(BillingSettingsFailure.Invalid);
		return this.withCredential(async (credential) =>
			this.deps.client.checkoutSession(credential, parsedPlan, parsedCycle),
		);
	}

	private async withCredential<T>(
		action: (credential: string, repos: BillingAccountRepos) => Promise<BillingSettingsResult<T>>,
	): Promise<BillingSettingsResult<T>> {
		const repos = await this.getReposSafe();
		if (!repos) return billingFail(BillingSettingsFailure.Unavailable);
		const credential = await safeAsync(() => this.deps.readCredential(), null);
		if (!credential) return billingFail(BillingSettingsFailure.NotLinked);
		return action(credential, repos);
	}

	private recordSummary(accounts: AccountRepository, summary: BillingAccountSummaryView): void {
		const now = this.now();
		const existing = safe(() => accounts.get(summary.accountId), null);
		safe(
			() =>
				accounts.link({
					id: summary.accountId,
					email: summary.email,
					plan: summary.plan,
					linkedAt: existing?.linkedAt ?? now,
					updatedAt: now,
				}),
			undefined,
		);
	}

	private async getReposSafe(): Promise<BillingAccountRepos | null> {
		return safeAsync(() => this.deps.getRepos(), null);
	}

	private async getEntitlementSafe(): Promise<Entitlement | null> {
		return safeAsync(() => this.deps.getEntitlement(), null);
	}

	private async getStorageBytesSafe(): Promise<number | null> {
		return safeAsync(() => this.deps.getStorageBytes(), null);
	}
}

function safe<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

async function safeAsync<T>(read: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await read();
	} catch {
		return fallback;
	}
}
