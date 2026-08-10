/**
 * Fancy-menus migration — the inline format toolbar (selection bubble) + its
 * colour picker now sit on the shared `.fm-menu` glass surface, so the editor
 * toolbars read as one family with every menu (the buttons keep their toolbar
 * shape; the chrome is unified).
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
			await bs.vaults.create({ name: "fm-fmt", path: `${d}/vault` });
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

test.describe("fancy-menus inline format toolbar", () => {
	test("selecting text shows the format toolbar on the shared glass surface", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-fmt-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const para = notes.locator('[contenteditable="true"] p').first();
				await para.waitFor({ state: "visible", timeout: 20_000 });

				// Select a paragraph → the inline format toolbar appears.
				await para.click({ clickCount: 3 });

				const toolbar = notes.locator(".notes__inline-toolbar.fm-menu");
				await toolbar.waitFor({ state: "visible", timeout: 10_000 });
				await notes.waitForTimeout(300);
				await notes.screenshot({ path: "tests/perf/results/fancy-menus-format-toolbar.png" });
				// It carries the shared glass surface (backdrop-filter via .fm-menu).
				const hasGlass = await toolbar.evaluate((el) => getComputedStyle(el).backdropFilter !== "none");
				expect(hasGlass).toBe(true);
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
