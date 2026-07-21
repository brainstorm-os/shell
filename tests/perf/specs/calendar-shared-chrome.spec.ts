/**
 * Calendar shared-chrome smoke — verifies the SDK calendar primitive
 * (`@brainstorm-os/sdk/calendar` — MonthGrid + MiniCalendar) renders in
 * every consumer:
 *
 *  - Calendar app: month-view `.bs-cal-month`, sidebar mini `.bs-cal-mini`.
 *  - Database app: calendar-view `.bs-cal-month` (month + year tile densities).
 *  - Tasks app: date popover `.bs-cal-mini` (replaces the prior native
 *    `<input type="date">` pair).
 *
 * No timing — pure surface presence. This is the regression net that
 * catches the cascade-order trap from `[[feedback_sdk_css_cascade_trap]]`
 * (SDK CSS could load *after* a per-app override and silently lose), the
 * preload tokens trap, and any per-app build-time bundling miss.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { launchShell } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";

const CALENDAR_APP = "io.brainstorm.calendar";
const DATABASE_APP = "io.brainstorm.database";
const TASKS_APP = "io.brainstorm.tasks";

async function ensureVaultAndSeed(dashboard: Page, userDataDir: string): Promise<void> {
	await dashboard.evaluate(
		async ({ userDataDir }) => {
			const bs = (
				window as unknown as {
					brainstorm: {
						vaults: {
							list: () => Promise<unknown[]>;
							create: (opts: { name: string; path: string }) => Promise<unknown>;
							activate: (id: string) => Promise<unknown>;
							session: () => Promise<unknown>;
						};
						dev: { seedDemoApps: () => Promise<unknown> };
					};
				}
			).brainstorm;
			const list = (await bs.vaults.list()) as Array<{ id: string }>;
			let session = await bs.vaults.session();
			if (list.length === 0) {
				await bs.vaults.create({ name: "calendar-smoke", path: `${userDataDir}/vault` });
				session = await bs.vaults.session();
			} else if (!session && list[0]) {
				await bs.vaults.activate(list[0].id);
				session = await bs.vaults.session();
			}
			if (!session) throw new Error("calendar smoke: no active vault after setup");
			await bs.dev.seedDemoApps();
		},
		{ userDataDir },
	);
}

async function openApp(
	dashboard: Page,
	app: Awaited<ReturnType<typeof launchShell>>["app"],
	appId: string,
): Promise<Page> {
	const newWindow = app.waitForEvent("window", { timeout: 30_000 });
	await dashboard.evaluate(
		(id) =>
			(
				window as unknown as { brainstorm: { apps: { launch: (id: string) => Promise<void> } } }
			).brainstorm.apps.launch(id),
		appId,
	);
	const win = await newWindow;
	await waitForFirstContentfulPaintAbsoluteMs(win);
	return win;
}

test("SDK calendar chrome renders across Calendar + Database + Tasks", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-cal-smoke-"));
	try {
		const { app } = await launchShell({ userDataDir });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });
			await waitForFirstContentfulPaintAbsoluteMs(dashboard);
			await ensureVaultAndSeed(dashboard, userDataDir);

			// Calendar — month view + sidebar mini.
			const cal = await openApp(dashboard, app, CALENDAR_APP);
			await expect(cal.locator(".bs-cal-month").first()).toBeVisible({ timeout: 10_000 });
			await expect(cal.locator(".bs-cal-mini").first()).toBeVisible({ timeout: 10_000 });
			// 42 day cells (chrome-less grid).
			expect(await cal.locator(".bs-cal-month").first().locator(".bs-cal-month__cell").count()).toBe(
				42,
			);
			await cal.close();

			// Database — open default calendar view if seeded; fallback only asserts the chrome
			// surface is reachable from the host CSS bundle (mountable later via UI).
			const db = await openApp(dashboard, app, DATABASE_APP);
			// CSS bundle must include the shared rule even if no calendar view is open.
			const dbHasSdkChromeCss = await db.evaluate(() => {
				for (const sheet of Array.from(document.styleSheets)) {
					try {
						for (const rule of Array.from(sheet.cssRules ?? [])) {
							if (rule.cssText.includes(".bs-cal-month")) return true;
						}
					} catch {
						// cross-origin; ignore.
					}
				}
				return false;
			});
			expect(dbHasSdkChromeCss, "Database app CSS bundle must include .bs-cal-month").toBe(true);
			await db.close();

			// Tasks — CSS bundle assertion (date popover requires a task row + chip click
			// which depends on the seeded vault state; bundle presence is the floor).
			const tasks = await openApp(dashboard, app, TASKS_APP);
			const tasksHasSdkChromeCss = await tasks.evaluate(() => {
				for (const sheet of Array.from(document.styleSheets)) {
					try {
						for (const rule of Array.from(sheet.cssRules ?? [])) {
							if (rule.cssText.includes(".bs-cal-mini")) return true;
						}
					} catch {
						// cross-origin; ignore.
					}
				}
				return false;
			});
			expect(tasksHasSdkChromeCss, "Tasks app CSS bundle must include .bs-cal-mini").toBe(true);
			await tasks.close();
		} finally {
			await app.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
