/**
 * B11.4 — code-block Copy button. Hovering a code block reveals a Copy
 * button; clicking it copies the block text and flashes "Copied". Verified in
 * the real shell. (Async Shiki highlighting + the language picker are the
 * remaining B11.4 work.)
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
			await bs.vaults.create({ name: "fm-code-copy", path: `${d}/vault` });
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

test.describe("notes code-block copy (B11.4)", () => {
	test("hovering a code block reveals Copy; clicking flashes Copied", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-code-copy-"));
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

				// Insert a code block via the dev hook (keystrokes corrupt the
				// collab editor) and let it paint.
				await notes.evaluate(async () => {
					await (
						window as unknown as {
							__brainstormNotesDev: { runBlockCommand: (id: string) => Promise<void> };
						}
					).__brainstormNotesDev.runBlockCommand("block.code");
				});
				const code = notes.locator(".notes__code").first();
				await expect(code).toBeVisible({ timeout: 10_000 });

				// Hover → the toolbar appears.
				await code.hover();
				const toolbar = notes.locator(".notes__code-toolbar");
				await expect(toolbar).toBeVisible({ timeout: 5_000 });

				// Language picker → pick TypeScript → the button reflects it.
				const langBtn = toolbar.locator(".notes__code-lang .notes__code-toolbar-btn");
				await expect(langBtn).toHaveText("Plain text", { timeout: 5_000 });
				await langBtn.click();
				await toolbar.locator(".notes__code-lang-menu").getByText("TypeScript").first().click();
				await expect(langBtn).toHaveText("TypeScript", { timeout: 5_000 });

				// Copy → "Copied" feedback flashes.
				await notes.locator(".notes__code-copy").click();
				await expect(notes.locator(".notes__code-copy-label")).toHaveText("Copied", {
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
