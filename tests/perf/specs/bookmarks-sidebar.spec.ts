/**
 * Bookmarks sidebar + card-chrome changes, driven against the real shell:
 *   - tags show by default in the left panel (every surface, not just Tags);
 *   - "Add bookmark" is a header "+" button (sidebar add button is gone);
 *   - the flat card list is virtualized (windowed live DOM);
 *   - each card's only trailing affordance is the hover-revealed ⋯ object menu
 *     (the always-visible read/archive icon cluster is gone — those actions
 *     moved into the menu).
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
			await bs.vaults.create({ name: "bm-sidebar", path: `${d}/vault` });
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

async function addBookmark(bm: Page, url: string): Promise<void> {
	await bm.locator(".bookmarks__header-add").first().click();
	const input = bm.locator(".bookmarks__form-input").first();
	await input.waitFor({ state: "visible", timeout: 10_000 });
	await input.fill(url);
	await bm.locator('button[type="submit"][data-bs-primary]').click();
	await input.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
}

test.describe("bookmarks sidebar + card chrome", () => {
	test("tags-by-default, header +, virtualized cards, hover-only ⋯", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-bm-sidebar-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const bm = await openAppFromDashboard(app, dashboard, { label: "Bookmarks" });

				// On the default (Inbox) surface, the tag list shows — it is no
				// longer gated to the Tags surface. The old sidebar add button is
				// gone; the header carries a "+".
				const tagScroll = bm.locator(".bookmarks__tag-scroll");
				await tagScroll.waitFor({ state: "visible", timeout: 15_000 });
				await expect(bm.locator(".bookmarks__nav-btn[aria-selected='true']")).toContainText(/Inbox/i);
				await expect(bm.locator(".bookmarks__tag-list-btn").first()).toBeVisible();
				await expect(bm.locator(".bookmarks__add-btn")).toHaveCount(0);
				await expect(bm.locator(".bookmarks__header-add")).toBeVisible();

				// The header "+" opens the compose form.
				await bm.locator(".bookmarks__header-add").first().click();
				const composeInput = bm.locator(".bookmarks__form-input").first();
				await expect(composeInput).toBeVisible({ timeout: 10_000 });
				await bm.keyboard.press("Escape");
				await composeInput.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);

				// Add enough bookmarks to overflow the viewport, then assert the flat
				// card list is windowed: the SDK spacer is sized, and the live card
				// count is well under the total added.
				const TOTAL = 18;
				for (let i = 0; i < TOTAL; i++) {
					await addBookmark(bm, `https://example.com/page-${i}`);
				}
				const scroll = bm.locator(".bookmarks__card-scroll");
				await scroll.waitFor({ state: "visible", timeout: 15_000 });
				const spacer = scroll.locator(".bs-vlist__spacer");
				await expect(spacer).toHaveCount(1);
				const spacerHeight = await spacer.evaluate((el) => (el as HTMLElement).offsetHeight);
				expect(spacerHeight).toBeGreaterThan(TOTAL * 40);
				const liveCards = await bm.locator(".bookmarks__card").count();
				expect(liveCards).toBeGreaterThan(0);
				expect(liveCards).toBeLessThan(TOTAL);

				// Each card's trailing chrome is ONLY the ⋯ (the read/archive icon
				// buttons are gone), and it's hidden until hover/focus.
				const firstCard = bm.locator(".bookmarks__card").first();
				const actions = firstCard.locator(".bookmarks__card-actions");
				await expect(actions.locator("button")).toHaveCount(1);
				const restingOpacity = await actions.evaluate(
					(el) => getComputedStyle(el as HTMLElement).opacity,
				);
				expect(Number(restingOpacity)).toBeLessThan(0.05);
				await firstCard.hover();
				await expect
					.poll(async () => Number(await actions.evaluate((el) => getComputedStyle(el).opacity)))
					.toBeGreaterThan(0.9);

				// The ⋯ opens the object menu, which now carries the lifecycle
				// actions (Mark read / Archive) that used to be separate icons.
				await actions.locator("button").first().click();
				const menu = bm.locator('.fm-menu[role="menu"]');
				await menu.waitFor({ state: "visible", timeout: 10_000 });
				await expect(menu.getByText(/Mark read|Mark unread/i)).toBeVisible();
				await expect(menu.getByText(/Archive/i)).toBeVisible();
				await bm.keyboard.press("Escape");

				await bm.screenshot({ path: "tests/perf/results/bookmarks-sidebar.png" });
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
