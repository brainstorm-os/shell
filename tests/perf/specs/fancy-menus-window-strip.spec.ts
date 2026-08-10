/**
 * Fancy-menus migration — the dashboard running-windows strip's right-click
 * context menu (minimize / tile / move-to-display / close) now renders through
 * the shared fancy-menus runtime instead of a hand-rolled `position:fixed`
 * popup. Right-clicking a window tile opens the themed `.fm-menu`, anchored at
 * the cursor, carrying the Close action.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForDashboard } from "../lib/keyboard-assertions";
import { launchShell, openAppFromDashboard } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";

async function openSeededDashboard(page: Page, userDataDir: string): Promise<void> {
	await page.evaluate(
		async ({ d }) => {
			const bs = (
				window as unknown as {
					brainstorm: {
						vaults: {
							create: (o: { name: string; path: string }) => Promise<unknown>;
							session: () => Promise<unknown>;
						};
					};
				}
			).brainstorm;
			await bs.vaults.create({ name: "fm-strip", path: `${d}/vault` });
			await bs.vaults.session();
		},
		{ d: userDataDir },
	);
	await page.reload();
	await waitForDashboard(page);
	await page.evaluate(async () => {
		await (
			window as unknown as { brainstorm: { dev: { seedDemoApps: () => Promise<unknown> } } }
		).brainstorm.dev.seedDemoApps();
	});
}

test.describe("fancy-menus window-strip context menu", () => {
	test("right-clicking a window tile opens the shared menu at the cursor", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-strip-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				// Open any app so the running-windows strip has a tile.
				await openAppFromDashboard(app, dashboard);

				const tile = dashboard.locator(".window-strip__tile").first();
				await tile.waitFor({ state: "visible", timeout: 15_000 });
				await tile.click({ button: "right" });

				const menu = dashboard.locator('.fm-menu[role="menu"]');
				await menu.waitFor({ state: "visible", timeout: 10_000 });
				await expect(menu.getByText("Close window", { exact: true })).toBeVisible();
				await expect(menu.getByText("Minimize", { exact: true })).toBeVisible();

				await dashboard.screenshot({ path: "tests/perf/results/fancy-menus-window-strip.png" });

				await dashboard.keyboard.press("Escape");
				await menu.waitFor({ state: "hidden", timeout: 5_000 });
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
