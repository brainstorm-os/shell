/**
 * Guard: Settings → Billing (14.6) renders end-to-end in a real shell —
 * the section is reachable from the sidebar nav, the signed-out state shows
 * the Free plan + the explanatory disabled upgrade CTA + the link form, and
 * the whole panel is keyboard-reachable (sidebar listbox typeahead). Runs
 * against a freshly built shell like the other settings specs.
 *
 * Set BILLING_SHOT=/abs/path.png to also write a screenshot of the panel.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launchShell } from "../lib/launch-shell";

type VaultApi = {
	vaults: {
		list: () => Promise<Array<{ id: string }>>;
		create: (opts: { name: string; path: string }) => Promise<unknown>;
		activate: (id: string) => Promise<unknown>;
		session: () => Promise<unknown>;
	};
};

// Vault-only setup — the Billing panel needs no seeded demo apps, and this
// spec must run in a worktree where the app bundles may not be built.
async function ensureVault(dashboard: Page, userDataDir: string): Promise<void> {
	await dashboard.evaluate(
		async ({ userDataDir }) => {
			const bs = (window as unknown as { brainstorm: VaultApi }).brainstorm;
			const list = await bs.vaults.list();
			let session = await bs.vaults.session();
			if (list.length === 0) {
				await bs.vaults.create({ name: "billing-fixture", path: [userDataDir, "vault"].join("/") });
				session = await bs.vaults.session();
			} else if (!session && list[0]) {
				await bs.vaults.activate(list[0].id);
				session = await bs.vaults.session();
			}
			if (!session) throw new Error("billing spec: no active vault after setup");
		},
		{ userDataDir },
	);
	await dashboard.reload({ waitUntil: "domcontentloaded" });
	await dashboard.waitForSelector(".dashboard", { state: "visible", timeout: 30_000 });
}

test("settings → billing renders the signed-out plan/account/link state", async () => {
	test.setTimeout(3 * 60 * 1000);
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-billing-ui-"));
	let app: ElectronApplication | null = null;
	try {
		const launched = await launchShell({ userDataDir });
		app = launched.app;
		const dashboard = await app.firstWindow({ timeout: 60_000 });
		await dashboard.waitForLoadState("load", { timeout: 60_000 });
		await ensureVault(dashboard, userDataDir);

		// Dismiss the "What's New" release popover that pops on a fresh launch.
		await dashboard.keyboard.press("Escape").catch(() => {});
		await dashboard.waitForTimeout(500);

		// Open Settings → Billing via the sidebar nav.
		await dashboard.locator('.dashboard__header-right button[aria-label="Settings"]').click();
		await dashboard.waitForSelector(".settings__nav", { state: "visible", timeout: 15_000 });
		await dashboard.locator(".settings__nav-item", { hasText: "Billing" }).first().click();

		// Plan group: signed-out = Free, entitlement verified, no relay.
		const planName = dashboard.locator('[data-testid="billing-plan-name"]');
		await expect(planName).toBeVisible({ timeout: 15_000 });
		await expect(planName).toHaveText("Free");

		// Account group: no link → explanatory line + DISABLED upgrade CTA +
		// credential link form + portal deep-link button.
		await expect(dashboard.locator('[data-testid="billing-checkout-disabled"]')).toBeDisabled();
		await expect(dashboard.locator('[data-testid="billing-upgrade-locked"]')).toBeVisible();
		await expect(dashboard.locator('[data-testid="billing-link-form"]')).toBeVisible();
		await expect(dashboard.locator('[data-testid="billing-open-portal"]')).toBeEnabled();

		// No invoices group without a linked account.
		await expect(dashboard.locator('[data-testid="billing-invoices"]')).toHaveCount(0);

		// Keyboard path: the sidebar listbox roving focus reaches Billing —
		// focus the active nav option and walk with ArrowUp from the bottom
		// neighbour (Network) back to Billing.
		await dashboard.locator(".settings__nav-item", { hasText: "Network" }).first().click();
		await dashboard.locator(".settings__nav-item", { hasText: "Network" }).first().focus();
		await dashboard.keyboard.press("ArrowUp");
		await expect(dashboard.locator('[data-testid="billing-plan-name"]')).toBeVisible({
			timeout: 10_000,
		});

		const shotPath = process.env.BILLING_SHOT;
		if (shotPath) {
			await dashboard.screenshot({ path: shotPath });
		}
	} finally {
		await app?.close().catch(() => {});
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
