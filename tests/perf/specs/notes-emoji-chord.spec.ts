/**
 * B11.6 — the emoji-picker chord (`Mod+Shift+E`). Pressing it inserts `:` at
 * the caret and opens the emoji typeahead in browse mode (a default list of
 * emoji before the first keystroke). Verified in the real shell.
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
			await bs.vaults.create({ name: "fm-emoji-chord", path: `${d}/vault` });
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

test.describe("notes emoji chord (B11.6)", () => {
	test("Mod+Shift+E opens the emoji picker in browse mode", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-emoji-chord-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const para = notes.locator('[contenteditable="true"] p').last();
				await para.waitFor({ state: "visible", timeout: 20_000 });

				await para.click();
				await notes.keyboard.press("ControlOrMeta+Shift+E");

				// Browse list opens with rows before any query is typed.
				const menu = notes.locator(".notes__mention-menu").first();
				await expect(menu).toBeVisible({ timeout: 8_000 });
				await expect(menu.locator(".fm-row").first()).toBeVisible({ timeout: 8_000 });
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
