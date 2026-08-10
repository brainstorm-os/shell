/**
 * Fancy-menus migration — the editor block action menu (right-click a block /
 * gutter grip) now renders through the shared fancy-menus runtime instead of
 * the hand-rolled `.bs-editor__action-menu` popup. Right-clicking a block in
 * Notes opens the themed `.fm-menu` with the "Turn into" section + commands,
 * each keeping its Phosphor icon.
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
			await bs.vaults.create({ name: "fm-block", path: `${d}/vault` });
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

test.describe("fancy-menus editor block action menu", () => {
	test("right-clicking a block opens the shared menu with sections + icons", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-block-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });

				// Right-click a paragraph in the editor body.
				const block = notes.locator('[contenteditable="true"] p').first();
				await block.waitFor({ state: "visible", timeout: 20_000 });
				await block.click({ button: "right" });

				const menu = notes.locator('.fm-menu[role="menu"]');
				await menu.waitFor({ state: "visible", timeout: 10_000 });
				// Section header + a Turn-into command, each row keeping its glyph.
				await expect(menu.getByText("Turn into", { exact: false })).toBeVisible();
				expect(await menu.locator(".fm-row__icon").count()).toBeGreaterThan(0);

				// Let the open animation settle, then confirm it stays open (no
				// spurious auto-close) before the screenshot.
				await notes.waitForTimeout(450);
				await expect(menu).toBeVisible();
				await notes.screenshot({ path: "tests/perf/results/fancy-menus-editor-block.png" });

				await notes.keyboard.press("Escape");
				await menu.waitFor({ state: "hidden", timeout: 5_000 });
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
