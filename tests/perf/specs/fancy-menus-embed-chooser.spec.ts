/**
 * Fancy-menus migration — pasting a lone URL onto an empty Notes line opens
 * the Bookmark / Embed / Link chooser. It now renders through the shared
 * fancy-menus runtime (`openAnchoredMenu`) instead of the hand-rolled
 * `.notes__embed-chooser` popup.
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
			await bs.vaults.create({ name: "fm-embed", path: `${d}/vault` });
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

test.describe("fancy-menus embed chooser", () => {
	test("pasting a lone URL on an empty line opens the shared chooser menu", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-embed-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const editor = notes.locator('[contenteditable="true"]').first();
				await editor.waitFor({ state: "visible", timeout: 20_000 });

				// Land the caret in the body and open a fresh empty paragraph
				// (the chooser only triggers on a lone URL pasted onto an empty
				// block).
				await editor.click();
				await notes.keyboard.press("ControlOrMeta+ArrowDown");
				await notes.keyboard.press("Enter");

				// Dispatch a synthetic paste of a lone URL — Lexical's
				// PASTE_COMMAND fires the chooser.
				await editor.evaluate((el) => {
					const dt = new DataTransfer();
					dt.setData("text/plain", "https://example.com");
					el.dispatchEvent(
						new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
					);
				});

				const menu = notes.locator('.fm-menu[role="menu"]');
				await menu.waitFor({ state: "visible", timeout: 10_000 });
				await expect(menu.getByText("Bookmark", { exact: false })).toBeVisible();
				await expect(menu.getByText("link", { exact: false })).toBeVisible();

				await notes.waitForTimeout(400);
				await expect(menu).toBeVisible();
				await notes.screenshot({ path: "tests/perf/results/fancy-menus-embed-chooser.png" });

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
