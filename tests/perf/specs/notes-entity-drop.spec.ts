/**
 * B11.8 — drag an object into the editor. A drop carrying the shared
 * `application/vnd.brainstorm.entity+json` payload inserts a reference at the
 * drop point (inline MentionNode link on a plain drop). Verified in the real
 * shell by dispatching a native `drop` with a constructed DataTransfer — the
 * most faithful way to drive Lexical's DROP_COMMAND end-to-end.
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
			await bs.vaults.create({ name: "notes-entity-drop", path: `${d}/vault` });
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

test.describe("notes entity drop (B11.8)", () => {
	test("dropping an entity payload inserts a mention link", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-notes-entity-drop-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await openAppFromDashboard(app, dashboard, { label: "Notes" });
				const editable = notes.locator(".notes__contenteditable").first();
				await editable.waitFor({ state: "visible", timeout: 20_000 });

				// Sidebar rows advertise themselves as draggable.
				await expect(notes.locator(".notes__sidebar-item[draggable='true']").first()).toBeVisible({
					timeout: 10_000,
				});

				// Drive a native drop carrying the entity MIME onto the editor.
				await editable.evaluate((el) => {
					const dt = new DataTransfer();
					dt.setData(
						"application/vnd.brainstorm.entity+json",
						JSON.stringify({
							entityId: "dropped-note",
							entityType: "io.brainstorm.notes/Note/v1",
							label: "Dropped reference",
						}),
					);
					const rect = el.getBoundingClientRect();
					el.dispatchEvent(
						new DragEvent("drop", {
							bubbles: true,
							cancelable: true,
							dataTransfer: dt,
							clientX: rect.left + rect.width / 2,
							clientY: rect.top + 20,
						}),
					);
				});

				await expect(
					notes.locator(".notes__mention-label", { hasText: "Dropped reference" }),
				).toBeVisible({
					timeout: 10_000,
				});
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
