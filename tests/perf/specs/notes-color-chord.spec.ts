/**
 * B11.6 — the colour-menu chords (`Mod+Shift+C` / `Mod+Shift+H`). With text
 * selected, either chord opens the inline toolbar's text/highlight colour
 * menu. Verified in the real shell.
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
			await bs.vaults.create({ name: "fm-color-chord", path: `${d}/vault` });
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

test.describe("notes colour chord (B11.6)", () => {
	test("Mod+Shift+C opens the colour menu for the selection", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-color-chord-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const para = notes.locator('[contenteditable="true"] p').first();
				await para.waitFor({ state: "visible", timeout: 20_000 });

				// Select text so the inline toolbar is showing, then fire the chord.
				await para.click({ clickCount: 3 });
				await expect
					.poll(() => notes.evaluate(() => (window.getSelection()?.toString() ?? "").length))
					.toBeGreaterThan(0);
				await expect(notes.locator(".notes__inline-toolbar")).toBeVisible({ timeout: 5_000 });

				await notes.keyboard.press("ControlOrMeta+Shift+C");
				await expect(notes.locator(".notes__color-menu")).toBeVisible({ timeout: 5_000 });
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
