/**
 * Settings → Billing (14.6) — SSR-rendered tests against the privileged
 * `window.brainstorm.billing` bridge (same pattern as sync-section.test.tsx),
 * plus the pure subcomponents rendered directly with props.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BillingAccountStatus,
	type BillingInvoiceView,
	type BillingOverviewView,
	BillingSettingsFailure,
} from "../../shared/billing-settings-types";
import { EntitlementStatus, FeatureFlag, PlanTier } from "../../shared/billing-types";
import {
	BillingSection,
	InvoicesGroup,
	LinkForm,
	LinkedAccount,
	PlanGroup,
	formatInvoiceAmount,
	formatInvoiceDate,
} from "./billing-section";
import { SettingsSection } from "./sections";

beforeEach(() => {
	(globalThis as { window?: unknown }).window = {
		brainstorm: {
			billing: {
				overview: vi.fn().mockResolvedValue(null),
				refreshSummary: vi
					.fn()
					.mockResolvedValue({ ok: false, reason: BillingSettingsFailure.NotLinked }),
				invoices: vi.fn().mockResolvedValue({ ok: false, reason: BillingSettingsFailure.NotLinked }),
			},
			intents: { dispatch: vi.fn().mockResolvedValue({ handled: false, reason: "no-handler" }) },
		},
	};
});

afterEach(() => {
	(globalThis as { window?: unknown }).window = undefined;
});

const FREE_OVERVIEW: BillingOverviewView = {
	account: null,
	entitlement: {
		plan: PlanTier.Free,
		features: [],
		status: EntitlementStatus.Active,
		accountId: null,
	},
	storageBytesUsed: 2048,
	portalUrl: "https://account.example.test",
};

const PRO_OVERVIEW: BillingOverviewView = {
	account: { id: "acct_1", email: "razor@example.com", plan: PlanTier.Pro, linkedAt: 1 },
	entitlement: {
		plan: PlanTier.Pro,
		features: [FeatureFlag.HostedRelay, FeatureFlag.BundledAiCredits],
		status: EntitlementStatus.Grace,
		accountId: "acct_1",
	},
	storageBytesUsed: null,
	portalUrl: "https://account.example.test",
};

describe("SettingsSection.Billing", () => {
	it("declares the Billing section enum entry", () => {
		expect(SettingsSection.Billing).toBe("billing");
		expect(SettingsSection.Billing).not.toBe(SettingsSection.Membership);
	});
});

describe("<BillingSection>", () => {
	it("renders the loading line on first synchronous paint", () => {
		const html = renderToStaticMarkup(<BillingSection />);
		expect(html).toContain("settings__loading");
	});

	it("loading copy is t-keyed (no bare i18n keys)", () => {
		const html = renderToStaticMarkup(<BillingSection />);
		expect(html).not.toContain("shell.common.loading");
	});
});

describe("<PlanGroup>", () => {
	it("shows the Free plan, no relay, and local storage used", () => {
		const html = renderToStaticMarkup(<PlanGroup overview={FREE_OVERVIEW} />);
		expect(html).toContain('data-testid="billing-plan-name"');
		expect(html).toContain("Free");
		expect(html).toContain("Not included");
		expect(html).toContain('data-testid="billing-storage-used"');
		expect(html).toContain("2 KB");
	});

	it("shows entitlement feature chips + grace status for a paid plan", () => {
		const html = renderToStaticMarkup(<PlanGroup overview={PRO_OVERVIEW} />);
		expect(html).toContain('data-testid="billing-features"');
		expect(html).toContain("Hosted relay");
		expect(html).toContain("Bundled AI credits");
		expect(html).toContain("Grace period");
		// No storage-used row when the inventory is unknown.
		expect(html).not.toContain('data-testid="billing-storage-used"');
	});

	it("never renders raw i18n keys", () => {
		const html = renderToStaticMarkup(<PlanGroup overview={PRO_OVERVIEW} />);
		expect(html).not.toContain("shell.settings.billing");
	});
});

describe("<LinkForm> (no account linked)", () => {
	it("renders the credential input, link CTA, and portal button", () => {
		const html = renderToStaticMarkup(
			<LinkForm busy={false} failure={null} onLink={() => {}} onOpenPortal={() => {}} />,
		);
		expect(html).toContain('data-testid="billing-link-form"');
		expect(html).toContain('type="password"');
		expect(html).toContain('data-testid="billing-link-submit"');
		expect(html).toContain('data-testid="billing-open-portal"');
	});

	it("surfaces a link failure as an alert", () => {
		const html = renderToStaticMarkup(
			<LinkForm
				busy={false}
				failure={BillingSettingsFailure.Unauthorized}
				onLink={() => {}}
				onOpenPortal={() => {}}
			/>,
		);
		expect(html).toContain('role="alert"');
		expect(html).not.toContain("shell.settings.billing.error");
	});
});

describe("<LinkedAccount>", () => {
	const account = { id: "acct_1", email: "razor@example.com", plan: PlanTier.Pro, linkedAt: 1 };

	it("renders email, id, live billing status, and the action row", () => {
		const html = renderToStaticMarkup(
			<LinkedAccount
				account={account}
				summary={{
					accountId: "acct_1",
					email: "razor@example.com",
					plan: PlanTier.Pro,
					billingStatus: BillingAccountStatus.PastDue,
				}}
				summaryFailure={null}
				busy={false}
				onRefresh={() => {}}
				onUnlink={() => {}}
				onOpenPortal={() => {}}
				onCheckout={() => {}}
			/>,
		);
		expect(html).toContain("razor@example.com");
		expect(html).toContain("acct_1");
		expect(html).toContain("Payment past due");
		expect(html).toContain('data-testid="billing-checkout"');
		expect(html).toContain('data-testid="billing-unlink"');
		expect(html).toContain('data-testid="billing-open-portal"');
	});

	it("falls back to the cached account email when the summary hasn't landed", () => {
		const html = renderToStaticMarkup(
			<LinkedAccount
				account={account}
				summary={null}
				summaryFailure={BillingSettingsFailure.Offline}
				busy={false}
				onRefresh={() => {}}
				onUnlink={() => {}}
				onOpenPortal={() => {}}
				onCheckout={() => {}}
			/>,
		);
		expect(html).toContain("razor@example.com");
		expect(html).toContain('data-testid="billing-summary-error"');
	});
});

describe("<InvoicesGroup>", () => {
	const invoice: BillingInvoiceView = {
		id: "in_1",
		amountPaidCents: 1200,
		currency: "usd",
		status: "paid",
		hostedInvoiceUrl: "https://invoice.stripe.com/i/1",
		createdMs: Date.UTC(2026, 5, 15),
	};

	it("renders rows with formatted amount + a view deep link", () => {
		const html = renderToStaticMarkup(
			<InvoicesGroup invoices={[invoice]} failure={null} portalUrl="https://p" />,
		);
		expect(html).toContain('data-testid="billing-invoices"');
		expect(html).toContain(formatInvoiceAmount(invoice));
		expect(html).toContain("paid");
	});

	it("renders the empty state", () => {
		const html = renderToStaticMarkup(
			<InvoicesGroup invoices={[]} failure={null} portalUrl="https://p" />,
		);
		expect(html).toContain('data-testid="billing-invoices-empty"');
	});

	it("falls back to the portal link on failure", () => {
		const html = renderToStaticMarkup(
			<InvoicesGroup invoices={null} failure={BillingSettingsFailure.Offline} portalUrl="https://p" />,
		);
		expect(html).toContain('role="status"');
		expect(html).not.toContain("shell.settings.billing.invoices.openPortal");
	});
});

describe("formatting helpers", () => {
	it("formats cents as currency (or a sane fallback)", () => {
		const formatted = formatInvoiceAmount({
			id: "in",
			amountPaidCents: 1250,
			currency: "usd",
			status: "paid",
			hostedInvoiceUrl: null,
			createdMs: 0,
		});
		expect(formatted).toMatch(/12[.,]50/);
	});

	it("survives an invalid currency code", () => {
		const formatted = formatInvoiceAmount({
			id: "in",
			amountPaidCents: 500,
			currency: "???",
			status: "paid",
			hostedInvoiceUrl: null,
			createdMs: 0,
		});
		expect(formatted).toContain("5.00");
	});

	it("renders an em-dash for an invalid date", () => {
		expect(formatInvoiceDate(Number.NaN)).toBe("—");
	});
});
