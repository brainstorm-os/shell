/**
 * B11.6 (partial) — editor chords through the Notes shortcut registry:
 * inline code (`Mod+e`), strikethrough (`Mod+Shift+S`), and the mention
 * picker (`Mod+Shift+M`). Verifies each end-to-end in the real shell —
 * the marks render a span with the theme's code/strike class; the mention
 * chord opens the typeahead.
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
			await bs.vaults.create({ name: "fm-chords", path: `${d}/vault` });
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

test.describe("notes editor format chords (B11.6)", () => {
	test("Mod+e (code), Mod+Shift+S (strike), mention, Mod+Alt+N turn-into chords", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-chords-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const para = notes.locator('[contenteditable="true"] p').first();
				await para.waitFor({ state: "visible", timeout: 20_000 });

				// Triple-click selects the whole paragraph (deterministic ranged
				// selection — avoids a typing→select race). Confirm the DOM
				// selection is non-empty before firing the chord.
				await para.click({ clickCount: 3 });
				await expect
					.poll(() => notes.evaluate(() => (window.getSelection()?.toString() ?? "").length))
					.toBeGreaterThan(0);

				// Inline-code chord → the selection gains the inline-code text
				// format (Notes renders it as a span carrying `.notes__text--code`).
				await notes.keyboard.press("ControlOrMeta+e");
				await expect(notes.locator('[contenteditable="true"] .notes__text--code').first()).toBeVisible({
					timeout: 5_000,
				});

				// Strikethrough chord — re-select the paragraph, then toggle.
				await para.click({ clickCount: 3 });
				await notes.keyboard.press("ControlOrMeta+Shift+S");
				await expect(
					notes.locator('[contenteditable="true"] .notes__text--strike').first(),
				).toBeVisible({ timeout: 5_000 });

				// Mention-picker chord — caret in the body, then Mod+Shift+M inserts
				// the `@` trigger and the typeahead opens.
				await para.click();
				await notes.keyboard.press("ControlOrMeta+Shift+M");
				await expect(notes.locator(".notes__mention-menu").first()).toBeVisible({
					timeout: 5_000,
				});
				await notes.keyboard.press("Escape");

				// Turn-into quick chord — caret in the LAST paragraph, Mod+Alt+1
				// converts it to a heading (Alt+digit resolves via event.code).
				const last = notes.locator('[contenteditable="true"] p').last();
				await last.click();
				await notes.keyboard.press("ControlOrMeta+Alt+1");
				await expect(notes.locator('[contenteditable="true"] h1').nth(1)).toBeVisible({
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
