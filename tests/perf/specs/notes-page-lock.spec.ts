/**
 * B11.11 — page-level lock. The header Lock toggle flips the open note to
 * read-only by driving Lexical's `editable` flag (via `EditablePlugin`).
 * Verified in the real shell through the contenteditable's `contenteditable`
 * attribute flipping true→false→true.
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
			await bs.vaults.create({ name: "notes-page-lock", path: `${d}/vault` });
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

test.describe("notes page lock (B11.11)", () => {
	test("the Lock toggle makes the document read-only and back", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-notes-page-lock-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const editable = notes.locator(".notes__contenteditable").first();
				await expect(editable).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });

				const lock = notes.getByRole("button", { name: "Lock page (read-only)" });
				await lock.click();
				await expect(editable).toHaveAttribute("contenteditable", "false");

				const unlock = notes.getByRole("button", { name: "Unlock page" });
				await unlock.click();
				await expect(editable).toHaveAttribute("contenteditable", "true");
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
