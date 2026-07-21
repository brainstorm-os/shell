/**
 * Billing domain model — plans, feature flags, and the effective entitlement
 * the product (data-plane) side reads (iteration 14.1; moved to `shared/` for
 * 14.6 so the Settings → Billing renderer can `switch` on these enums without
 * pulling a main-process module into the dashboard bundle — the same
 * renderer-safe convention as `update-wire-types.ts`).
 *
 * The authoritative plan + feature set is issued by the out-of-repo
 * `brainstorm-cloud` control plane as a signed, offline-verifiable entitlement
 * token (its `packages/api-client` §EntitlementClaims is the cross-plane wire
 * spec). This module is the product-side mirror of those values so the shell
 * can reason about the current plan without a network call. The data plane
 * NEVER imports control-plane code — it agrees on these enum *values* (the wire
 * strings), nothing more.
 *
 * v1 ships no commercial surface: every install is Free, and `BillingService`
 * synthesises `freeEntitlement()`. The feature-flag plumbing exists so future
 * paid-tier gating (relay, backup, attachments, bundled AI credits) has a home
 * the moment 14.3 drops a verified token into `account.db`.
 */

/** Subscription tiers. Values are the cross-plane wire strings — keep in lockstep
 *  with `brainstorm-cloud/packages/api-client` §PlanTier. */
export enum PlanTier {
	Free = "free",
	Plus = "plus",
	Pro = "pro",
	Team = "team",
	Enterprise = "enterprise",
}

/** Entitlement flags a feature gates on. Wire strings carried in the token's
 *  `features` array; denormalised into `account.db`. The Free tier holds none —
 *  Free is fully local-first + BYO-AI (§Free). */
export enum FeatureFlag {
	/** Hosted, lower-latency relay tier (Plus+). */
	HostedRelay = "hosted-relay",
	/** Encrypted off-device backup (Plus+). */
	EncryptedBackup = "encrypted-backup",
	/** Larger attachment quota (Plus+). */
	LargeAttachments = "large-attachments",
	/** Platform-managed AI credits bundled with the plan (Pro+). */
	BundledAiCredits = "bundled-ai-credits",
}

/** Entitlement freshness, mirroring the control plane's offline-grace model
 *  (api-client §EntitlementStatus). The synthesised Free entitlement is always
 *  `Active` — it never expires because it isn't issued. */
export enum EntitlementStatus {
	/** Verified and within its soft-expiry window. */
	Active = "active",
	/** Past soft-expiry, before hard-expiry — still entitled, refresh soon. */
	Grace = "grace",
}

/** The effective entitlement the shell gates features on. */
export type Entitlement = {
	plan: PlanTier;
	features: readonly FeatureFlag[];
	status: EntitlementStatus;
	/** Control-plane account id when signed in; null for the offline Free default
	 *  (this is an account id, NEVER a vault id — the planes don't share those). */
	accountId: string | null;
};

/** The hardcoded Free entitlement — the v1 default and the offline fallback
 *  whenever no verified entitlement is cached. */
export function freeEntitlement(accountId: string | null = null): Entitlement {
	return {
		plan: PlanTier.Free,
		features: [],
		status: EntitlementStatus.Active,
		accountId,
	};
}

const PLAN_VALUES = new Set<string>(Object.values(PlanTier));
const FEATURE_VALUES = new Set<string>(Object.values(FeatureFlag));

/** Narrow an untrusted wire string to a known `PlanTier`, or null. */
export function asPlanTier(value: string): PlanTier | null {
	return PLAN_VALUES.has(value) ? (value as PlanTier) : null;
}

/** Filter an untrusted wire list down to known `FeatureFlag`s (drops unknowns
 *  so an older client never gates on a flag it can't honour). */
export function asFeatureFlags(values: readonly string[]): FeatureFlag[] {
	return values.filter((v): v is FeatureFlag => FEATURE_VALUES.has(v));
}
