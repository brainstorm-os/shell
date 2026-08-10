/**
 * Fancy-menus migration — the Whiteboard "Add" and "Export ▾" toolbar menus
 * now open the shared fancy-menus popup (consistent glass chrome / escape-stack
 * / anchoring) instead of hand-rolled `hidden`-toggled `<div role="menu">`s.
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
			await bs.vaults.create({ name: "fm-wb", path: `${d}/vault` });
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

test.describe("fancy-menus whiteboard toolbar menus", () => {
	test("Add + Export triggers open the shared fancy-menu", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-wb-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const wb = await openAppFromDashboard(app, dashboard, { label: "Whiteboard" });
				const menu = wb.locator('.fm-menu[role="menu"]');

				// Add menu.
				const add = wb.locator(".whiteboard__add-trigger");
				await add.waitFor({ state: "visible", timeout: 15_000 });
				await add.click();
				await menu.waitFor({ state: "visible", timeout: 10_000 });
				await expect(menu.getByText("Sticky note", { exact: false })).toBeVisible();
				// The Add rows keep their glyphs (whiteboard's own SVG family fed
				// through the SDK glyphIconParam → fancy-menus IconParam).
				expect(await menu.locator(".fm-row__icon").count()).toBeGreaterThan(0);
				await wb.keyboard.press("Escape");
				await menu.waitFor({ state: "hidden", timeout: 5_000 });

				// Export menu.
				const exportBtn = wb.locator(".whiteboard__export-trigger");
				await exportBtn.click();
				await menu.waitFor({ state: "visible", timeout: 10_000 });
				await expect(menu.getByText("Copy as SVG", { exact: false })).toBeVisible();

				await wb.screenshot({ path: "tests/perf/results/fancy-menus-whiteboard.png" });
				await wb.keyboard.press("Escape");
				await menu.waitFor({ state: "hidden", timeout: 5_000 });
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
