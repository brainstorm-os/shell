/**
 * B11.3 — table column-resize drag. A mousedown within the resize zone of a
 * cell's right edge starts a drag that sets the column's width on the
 * TableNode (`setColWidths`). Verified in the real shell by dragging and
 * asserting the persisted `colWidths` grew.
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
			await bs.vaults.create({ name: "fm-table-resize", path: `${d}/vault` });
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

test.describe("notes table column resize (B11.3)", () => {
	test("dragging a column boundary persists a wider colWidth", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-table-resize-"));
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
					).__brainstormNotesDev.runBlockCommand("block.table");
				});
				const firstCell = notes.locator("table tr").first().locator("th,td").first();
				await expect(firstCell).toBeVisible({ timeout: 10_000 });

				// Move the caret out of the table so its contextual trigger (which
				// floats over the top-row boundary) dismisses.
				await notes.locator('[contenteditable="true"] p').first().click();
				await expect(notes.locator(".bs-editor__table-trigger")).toBeHidden({ timeout: 5_000 });

				const box = await firstCell.boundingBox();
				if (!box) throw new Error("no cell box");
				const startWidth = box.width;
				const edgeX = box.x + box.width;
				const midY = box.y + box.height / 2;

				// Mousedown within the resize zone of the right edge, drag +80px.
				await notes.mouse.move(edgeX - 2, midY);
				await notes.mouse.down();
				await notes.mouse.move(edgeX + 80, midY, { steps: 8 });
				await notes.mouse.up();

				// The persisted colWidths reflect the wider first column.
				await expect
					.poll(async () =>
						notes.evaluate(async () => {
							const w = await (
								window as unknown as {
									__brainstormNotesDev: {
										firstTableColWidths: () => Promise<readonly number[] | undefined>;
									};
								}
							).__brainstormNotesDev.firstTableColWidths();
							return w?.[0] ?? 0;
						}),
					)
					.toBeGreaterThan(startWidth + 20);

				// Regression: the hover handle is fixed-positioned off a viewport
				// rect; a scroll must drop it rather than strand it at a stale
				// position detached from the column edge.
				const box2 = await firstCell.boundingBox();
				if (!box2) throw new Error("no cell box (post-resize)");
				await notes.mouse.move(box2.x + box2.width - 2, box2.y + box2.height / 2);
				await expect(notes.locator(".bs-editor__table-col-resizer")).toBeVisible({
					timeout: 5_000,
				});
				await notes.locator(".notes__main").evaluate((el) => {
					el.scrollTop += 40;
					el.dispatchEvent(new Event("scroll", { bubbles: true }));
				});
				await expect(notes.locator(".bs-editor__table-col-resizer")).toBeHidden({
					timeout: 5_000,
				});
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
