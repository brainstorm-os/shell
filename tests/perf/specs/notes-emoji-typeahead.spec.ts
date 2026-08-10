/**
 * B11.1 — `:`-shortcode emoji typeahead in the Notes editor. Typing `:grin`
 * at a word boundary opens the anchored fancy-menus picker; picking a row
 * splices the `:query` span out and drops the glyph in. Verified end-to-end
 * in the real shell.
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
			await bs.vaults.create({ name: "fm-emoji", path: `${d}/vault` });
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

test.describe("notes emoji typeahead (B11.1)", () => {
	test("typing `:grin` opens the picker; picking inserts the glyph", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-emoji-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const para = notes.locator('[contenteditable="true"] p').last();
				await para.waitFor({ state: "visible", timeout: 20_000 });

				// Caret into an empty-ish paragraph, then type the trigger query.
				await para.click();
				await notes.keyboard.type(":grin");

				const menu = notes.locator(".notes__mention-menu").first();
				await expect(menu).toBeVisible({ timeout: 5_000 });
				const firstRow = menu.locator(".fm-row").first();
				await expect(firstRow).toBeVisible({ timeout: 5_000 });

				// Pick the top match — the `:grin` span is replaced by the glyph,
				// so no literal ":grin" survives in the block.
				await firstRow.click();
				await expect(menu).toBeHidden({ timeout: 5_000 });
				await expect.poll(() => para.evaluate((el) => el.textContent ?? "")).not.toContain(":grin");
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
