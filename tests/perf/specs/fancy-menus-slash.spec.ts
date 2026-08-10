/**
 * Fancy-menus migration — the editor slash `/` command menu now renders through
 * the shared fancy-menus runtime (a Custom-body editor-typeahead) instead of
 * the hand-rolled `.bs-editor__slash-menu` listbox. Critically it must NOT
 * steal focus: typing AFTER the `/` keeps filtering the list (proof the editor
 * kept focus + still owns the query + keyboard).
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
			await bs.vaults.create({ name: "fm-slash", path: `${d}/vault` });
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

test.describe("fancy-menus slash command menu", () => {
	test("typing / opens the shared typeahead and keeps editor focus while filtering", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-slash-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const editor = notes.locator('[contenteditable="true"]').first();
				await editor.waitFor({ state: "visible", timeout: 20_000 });

				// Fresh empty paragraph at the end, then trigger the slash menu.
				await editor.click();
				await notes.keyboard.press("ControlOrMeta+ArrowDown");
				await notes.keyboard.press("Enter");
				await notes.keyboard.type("/");

				const menu = notes.locator('.fm-menu[role="listbox"]');
				await menu.waitFor({ state: "visible", timeout: 10_000 });
				const rowsAll = await menu.locator(".fm-row").count();
				expect(rowsAll).toBeGreaterThan(3);
				// Rows keep their Phosphor glyphs.
				expect(await menu.locator(".fm-row__icon").count()).toBeGreaterThan(0);

				// Typing AFTER the "/" must keep filtering — only possible if the
				// editor retained focus (the menu did NOT steal it).
				await notes.keyboard.type("todo");
				await expect(menu.getByText("To-do list", { exact: false })).toBeVisible();
				const rowsFiltered = await menu.locator(".fm-row").count();
				expect(rowsFiltered).toBeLessThan(rowsAll);

				await notes.waitForTimeout(350);
				await expect(menu).toBeVisible();
				await notes.screenshot({ path: "tests/perf/results/fancy-menus-slash.png" });

				// Activating the row applies the command → a to-do block appears and
				// the menu closes. (Clicking exercises the same activate() path as
				// Enter; ↑/↓/Enter keyboard nav is covered by the plugin unit tests.)
				await menu.getByText("To-do list", { exact: false }).click();
				await menu.waitFor({ state: "hidden", timeout: 5_000 });
				await expect(notes.locator('[contenteditable="true"] [role="checkbox"]').first()).toBeVisible({
					timeout: 5_000,
				});
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
