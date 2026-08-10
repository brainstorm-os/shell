/**
 * Slash-menu row chrome — the editor's caret typeaheads hand-roll their rows as
 * `<button class="fm-row">` (the fancy-menus runtime can't be used: its list
 * body auto-focuses on mount and would steal focus from the editor). The
 * runtime's base `.fm-row` rule only ever styled `<div role="option">` rows, so
 * it never reset native button chrome — in a dark theme the UA border rendered
 * as a glaring light outline around every row. The `button.fm-row` reset in the
 * SDK menu bridge normalizes button rows to match the runtime's div rows.
 *
 * This guards the fix: the slash menu's row buttons must have zero border width
 * and a transparent (non-native) background.
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
			await bs.vaults.create({ name: "slash-chrome", path: `${d}/vault` });
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

test.describe("slash menu row chrome", () => {
	test("hand-rolled fm-row buttons drop native border + fill", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-slash-chrome-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });

				// Drop the caret into an empty trailing paragraph and open the
				// slash menu with a single `/` keypress.
				const editor = notes.locator('[contenteditable="true"]').first();
				await editor.waitFor({ state: "visible", timeout: 20_000 });
				await editor.click();
				await notes.keyboard.press("End");
				await notes.keyboard.press("Enter");
				await notes.keyboard.type("/");

				const menu = notes.locator(".bs-editor__slash-menu");
				await menu.waitFor({ state: "visible", timeout: 10_000 });
				const firstRow = menu.locator("button.fm-row").first();
				await firstRow.waitFor({ state: "visible", timeout: 5_000 });
				// Row 0 is auto-highlighted (accent fill), so probe an idle row for
				// the transparent base background.
				const idleRow = menu.locator('button.fm-row:not([data-active="true"])').first();
				await idleRow.waitFor({ state: "visible", timeout: 5_000 });

				const chrome = await firstRow.evaluate((el) => {
					const cs = getComputedStyle(el);
					return {
						borderTopWidth: cs.borderTopWidth,
						borderBottomWidth: cs.borderBottomWidth,
						borderLeftWidth: cs.borderLeftWidth,
						borderRightWidth: cs.borderRightWidth,
						backgroundColor: cs.backgroundColor,
						appearance: cs.appearance,
					};
				});

				// Native button chrome is gone: no border, no UA appearance.
				expect(chrome.borderTopWidth).toBe("0px");
				expect(chrome.borderBottomWidth).toBe("0px");
				expect(chrome.borderLeftWidth).toBe("0px");
				expect(chrome.borderRightWidth).toBe("0px");
				expect(chrome.appearance).toBe("none");
				// An idle (non-highlighted) row has a transparent base fill — it sits
				// on the menu glass, not the grey UA button surface.
				const idleBg = await idleRow.evaluate((el) => getComputedStyle(el).backgroundColor);
				expect(idleBg).toMatch(/rgba?\(0, 0, 0, 0\)|transparent/);

				// The command label must never be the part that ellipsizes — a long
				// description (the caption) used to collapse names to "2 col…". Every
				// visible label renders its full text (no horizontal clipping).
				const clippedNames = await menu.locator(".fm-row__name").evaluateAll((els) =>
					els
						.filter((el) => (el as HTMLElement).offsetParent !== null)
						.filter((el) => el.scrollWidth > el.clientWidth + 1)
						.map((el) => el.textContent),
				);
				expect(clippedNames).toEqual([]);

				await notes.waitForTimeout(300);
				await notes.screenshot({ path: "tests/perf/results/slash-menu-row-chrome.png" });

				await notes.keyboard.press("Escape");
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
