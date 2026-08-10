/**
 * B11.4 — code-block line-numbers gutter. The toolbar's "Lines" toggle shows a
 * read-only left gutter of line numbers matching the block's line count.
 * Verified in the real shell.
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
			await bs.vaults.create({ name: "fm-code-ln", path: `${d}/vault` });
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

test.describe("notes code-block line numbers (B11.4)", () => {
	test("the Lines toggle shows a gutter matching the line count", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-code-ln-"));
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
				// Insert a code block + seed three lines (caret lands in the block).
				await notes.evaluate(async () => {
					const dev = (
						window as unknown as {
							__brainstormNotesDev: {
								runBlockCommand: (id: string) => Promise<void>;
								setSelectedCodeText: (text: string) => Promise<void>;
							};
						}
					).__brainstormNotesDev;
					await dev.runBlockCommand("block.code");
					await dev.setSelectedCodeText("const a = 1\nconst b = 2\nconst c = 3");
				});
				const code = notes.locator(".notes__code").first();
				await expect(code).toBeVisible({ timeout: 10_000 });

				// Toggle Lines on via the toolbar.
				await code.hover();
				await expect(notes.locator(".notes__code-toolbar")).toBeVisible({ timeout: 5_000 });
				await notes.getByRole("button", { name: "Lines" }).first().click();

				// A gutter renders with the three line numbers.
				const gutter = notes.locator(".notes__code-gutter").first();
				await expect(gutter).toBeVisible({ timeout: 5_000 });
				await expect.poll(() => gutter.evaluate((el) => el.textContent ?? "")).toBe("1\n2\n3");
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
