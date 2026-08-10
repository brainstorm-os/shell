/**
 * B11.7 — bulk turn-into + bulk mark over a multi-block selection. The B11.6
 * quick chords (`Mod+Alt+0…9`) and the mark chords (strike `Mod+Shift+S`)
 * apply to the caret block when typing; in block-selection mode they bridge
 * the selected set to a range first, so a single chord transforms / marks
 * every selected block. Verified in the real shell.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
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
			await bs.vaults.create({ name: "fm-bulk-turn", path: `${d}/vault` });
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

async function openNotesWithBlockSelection(
	app: ElectronApplication,
	dashboard: Page,
): Promise<Page> {
	const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
	const para = notes.locator('[contenteditable="true"] p').first();
	await para.waitFor({ state: "visible", timeout: 20_000 });
	// Caret in a block, Mod+a selects the containing block, a second Mod+a
	// selects every top-level block → block-selection mode.
	await para.click();
	await notes.keyboard.press("ControlOrMeta+a");
	await notes.keyboard.press("ControlOrMeta+a");
	await expect.poll(() => notes.locator(".bs-editor__block--selected").count()).toBeGreaterThan(1);
	return notes;
}

test.describe("notes bulk turn-into + mark (B11.7)", () => {
	test("Mod+Alt+1 turns a multi-block selection into headings", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-bulk-turn-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openNotesWithBlockSelection(app, dashboard);
				const paraCount = () => notes.locator('[contenteditable="true"] p').count();
				const before = await paraCount();
				expect(before).toBeGreaterThan(0);

				// Quick chord: turn every selected block into a Heading 1.
				await notes.keyboard.press("ControlOrMeta+Alt+1");
				await expect.poll(paraCount).toBeLessThan(before);
				await expect
					.poll(() => notes.locator('[contenteditable="true"] h1').count())
					.toBeGreaterThan(0);
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});

	test("Mod+Shift+S strikes every block in a multi-block selection", async () => {
		test.setTimeout(180_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-bulk-strike-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openNotesWithBlockSelection(app, dashboard);
				const struck = () => notes.locator('[contenteditable="true"] .notes__text--strike').count();
				expect(await struck()).toBe(0);

				// Mark chord: strike the text of every selected block at once. (Shift+S
				// reports `event.key === "S"`, so the chord literal is upper-case.)
				await notes.keyboard.press("ControlOrMeta+Shift+S");
				await expect.poll(struck).toBeGreaterThan(0);
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
