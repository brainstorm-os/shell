/**
 * B11.12 — Export… entries in a note's object menu. The header ⋯ menu offers
 * "Export as Markdown" / "Export as HTML" (the bytes are serialized from the
 * live editor state and saved via the Files host). We assert the rows render
 * end-to-end — the actual save goes through the OS dialog, owned + tested by
 * the Files service, so the spec stops at the menu integration.
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
			await bs.vaults.create({ name: "fm-export", path: `${d}/vault` });
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

test.describe("notes export menu (B11.12)", () => {
	test("the note object menu offers Export as Markdown / HTML", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-export-"));
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

				// Open the header ⋯ object menu (the more button lives in the
				// header-right cluster; the title also carries an object-menu
				// trigger, so scope to the button to avoid matching that).
				const more = notes
					.locator(".notes__header-right")
					.getByRole("button", { name: "Note actions" });
				await more.waitFor({ state: "visible", timeout: 15_000 });
				await more.click({ timeout: 10_000 });

				// The Export… rows are present (spliced before the destructive Remove).
				await expect(notes.getByText("Export as Markdown").first()).toBeVisible({ timeout: 8_000 });
				await expect(notes.getByText("Export as HTML").first()).toBeVisible({ timeout: 8_000 });
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
