import { describe, expect, it } from "vitest";
import {
	BillingAccountStatus,
	BillingCheckoutCycle,
	BillingCheckoutPlan,
	BillingSettingsFailure,
} from "../../shared/billing-settings-types";
import { BillingEdgeClient, type BillingEdgePostJson } from "./billing-edge-client";
import { PlanTier } from "./plan";

function clientReturning(status: number, json: unknown): BillingEdgeClient {
	return new BillingEdgeClient(async () => ({ status, json }));
}

const SUMMARY_BODY = {
	sub: "acct_abc123",
	plan: "pro",
	features: ["sync.hosted", "ai.cloud"],
	email: "razor@example.com",
	billingStatus: "active",
};

describe("BillingEdgeClient.accountSummary", () => {
	it("parses a summary into the narrowed view", async () => {
		const result = await clientReturning(200, SUMMARY_BODY).accountSummary("cred");
		expect(result).toEqual({
			ok: true,
			value: {
				accountId: "acct_abc123",
				email: "razor@example.com",
				plan: PlanTier.Pro,
				billingStatus: BillingAccountStatus.Active,
			},
		});
	});

	it("posts the credential to the summary route", async () => {
		const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
		const postJson: BillingEdgePostJson = async (path, body) => {
			calls.push({ path, body });
			return { status: 200, json: SUMMARY_BODY };
		};
		await new BillingEdgeClient(postJson).accountSummary("cred-1");
		expect(calls).toEqual([{ path: "/v1/account/summary", body: { refreshCredential: "cred-1" } }]);
	});

	it("tolerates an omitted email and unknown billing status", async () => {
		const result = await clientReturning(200, {
			sub: "acct_1",
			plan: "plus",
			features: [],
			billingStatus: "brand-new-state",
		}).accountSummary("c");
		expect(result).toEqual({
			ok: true,
			value: { accountId: "acct_1", email: null, plan: PlanTier.Plus, billingStatus: null },
		});
	});

	it("degrades an unknown plan tier to Free (fail-closed)", async () => {
		const result = await clientReturning(200, {
			...SUMMARY_BODY,
			plan: "galactic",
		}).accountSummary("c");
		expect(result.ok && result.value.plan).toBe(PlanTier.Free);
	});

	it("maps 401 to Unauthorized", async () => {
		const result = await clientReturning(401, { error: "unknown credential" }).accountSummary("c");
		expect(result).toEqual({ ok: false, reason: BillingSettingsFailure.Unauthorized });
	});

	it("maps a transport failure (null) to Offline", async () => {
		const client = new BillingEdgeClient(async () => null);
		const result = await client.accountSummary("c");
		expect(result).toEqual({ ok: false, reason: BillingSettingsFailure.Offline });
	});

	it("maps a throwing transport to Offline (never rejects)", async () => {
		const client = new BillingEdgeClient(async () => {
			throw new Error("boom");
		});
		const result = await client.accountSummary("c");
		expect(result).toEqual({ ok: false, reason: BillingSettingsFailure.Offline });
	});

	it("maps 429 / 5xx to Service", async () => {
		expect(await clientReturning(429, {}).accountSummary("c")).toEqual({
			ok: false,
			reason: BillingSettingsFailure.Service,
		});
		expect(await clientReturning(502, {}).accountSummary("c")).toEqual({
			ok: false,
			reason: BillingSettingsFailure.Service,
		});
	});

	it("maps a malformed 200 body to Invalid", async () => {
		expect(await clientReturning(200, { nope: true }).accountSummary("c")).toEqual({
			ok: false,
			reason: BillingSettingsFailure.Invalid,
		});
		expect(await clientReturning(200, undefined).accountSummary("c")).toEqual({
			ok: false,
			reason: BillingSettingsFailure.Invalid,
		});
	});
});

describe("BillingEdgeClient.invoices", () => {
	const INVOICE = {
		id: "in_1",
		amountPaid: 1200,
		currency: "usd",
		status: "paid",
		hostedInvoiceUrl: "https://invoice.stripe.com/i/abc",
		created: 1_750_000_000,
	};

	it("parses invoice rows (seconds → millis, cents preserved)", async () => {
		const result = await clientReturning(200, { invoices: [INVOICE] }).invoices("c");
		expect(result).toEqual({
			ok: true,
			value: [
				{
					id: "in_1",
					amountPaidCents: 1200,
					currency: "usd",
					status: "paid",
					hostedInvoiceUrl: "https://invoice.stripe.com/i/abc",
					createdMs: 1_750_000_000_000,
				},
			],
		});
	});

	it("accepts an empty list and a missing hosted URL", async () => {
		expect(await clientReturning(200, { invoices: [] }).invoices("c")).toEqual({
			ok: true,
			value: [],
		});
		const noUrl = await clientReturning(200, {
			invoices: [{ ...INVOICE, hostedInvoiceUrl: undefined }],
		}).invoices("c");
		expect(noUrl.ok && noUrl.value[0]?.hostedInvoiceUrl).toBe(null);
	});

	it("drops a non-http hosted URL instead of handing it to the opener", async () => {
		const result = await clientReturning(200, {
			invoices: [{ ...INVOICE, hostedInvoiceUrl: "javascript:alert(1)" }],
		}).invoices("c");
		expect(result.ok && result.value[0]?.hostedInvoiceUrl).toBe(null);
	});

	it("rejects a malformed row wholesale (Invalid)", async () => {
		const result = await clientReturning(200, {
			invoices: [{ ...INVOICE, amountPaid: "twelve" }],
		}).invoices("c");
		expect(result).toEqual({ ok: false, reason: BillingSettingsFailure.Invalid });
	});
});

describe("BillingEdgeClient.checkoutSession", () => {
	it("returns the hosted Checkout URL and posts plan + cycle", async () => {
		const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
		const client = new BillingEdgeClient(async (path, body) => {
			calls.push({ path, body });
			return { status: 200, json: { url: "https://checkout.stripe.com/c/pay_123" } };
		});
		const result = await client.checkoutSession(
			"cred",
			BillingCheckoutPlan.Pro,
			BillingCheckoutCycle.Yearly,
		);
		expect(result).toEqual({ ok: true, value: "https://checkout.stripe.com/c/pay_123" });
		expect(calls).toEqual([
			{
				path: "/v1/checkout/session",
				body: { refreshCredential: "cred", plan: "pro", cycle: "yearly" },
			},
		]);
	});

	it("refuses a non-http checkout URL (Invalid)", async () => {
		const result = await clientReturning(200, { url: "file:///etc/passwd" }).checkoutSession(
			"cred",
			BillingCheckoutPlan.Plus,
			BillingCheckoutCycle.Monthly,
		);
		expect(result).toEqual({ ok: false, reason: BillingSettingsFailure.Invalid });
	});
});
