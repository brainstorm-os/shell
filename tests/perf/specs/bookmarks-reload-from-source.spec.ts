/**
 * Regression — "Reload from source" must never blank an already-captured /
 * edited body. The old `captureContent` wrote `result.blocks ?? []`, so a
 * re-fetch whose extraction recovered nothing (or whose fetch was refused)
 * wiped the stored content. This drives the real shell: open a bookmark, write
 * a body, then run "Reload from source" and assert the body survives and the
 * app stays alive.
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
			await bs.vaults.create({ name: "bm-reload", path: `${d}/vault` });
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

test.describe("bookmarks reload-from-source", () => {
	test("reloading source does not blank the edited body", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-bm-reload-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const bm = await openAppFromDashboard(app, dashboard, { label: "Bookmarks" });

				// Add a bookmark + open its detail.
				await bm.locator(".bookmarks__header-add").first().click();
				const url = bm.locator(".bookmarks__form-input").first();
				await url.waitFor({ state: "visible", timeout: 10_000 });
				await url.fill("https://example.com");
				await bm.locator('button[type="submit"][data-bs-primary]').click();
				const cardTitle = bm.locator(".bookmarks__card[data-entity-id] .bookmarks__card-title").first();
				await cardTitle.waitFor({ state: "visible", timeout: 15_000 });
				await cardTitle.click();

				const body = bm.locator(".bm-detail__body [contenteditable='true']").first();
				await body.waitFor({ state: "visible", timeout: 15_000 });

				const SOURCE_MARKER = "documentation examples";
				const runDataAction = async (): Promise<void> => {
					const headerMore = bm.locator(".bookmarks__header-more");
					await headerMore.waitFor({ state: "visible", timeout: 10_000 });
					await headerMore.click();
					const menu = bm.locator('.fm-menu[role="menu"]');
					await menu.waitFor({ state: "visible", timeout: 10_000 });
					const action = menu.getByText(/Reload from source|Capture content/, { exact: false });
					await expect(action).toBeVisible();
					await action.click();
					await menu.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
				};

				// First "Capture content" — the body fills from the fetched source.
				await runDataAction();
				await expect(body).toContainText(SOURCE_MARKER, { timeout: 20_000 });

				// Now the action reads "Reload from source" (content already fetched).
				const headerMoreCheck = bm.locator(".bookmarks__header-more");
				await headerMoreCheck.click();
				const menu = bm.locator('.fm-menu[role="menu"]');
				await expect(menu.getByText("Reload from source", { exact: false })).toBeVisible({
					timeout: 10_000,
				});
				await bm.keyboard.press("Escape");
				await menu.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);

				// Reload — the body refreshes from source and is NOT blanked.
				await runDataAction();
				await bm.waitForTimeout(2_000);
				const bodyAfter = bm.locator(".bm-detail__body [contenteditable='true']").first();
				await expect(bodyAfter).toBeVisible({ timeout: 10_000 });
				await expect(bodyAfter).toContainText(SOURCE_MARKER, { timeout: 20_000 });
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
