/**
 * B11.3 — column reorder. The contextual table toolbar offers "Move column
 * left / right", which swaps the selected cell's column with its neighbour in
 * every row. Verified end-to-end in the real shell.
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
			await bs.vaults.create({ name: "fm-move-col", path: `${d}/vault` });
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

test.describe("notes table move column (B11.3)", () => {
	test("Move column right swaps the selected column with its neighbour", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-move-col-"));
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
				// Insert a table; the caret lands in the first cell. Seed that cell
				// so we can follow it, keeping the caret there (toolbar stays shown).
				await notes.evaluate(async () => {
					await (
						window as unknown as {
							__brainstormNotesDev: { runBlockCommand: (id: string) => Promise<void> };
						}
					).__brainstormNotesDev.runBlockCommand("block.table");
				});
				await expect(notes.locator("table").first()).toBeVisible({ timeout: 10_000 });

				// Click the first cell of the SECOND row (a body cell, clear of the
				// toolbar) so the caret sits in a known column 0, then seed it.
				await notes.locator("table tr").nth(1).locator("th,td").first().click();
				await notes.evaluate(async () => {
					await (
						window as unknown as {
							__brainstormNotesDev: { setSelectedCellText: (text: string) => Promise<void> };
						}
					).__brainstormNotesDev.setSelectedCellText("AA");
				});

				// Find which column "AA" sits in (the seeded/selected cell — could be
				// any row, since the caret lands in a body cell under the header).
				const columnOf = (text: string) =>
					notes.evaluate((t) => {
						for (const row of Array.from(document.querySelectorAll("table tr"))) {
							const cells = Array.from(row.children);
							const idx = cells.findIndex((c) => (c.textContent ?? "").trim() === t);
							if (idx >= 0) return idx;
						}
						return -1;
					}, text);
				await expect.poll(() => columnOf("AA")).toBe(0);

				await notes.getByRole("button", { name: "Move column right" }).first().click();

				// The selected cell's column moved one position right.
				await expect.poll(() => columnOf("AA")).toBe(1);
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
