/**
 * Stage 8.8 follow-up — the Bookmarks detail header gains a ⋯ object-menu
 * button (the standard cross-app affordance). Opening a bookmark and clicking
 * the header ⋯ opens the shared object menu (now icon-bearing) as a themed
 * fancy-menu, identical to the card ⋯ / right-click.
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
			await bs.vaults.create({ name: "fm-verify", path: `${d}/vault` });
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

test.describe("fancy-menus bookmark detail header ⋯", () => {
	test("opening a bookmark shows a header ⋯ that opens the object menu", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-bm-"));
		try {
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

				// Open the bookmark's detail via its title.
				const cardTitle = bm.locator(".bookmarks__card[data-entity-id] .bookmarks__card-title").first();
				await cardTitle.waitFor({ state: "visible", timeout: 15_000 });
				await cardTitle.click();

				// The detail header now carries the object ⋯ — and it's the LAST
				// (rightmost) child of the header-right group (cross-app rule:
				// content actions + panel toggles first, ⋯ last).
				const headerMore = bm.locator(".bookmarks__header-more");
				await headerMore.waitFor({ state: "visible", timeout: 10_000 });
				const moreIsLast = await bm.evaluate(() => {
					const right = document.querySelector("#bookmarks-header-right");
					return right?.lastElementChild?.classList.contains("bookmarks__header-more") ?? false;
				});
				expect(moreIsLast).toBe(true);

				await headerMore.click();

				const menu = bm.locator('.fm-menu[role="menu"]');
				await menu.waitFor({ state: "visible", timeout: 10_000 });
				await expect(menu.getByText("Open", { exact: true })).toBeVisible();
				// The "reload from source" / "capture content" data-refresh action.
				await expect(
					menu.getByText(/Reload from source|Capture content/, { exact: false }),
				).toBeVisible();
				// Items render their glyphs.
				expect(await menu.locator(".fm-row__icon").count()).toBeGreaterThan(0);

				// While open, the ⋯ trigger carries the active/open state
				// (`aria-expanded="true"` → its CSS lifts it to full opacity +
				// hover background) so it reads as the source of the menu.
				await expect(headerMore).toHaveAttribute("aria-expanded", "true");

				// The menu anchors at the ⋯ button (NOT centred — the regression
				// was passing position.fixedX/Y, which the runtime ignores, so
				// every menu dropped in the viewport centre) AND right-aligns: its
				// right edge sticks to the button's right edge instead of drifting
				// left. The header sits at the top, so it opens just below it.
				const btnBox = await headerMore.boundingBox();
				const menuBox = await menu.boundingBox();
				const viewport = await bm.evaluate(() => ({
					width: window.innerWidth,
					height: window.innerHeight,
				}));
				expect(btnBox && menuBox && viewport).toBeTruthy();
				if (btnBox && menuBox && viewport) {
					// Vertically attached to the header, far from the vertical centre.
					expect(menuBox.y).toBeLessThan(btnBox.y + btnBox.height + 24);
					expect(menuBox.y).toBeLessThan(viewport.height / 2 - 40);
					// Right edge of the menu aligns to the right edge of the button.
					const menuRight = menuBox.x + menuBox.width;
					const btnRight = btnBox.x + btnBox.width;
					expect(Math.abs(menuRight - btnRight)).toBeLessThan(8);
				}

				await bm.screenshot({ path: "tests/perf/results/fancy-menus-bookmark-header.png" });

				await bm.keyboard.press("Escape");
				await menu.waitFor({ state: "hidden", timeout: 5_000 });
				// Closing clears the trigger's open state.
				await expect(headerMore).not.toHaveAttribute("aria-expanded", "true");
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
