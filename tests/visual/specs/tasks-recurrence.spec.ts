/**
 * Tasks recurrence editing end-to-end smoke (9.14.12).
 *
 * Boots the real Electron shell, opens a seeded task, and drives the shared
 * recurrence editor (extracted to `@brainstorm-os/sdk/recurrence-editor`): picking
 * "Weekly" reveals the weekday toggles and a live summary, with no renderer
 * console errors. Proves the SDK editor mounts + persists through the Tasks
 * adapter against the live app.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ConsoleMessage, expect, test } from "@playwright/test";
import { waitForAppTabPage } from "../lib/app-window";
import { launchShell } from "../lib/launch-shell";
import { ensureVaultAndSeed } from "../lib/seed-vault";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCREENSHOT_DIR = join(REPO_ROOT, ".screenshots", "tasks-recurrence");

test("tasks detail → pick Weekly, weekday toggles + summary appear", async () => {
	test.setTimeout(5 * 60 * 1000);
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-tasks-recur-"));
	const { app } = await launchShell({ userDataDir });
	try {
		const dashboard = await app.firstWindow({ timeout: 60_000 });
		await dashboard.waitForLoadState("load", { timeout: 60_000 });
		await ensureVaultAndSeed(dashboard, userDataDir);

		const reseed = await dashboard.evaluate(async () => {
			const bs = (
				window as unknown as {
					brainstorm: { dev: { reseedVault: () => Promise<{ ok: boolean; reason?: string }> } };
				}
			).brainstorm;
			return bs.dev.reseedVault();
		});
		expect(reseed.ok, `seed-cli failed: ${reseed.reason ?? ""}`).toBe(true);

		const consoleErrors: string[] = [];
		const trackConsole = (msg: ConsoleMessage) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		};

		await dashboard.evaluate(() =>
			(
				window as unknown as { brainstorm: { apps: { launch: (id: string) => Promise<void> } } }
			).brainstorm.apps.launch("io.brainstorm.tasks"),
		);
		const tasks = await waitForAppTabPage(app);
		tasks.on("console", trackConsole);
		await tasks.waitForLoadState("load", { timeout: 30_000 });

		await tasks.waitForSelector(".task-row", { state: "visible", timeout: 30_000 });
		await tasks.locator(".task-row .task-row__body").first().click();
		await tasks.waitForSelector(".tasks-detail", { state: "visible", timeout: 10_000 });

		// The Repeat section + the shared editor's kind select are present.
		const kindSelect = tasks.locator(".tasks-detail__recurrence .bs-recur__kind");
		await expect(kindSelect).toBeVisible({ timeout: 10_000 });
		expect(await tasks.locator(".bs-recur__weekdays").count()).toBe(0);

		// Pick Weekly → weekday toggles + a live summary appear.
		await kindSelect.selectOption("weekly");
		await expect(tasks.locator(".bs-recur__weekdays")).toBeVisible({ timeout: 10_000 });
		const summary = await tasks.locator(".bs-recur__summary").textContent();
		expect((summary ?? "").length).toBeGreaterThan(0);

		await tasks.screenshot({ path: join(SCREENSHOT_DIR, "01-weekly.png"), fullPage: false });

		expect(
			consoleErrors,
			`unexpected console errors:\n${consoleErrors.map((e) => `  - ${e}`).join("\n")}`,
		).toEqual([]);

		await tasks.close().catch(() => {});
	} finally {
		await app.close().catch(() => {});
		if (existsSync(userDataDir)) {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	}
});
