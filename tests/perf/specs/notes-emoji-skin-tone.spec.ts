/**
 * B11.14 — skin-tone variant strip on the emoji typeahead. A humanoid emoji's
 * active row reveals five Fitzpatrick variants; clicking one inserts the toned
 * glyph (the row body inserts the neutral base). Verified in the real shell.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForDashboard } from "../lib/keyboard-assertions";
import { launchShell, openAppFromDashboard } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";

// U+1F3FB — the lightest Fitzpatrick modifier (SkinTone.Light).
const LIGHT_MODIFIER = String.fromCodePoint(0x1f3fb);

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
			await bs.vaults.create({ name: "fm-tone", path: `${d}/vault` });
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

test.describe("notes emoji skin tone (B11.14)", () => {
	test("the active humanoid row shows a tone strip; picking a tone inserts the toned glyph", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-tone-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const para = notes.locator('[contenteditable="true"] p').last();
				await para.waitFor({ state: "visible", timeout: 20_000 });

				// `:waving` ranks 👋 first — a skin-tone-supporting emoji — so its
				// row is active on open and the tone strip is shown.
				await para.click();
				await notes.keyboard.type(":waving");
				const menu = notes.locator(".notes__mention-menu").first();
				await expect(menu).toBeVisible({ timeout: 5_000 });
				const tones = menu.locator(".notes__emoji-tone");
				await expect(tones.first()).toBeVisible({ timeout: 5_000 });
				await expect(tones).toHaveCount(5);

				// Pick the lightest tone → the inserted glyph carries U+1F3FB.
				await tones.first().click();
				await expect(menu).toBeHidden({ timeout: 5_000 });
				await expect.poll(() => para.evaluate((el) => el.textContent ?? "")).toContain(LIGHT_MODIFIER);
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
