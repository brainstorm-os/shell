/**
 * B11.19 — slash menu organised into sections by block type. A bare `/`
 * (browse mode) renders the shared typeahead menu with `.fm-section`
 * headers in the taxonomy order; typing a query collapses to the flat
 * ranked list (no headers) so Enter still commits the best match.
 * Verified in the real shell.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForDashboard } from "../lib/keyboard-assertions";
import { launchShell } from "../lib/launch-shell";
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
			await bs.vaults.create({ name: "fm-slash-sections", path: `${d}/vault` });
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

async function launchApp(app: ElectronApplication, dashboard: Page, label: string): Promise<Page> {
	const whatsNew = dashboard.locator(".popover");
	if (await whatsNew.isVisible().catch(() => false)) {
		await dashboard.keyboard.press("Escape");
		await whatsNew.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
	}
	const icon = dashboard.locator(".dashboard-icons__icon", { hasText: label }).first();
	await icon.waitFor({ state: "visible", timeout: 10_000 });
	const [win] = await Promise.all([app.waitForEvent("window"), icon.click()]);
	await win.waitForLoadState("domcontentloaded");
	return win;
}

test.describe("notes slash-menu sections (B11.19)", () => {
	test("bare `/` groups by block type; a query flattens to the ranked list", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-slash-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await launchApp(app, dashboard, "Notes");
				const para = notes.locator('[contenteditable="true"] p').first();
				await para.waitFor({ state: "visible", timeout: 20_000 });

				// A fresh empty line, then the bare `/` — browse mode.
				await para.click();
				await notes.keyboard.press("ControlOrMeta+ArrowDown");
				await notes.keyboard.press("Enter");
				await notes.keyboard.type("/");

				const menu = notes.locator(".fm-menu");
				await menu.waitFor({ state: "visible", timeout: 10_000 });
				const headers = notes.locator(".fm-menu .fm-section");
				await expect.poll(() => headers.count()).toBeGreaterThanOrEqual(4);
				const headerText = (await headers.allTextContents()).map((s) => s.trim());
				// Taxonomy order (SLASH_SECTION_ORDER) — Basic first, Lists second.
				expect(headerText[0]).toBe("Basic blocks");
				expect(headerText[1]).toBe("Lists");
				expect(headerText).toContain("Media");
				expect(headerText).toContain("Embeds");
				await notes.screenshot({
					path: "test-results/slash-sections-browse.png",
					fullPage: false,
				});

				// Keyboard path: the highlight starts on the first command (after
				// the header row) and Enter commits it even with headers around.
				await notes.keyboard.type("head");
				// Filter mode: headers gone, flat ranked list, best match first.
				await expect.poll(() => headers.count()).toBe(0);
				const firstRow = notes.locator(".fm-menu .bs-typeahead-row").first();
				await expect(firstRow).toContainText("Heading 1");
				await notes.screenshot({
					path: "test-results/slash-sections-filter.png",
					fullPage: false,
				});

				// Enter turns the block into an H1 — the ranked commit is intact.
				await notes.keyboard.press("Enter");
				await expect
					.poll(() => notes.locator('[contenteditable="true"] h1').count())
					.toBeGreaterThan(0);
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
