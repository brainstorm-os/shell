/**
 * 14.6 — Settings → Billing wire types (privileged dashboard surface).
 *
 * Renderer-safe (no electron / node imports) like `update-wire-types.ts`.
 * These are the shapes crossing the `billing-settings:*` ipcMain channels
 * between the main-process `BillingAccountService` and the dashboard panel.
 *
 * The account/invoice/checkout shapes mirror the `brainstorm-cloud`
 * billing-edge contract (`packages/api-client` §http): `/v1/account/summary`,
 * `/v1/account/invoices`, `/v1/checkout/session`. The data plane never
 * imports control-plane code — it agrees on the wire field names, nothing
 * more (same posture as `billing-types.ts`).
 */

import type { Entitlement, PlanTier } from "./billing-types";
import type { QuotaStateView } from "./quota-types";

/** Control-plane billing lifecycle state, orthogonal to the plan tier.
 *  Values are the cross-plane wire strings (api-client §BillingStatus). */
export enum BillingAccountStatus {
	Active = "active",
	PastDue = "past_due",
	Disputed = "disputed",
	Suspended = "suspended",
}

const BILLING_STATUS_VALUES = new Set<string>(Object.values(BillingAccountStatus));

/** Narrow an untrusted wire string to a known `BillingAccountStatus`, or null. */
export function asBillingAccountStatus(value: string): BillingAccountStatus | null {
	return BILLING_STATUS_VALUES.has(value) ? (value as BillingAccountStatus) : null;
}

/** Why a billing action didn't produce a value. Every failure is a returned
 *  reason, never a rejection — the panel renders each as a distinct line. */
export enum BillingSettingsFailure {
	/** No vault session open (transient during vault switch). */
	Unavailable = "unavailable",
	/** No account credential stored on this device — link first. */
	NotLinked = "not-linked",
	/** Transport failure — offline, DNS, timeout. */
	Offline = "offline",
	/** billing-edge rejected the stored credential (revoked / rotated). */
	Unauthorized = "unauthorized",
	/** billing-edge answered non-2xx (rate limit, upstream Stripe error). */
	Service = "service",
	/** Malformed response or invalid arguments — nothing to retry. */
	Invalid = "invalid",
}

/** Total result for every billing-edge-backed action. */
export type BillingSettingsResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: BillingSettingsFailure };

export function billingOk<T>(value: T): BillingSettingsResult<T> {
	return { ok: true, value };
}

export function billingFail<T>(reason: BillingSettingsFailure): BillingSettingsResult<T> {
	return { ok: false, reason };
}

/** `/v1/account/summary` narrowed for display. `plan` degrades to Free on an
 *  unknown wire tier (fail-closed, mirroring `AccountRepository`). */
export type BillingAccountSummaryView = {
	readonly accountId: string;
	readonly email: string | null;
	readonly plan: PlanTier;
	readonly billingStatus: BillingAccountStatus | null;
};

/** One `/v1/account/invoices` row. `amountPaidCents` is minor units;
 *  `createdMs` is epoch millis (wire carries seconds); `status` is Stripe's
 *  raw status string — data, rendered verbatim. */
export type BillingInvoiceView = {
	readonly id: string;
	readonly amountPaidCents: number;
	readonly currency: string;
	readonly status: string;
	readonly hostedInvoiceUrl: string | null;
	readonly createdMs: number;
};

/** The panel's one-shot local read: account link + effective entitlement +
 *  best-effort local storage usage. Never touches the network. */
export type BillingOverviewView = {
	readonly account: {
		readonly id: string;
		readonly email: string | null;
		readonly plan: PlanTier;
		readonly linkedAt: number;
	} | null;
	readonly entitlement: Entitlement;
	/** Bound upload bytes in the vault's encrypted asset store, or null when
	 *  the inventory couldn't be read. */
	readonly storageBytesUsed: number | null;
	/** 14.7 — per-resource quota verdicts (used vs ceiling + over flag), or
	 *  null when the quota state couldn't be read. Inert (no ceilings) when
	 *  no account is linked. */
	readonly quota: QuotaStateView | null;
	/** The account-portal base URL the Manage/upgrade buttons open. */
	readonly portalUrl: string;
};

/** Self-serve upgradeable tiers (`/v1/checkout/session` rejects `free` /
 *  `enterprise`). */
export enum BillingCheckoutPlan {
	Plus = "plus",
	Pro = "pro",
	Team = "team",
}

export enum BillingCheckoutCycle {
	Monthly = "monthly",
	Yearly = "yearly",
}

const CHECKOUT_PLAN_VALUES = new Set<string>(Object.values(BillingCheckoutPlan));
const CHECKOUT_CYCLE_VALUES = new Set<string>(Object.values(BillingCheckoutCycle));

export function asBillingCheckoutPlan(value: unknown): BillingCheckoutPlan | null {
	return typeof value === "string" && CHECKOUT_PLAN_VALUES.has(value)
		? (value as BillingCheckoutPlan)
		: null;
}

export function asBillingCheckoutCycle(value: unknown): BillingCheckoutCycle | null {
	return typeof value === "string" && CHECKOUT_CYCLE_VALUES.has(value)
		? (value as BillingCheckoutCycle)
		: null;
}
