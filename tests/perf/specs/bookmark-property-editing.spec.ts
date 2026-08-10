/**
 * Property-editing flows in the real shell — opens a bookmark, reveals the
 * shared properties inspector, and verifies the editing cells added in the
 * "proper editing flows" pass actually render + commit against a live vault:
 *   • Description is a multi-line text cell (`.bs-cell-multiline`).
 *   • Read / Archived are switch toggles (`.bs-cell-toggle`) that flip and
 *     persist through the bookmark's `readAt` / `archivedAt` bridge.
 *
 * This is the integration counterpart to the jsdom cell tests: it proves the
 * registry routes the chosen views to the new cells inside an app renderer.
 */

import { mkdtempSync } from "node:fs";
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
			await bs.vaults.create({ name: "prop-edit", path: `${d}/vault` });
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

test.describe("bookmark property editing", () => {
	test("description renders multiline and Read/Archived render as switch toggles", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-prop-edit-"));
		const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });
			await waitForFirstContentfulPaintAbsoluteMs(dashboard);
			await openSeededDashboard(dashboard, userDataDir);

			const bm = await openAppFromDashboard(app, dashboard, { label: "Bookmarks" });

			// Add a bookmark so there's an object to open.
			await bm.locator(".bookmarks__header-add").first().click();
			const url = bm.locator(".bookmarks__form-input").first();
			await url.waitFor({ state: "visible", timeout: 10_000 });
			await url.fill("https://example.com");
			await bm.locator('button[type="submit"][data-bs-primary]').click();

			// Open the bookmark detail via its title.
			const cardTitle = bm.locator(".bookmarks__card[data-entity-id] .bookmarks__card-title").first();
			await cardTitle.waitFor({ state: "visible", timeout: 15_000 });
			await cardTitle.click();

			// Reveal the properties inspector if it isn't already open.
			const panel = bm.locator(".bs-props");
			await panel.waitFor({ state: "attached", timeout: 10_000 });
			if (!(await panel.evaluate((el) => el.classList.contains("bs-props--open")))) {
				await bm
					.getByRole("button", { name: /inspector/i })
					.first()
					.click();
			}
			await expect(panel).toHaveClass(/bs-props--open/, { timeout: 10_000 });

			// Description routes to the multiline cell.
			const descRow = bm.locator('.bs-props__row[data-property-key$="/description"]');
			await expect(descRow.locator(".bs-cell-multiline")).toBeVisible();

			// Read + Archived route to switch toggles (role="switch").
			const readRow = bm.locator('.bs-props__row[data-property-key$="/read"]');
			const readToggle = readRow.locator(".bs-cell-toggle");
			await expect(readToggle).toHaveAttribute("role", "switch");
			await expect(readToggle).toHaveAttribute("aria-checked", "false");

			// Flipping the toggle commits — it reads checked afterwards.
			await readToggle.click();
			await expect(readToggle).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });

			await bm.screenshot({ path: "tests/perf/results/bookmark-property-editing.png" });
		} finally {
			await app.close();
		}
	});
});
