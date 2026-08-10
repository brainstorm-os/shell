/**
 * B11.3 — table sort-by-column. The contextual table toolbar offers
 * "Sort column A→Z / Z→A", which reorders the table's body rows by the
 * selected cell's column (logic covered by table-ops unit tests). Here we
 * verify the toolbar surfaces the controls end-to-end in the real shell.
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
			await bs.vaults.create({ name: "fm-table-sort", path: `${d}/vault` });
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

test.describe("notes table sort (B11.3)", () => {
	test("the table toolbar offers Sort column A→Z / Z→A", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-table-sort-"));
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

				// Insert a table via the dev hook (keystrokes corrupt the collab
				// editor); the caret lands in the first cell, so the contextual
				// table toolbar shows.
				await notes.evaluate(async () => {
					await (
						window as unknown as {
							__brainstormNotesDev: { runBlockCommand: (id: string) => Promise<void> };
						}
					).__brainstormNotesDev.runBlockCommand("block.table");
				});
				await expect(notes.locator("table").first()).toBeVisible({ timeout: 10_000 });

				await expect(notes.getByRole("button", { name: "Sort column A→Z" }).first()).toBeVisible({
					timeout: 8_000,
				});
				await expect(notes.getByRole("button", { name: "Sort column Z→A" }).first()).toBeVisible({
					timeout: 8_000,
				});
				await expect(notes.getByRole("button", { name: "Fill down" }).first()).toBeVisible({
					timeout: 8_000,
				});
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
