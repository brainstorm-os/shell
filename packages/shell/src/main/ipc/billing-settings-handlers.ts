/**
 * Billing settings privileged IPC (14.6 — Settings → Billing panel).
 *
 * Dashboard-only, direct ipcMain (like `ai-settings:*` / `update:*`) — the
 * account link is an app-global concern, not a per-app brokered capability.
 * The handlers are thin: every decision (credential custody, account.db
 * writes, billing-edge calls, fail-soft reasons) lives in the injected
 * `BillingAccountService`, which is the tested unit. The refresh credential
 * crosses this boundary exactly once, inward, on `link`; it is never
 * returned to any renderer.
 */

import type {
	BillingAccountSummaryView,
	BillingInvoiceView,
	BillingOverviewView,
	BillingSettingsResult,
} from "@brainstorm-os/protocol/billing-settings-types";
import { ipcMain } from "electron";
import type { BillingAccountService } from "../billing/billing-account";

export const BILLING_OVERVIEW_CHANNEL = "billing-settings:overview" as const;
export const BILLING_LINK_CHANNEL = "billing-settings:link" as const;
export const BILLING_UNLINK_CHANNEL = "billing-settings:unlink" as const;
export const BILLING_REFRESH_CHANNEL = "billing-settings:refresh" as const;
export const BILLING_INVOICES_CHANNEL = "billing-settings:invoices" as const;
export const BILLING_CHECKOUT_CHANNEL = "billing-settings:checkout" as const;

export function registerBillingSettingsHandlers(service: BillingAccountService): void {
	ipcMain.handle(
		BILLING_OVERVIEW_CHANNEL,
		async (): Promise<BillingOverviewView | null> => service.overview(),
	);

	ipcMain.handle(
		BILLING_LINK_CHANNEL,
		async (_event, credential: unknown): Promise<BillingSettingsResult<BillingAccountSummaryView>> =>
			service.link(credential),
	);

	ipcMain.handle(BILLING_UNLINK_CHANNEL, async (): Promise<boolean> => service.unlink());

	ipcMain.handle(
		BILLING_REFRESH_CHANNEL,
		async (): Promise<BillingSettingsResult<BillingAccountSummaryView>> => service.refreshSummary(),
	);

	ipcMain.handle(
		BILLING_INVOICES_CHANNEL,
		async (): Promise<BillingSettingsResult<readonly BillingInvoiceView[]>> => service.invoices(),
	);

	ipcMain.handle(
		BILLING_CHECKOUT_CHANNEL,
		async (_event, plan: unknown, cycle: unknown): Promise<BillingSettingsResult<string>> =>
			service.checkout(plan, cycle),
	);
}
