/**
 * B11.4 — code-block word-wrap toggle. The code-block toolbar's "Wrap" button
 * flips an editor-wide preference (persisted) that soft-wraps code blocks
 * instead of horizontal scroll. Verified in the real shell via the computed
 * `white-space`.
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
			await bs.vaults.create({ name: "fm-code-wrap", path: `${d}/vault` });
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

test.describe("notes code-block wrap (B11.4)", () => {
	test("the Wrap toggle soft-wraps code blocks", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-code-wrap-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				await notes.locator('[contenteditable="true"]').first().waitFor({
					state: "visible",
					timeout: 20_000,
				});
				await notes.evaluate(async () => {
					await (
						window as unknown as {
							__brainstormNotesDev: { runBlockCommand: (id: string) => Promise<void> };
						}
					).__brainstormNotesDev.runBlockCommand("block.code");
				});
				const code = notes.locator(".notes__code").first();
				await expect(code).toBeVisible({ timeout: 10_000 });

				const whiteSpace = () => code.evaluate((el) => getComputedStyle(el).whiteSpace);
				expect(await whiteSpace()).toBe("pre");

				// Hover → toolbar → Wrap → code soft-wraps.
				await code.hover();
				await expect(notes.locator(".notes__code-toolbar")).toBeVisible({ timeout: 5_000 });
				await notes.getByRole("button", { name: "Wrap" }).first().click();
				await expect.poll(whiteSpace).toBe("pre-wrap");
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
