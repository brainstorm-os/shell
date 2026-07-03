/**
 * 14.6 — billing-edge HTTP client (the shell's OWN egress, like the update
 * feed — a fixed first-party base URL, not app-brokered, so it doesn't ride
 * the per-app capability / SSRF machinery).
 *
 * Binds the three account-facing billing-edge routes the desktop client may
 * call, per the `brainstorm-cloud` contract (`packages/api-client` §http):
 *
 *   POST /v1/account/summary   { refreshCredential }        → plan + status
 *   POST /v1/account/invoices  { refreshCredential }        → Stripe invoices
 *   POST /v1/checkout/session  { refreshCredential, plan, cycle } → Checkout URL
 *
 * Auth is the body-carried `refreshCredential` (billing-edge has no header
 * auth for these). The transport is injected (`BillingEdgePostJson`) so the
 * whole client is unit-testable with no network and no Electron; production
 * binds `makeBillingEdgePostJson` (net.fetch, `billing-edge-fetch.ts`).
 *
 * Total: every failure resolves to a `BillingSettingsResult` reason, never a
 * rejection. Untrusted response fields are narrowed field-by-field — a
 * malformed body is `Invalid`, not a crash.
 */

import {
	type BillingAccountSummaryView,
	type BillingCheckoutCycle,
	type BillingCheckoutPlan,
	type BillingInvoiceView,
	BillingSettingsFailure,
	type BillingSettingsResult,
	asBillingAccountStatus,
	billingFail,
	billingOk,
} from "../../shared/billing-settings-types";
import { PlanTier, asPlanTier } from "./plan";

/** One POST to billing-edge. `null` = transport failure (offline / timeout);
 *  otherwise the HTTP status + decoded JSON body (json may be undefined when
 *  the body wasn't JSON). */
export type BillingEdgePostJson = (
	path: string,
	body: Record<string, unknown>,
) => Promise<{ status: number; json: unknown } | null>;

enum BillingEdgeRoute {
	AccountSummary = "/v1/account/summary",
	AccountInvoices = "/v1/account/invoices",
	CheckoutSession = "/v1/checkout/session",
}

export class BillingEdgeClient {
	constructor(private readonly postJson: BillingEdgePostJson) {}

	async accountSummary(
		refreshCredential: string,
	): Promise<BillingSettingsResult<BillingAccountSummaryView>> {
		return this.call(BillingEdgeRoute.AccountSummary, { refreshCredential }, parseSummary);
	}

	async invoices(
		refreshCredential: string,
	): Promise<BillingSettingsResult<readonly BillingInvoiceView[]>> {
		return this.call(BillingEdgeRoute.AccountInvoices, { refreshCredential }, parseInvoices);
	}

	async checkoutSession(
		refreshCredential: string,
		plan: BillingCheckoutPlan,
		cycle: BillingCheckoutCycle,
	): Promise<BillingSettingsResult<string>> {
		return this.call(
			BillingEdgeRoute.CheckoutSession,
			{ refreshCredential, plan, cycle },
			parseCheckoutUrl,
		);
	}

	private async call<T>(
		route: BillingEdgeRoute,
		body: Record<string, unknown>,
		parse: (json: unknown) => T | null,
	): Promise<BillingSettingsResult<T>> {
		let response: Awaited<ReturnType<BillingEdgePostJson>>;
		try {
			response = await this.postJson(route, body);
		} catch {
			response = null;
		}
		if (!response) return billingFail(BillingSettingsFailure.Offline);
		if (response.status === 401 || response.status === 403) {
			return billingFail(BillingSettingsFailure.Unauthorized);
		}
		if (response.status < 200 || response.status >= 300) {
			return billingFail(BillingSettingsFailure.Service);
		}
		const parsed = parse(response.json);
		return parsed === null ? billingFail(BillingSettingsFailure.Invalid) : billingOk(parsed);
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseSummary(json: unknown): BillingAccountSummaryView | null {
	const body = asRecord(json);
	if (!body) return null;
	const { sub, plan, email, billingStatus } = body;
	if (typeof sub !== "string" || sub.length === 0) return null;
	if (typeof plan !== "string") return null;
	return {
		accountId: sub,
		email: typeof email === "string" ? email : null,
		// Unknown wire tier degrades to Free — fail-closed, never surface a
		// plan this client can't name (mirrors `AccountRepository`).
		plan: asPlanTier(plan) ?? PlanTier.Free,
		billingStatus: typeof billingStatus === "string" ? asBillingAccountStatus(billingStatus) : null,
	};
}

function parseInvoices(json: unknown): readonly BillingInvoiceView[] | null {
	const body = asRecord(json);
	if (!body || !Array.isArray(body.invoices)) return null;
	const out: BillingInvoiceView[] = [];
	for (const raw of body.invoices) {
		const row = asRecord(raw);
		if (!row) return null;
		const { id, amountPaid, currency, status, hostedInvoiceUrl, created } = row;
		if (typeof id !== "string" || id.length === 0) return null;
		if (typeof amountPaid !== "number" || !Number.isFinite(amountPaid)) return null;
		if (typeof currency !== "string" || typeof status !== "string") return null;
		if (typeof created !== "number" || !Number.isFinite(created)) return null;
		out.push({
			id,
			amountPaidCents: amountPaid,
			currency,
			status,
			hostedInvoiceUrl: asHttpUrl(hostedInvoiceUrl),
			createdMs: created * 1000,
		});
	}
	return out;
}

function parseCheckoutUrl(json: unknown): string | null {
	const body = asRecord(json);
	return body ? asHttpUrl(body.url) : null;
}

/** Only ever hand back an http(s) URL — anything else (javascript:, file:,
 *  non-string) is dropped before it can reach the OS-handoff open. */
function asHttpUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : null;
	} catch {
		return null;
	}
}
