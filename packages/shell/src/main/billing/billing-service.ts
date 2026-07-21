/**
 * `billing` broker service — the app-facing surface of the product-side billing
 * cache (iteration 14.1). Apps (and the shell's future Settings → Billing UI,
 * 14.6) reach it through the IPC broker to read the current plan + entitlement.
 *
 * v1 is a SKELETON: there is no commercial surface, so the service reports the
 * hardcoded Free entitlement unless a verified entitlement has been cached in
 * `account.db` (the slot 14.3's refresh path will populate). It NEVER calls the
 * control plane and NEVER imports control-plane code — it reads the local cache
 * and falls back to Free.
 *
 * SECURITY: like the network / mcp handlers, the broker's generic declared-caps
 * check is necessary-but-not-sufficient (the app controls `envelope.caps`), so
 * the `billing.read` cap is RE-CHECKED against the active vault's ledger here —
 * the authoritative gate. Fail-closed: ledger error / no vault → `Unavailable`;
 * cap not held → `Denied`.
 */

import { type CapabilityLedger, LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { AccountRepository } from "./account-repo";
import type { EntitlementRepository } from "./entitlement-repo";
import {
	type Entitlement,
	EntitlementStatus,
	type FeatureFlag,
	type PlanTier,
	asFeatureFlags,
	freeEntitlement,
} from "./plan";

/** The capability gating every billing read. Scarce (granted to the shell, not
 *  default-minimum for apps) so reads of the user's plan stay deliberate. */
export const BILLING_READ_CAPABILITY = "billing.read";

export enum BillingMethod {
	GetEntitlement = "getEntitlement",
	GetPlan = "getPlan",
	HasFeature = "hasFeature",
}

/**
 * Reads the effective entitlement from the account-link + entitlement-cache
 * repos, applying the offline-grace model. Pure over its repos + clock; the
 * broker handler wraps it with the capability gate.
 */
export class BillingService {
	constructor(
		private readonly accounts: AccountRepository,
		private readonly entitlements: EntitlementRepository,
		private readonly now: () => number = Date.now,
	) {}

	/** The current effective entitlement: the cached verified entitlement when
	 *  present + unexpired, else the hardcoded Free default. */
	getEntitlement(): Entitlement {
		const account = this.accounts.getLinked();
		if (!account) return freeEntitlement();
		const cached = this.entitlements.get(account.id);
		if (!cached) return freeEntitlement(account.id);
		const now = this.now();
		// Hard-expired → the client must refresh; never honour a stale token.
		if (now >= cached.hardExp) return freeEntitlement(account.id);
		const status = now >= cached.softExp ? EntitlementStatus.Grace : EntitlementStatus.Active;
		return {
			plan: cached.plan,
			features: cached.features,
			status,
			accountId: account.id,
		};
	}

	/** SYNC-4b — the cached, unexpired compact entitlement token for the linked
	 *  account, or null. Used by the gated-sync handshake to present admission
	 *  to a managed/self-hosted node. Null in v1 (no token cached until 14.3). */
	currentToken(): string | null {
		const account = this.accounts.getLinked();
		if (!account) return null;
		const cached = this.entitlements.get(account.id);
		if (!cached) return null;
		if (this.now() >= cached.hardExp) return null; // never present a dead token
		return cached.token;
	}

	getPlan(): PlanTier {
		return this.getEntitlement().plan;
	}

	hasFeature(feature: FeatureFlag): boolean {
		return this.getEntitlement().features.includes(feature);
	}
}

export type BillingServiceOptions = {
	/** The active vault's `BillingService`, or null when no vault is open
	 *  (→ `Unavailable`). */
	readonly getService: () => Promise<BillingService | null>;
	/** SECURITY — the active vault's capability ledger, used to re-check the
	 *  `billing.read` grant server-side (never trusting `envelope.caps`). Absent
	 *  → the cap gate is skipped (unit tests that presume authorization). */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

async function assertBillingRead(
	options: BillingServiceOptions,
	envelope: Envelope,
): Promise<void> {
	if (!options.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "billing: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "billing: no active vault session");
	let held: boolean;
	try {
		held = ledger.has(envelope.app, BILLING_READ_CAPABILITY);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "billing: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw makeError("Denied", `billing: ${envelope.app} lacks ${BILLING_READ_CAPABILITY}`);
	}
}

export function makeBillingServiceHandler(options: BillingServiceOptions): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		await assertBillingRead(options, envelope);
		const service = await options.getService();
		if (!service) {
			throw makeError("Unavailable", "billing: no active vault session");
		}
		switch (envelope.method) {
			case BillingMethod.GetEntitlement:
				return service.getEntitlement();
			case BillingMethod.GetPlan:
				return service.getPlan();
			case BillingMethod.HasFeature: {
				const [feature] = envelope.args as [unknown];
				if (typeof feature !== "string") {
					throw makeError("Invalid", "billing.hasFeature requires a feature string");
				}
				// Unknown flag → not entitled (never throw on an unrecognised gate).
				const [flag] = asFeatureFlags([feature]);
				return flag ? service.hasFeature(flag) : false;
			}
			default:
				throw makeError("Invalid", `unknown billing method: ${envelope.method}`);
		}
	};
}
