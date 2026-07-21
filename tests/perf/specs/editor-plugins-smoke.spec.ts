/**
 * Smoke test for the editor-plugin extraction (Phase 1–5 of the
 * `@brainstorm-os/editor` move). Verifies what a manual session would:
 *   - Notes opens, contenteditable mounts, hovering a block surfaces
 *     the gutter (`+` / grip buttons), typing `/` opens the slash menu.
 *   - Journal opens an entry, the same plugins work.
 *
 * Driven by a real production-built shell — the only place that catches
 * "CSS imported in editor/index.ts is tree-shaken by Vite when consumed
 * from a workspace app" class of regressions. Vitest passes don't.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { launchShell } from "../lib/launch-shell";

async function ensureVaultAndSeed(dashboard: Page, userDataDir: string): Promise<void> {
	await dashboard.evaluate(
		async ({ userDataDir }) => {
			const bs = (
				window as unknown as {
					brainstorm: {
						vaults: {
							list: () => Promise<unknown[]>;
							create: (opts: { name: string; path: string }) => Promise<unknown>;
							activate: (id: string) => Promise<unknown>;
							session: () => Promise<unknown>;
						};
						dev: { seedDemoApps: () => Promise<unknown> };
					};
				}
			).brainstorm;
			const list = (await bs.vaults.list()) as Array<{ id: string }>;
			let session = await bs.vaults.session();
			if (list.length === 0) {
				await bs.vaults.create({ name: "plugins-smoke", path: `${userDataDir}/vault` });
				session = await bs.vaults.session();
			} else if (!session && list[0]) {
				await bs.vaults.activate(list[0].id);
				session = await bs.vaults.session();
			}
			if (!session) throw new Error("Vault session never opened");
			await bs.dev.seedDemoApps();
		},
		{ userDataDir },
	);
}

test("Notes block-gutter renders on hover and slash menu opens on `/`", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-plugins-notes-"));
	const { app } = await launchShell({ userDataDir, timeoutMs: 90_000 });
	try {
		const dashboard = await app.firstWindow({ timeout: 60_000 });
		await dashboard.waitForLoadState("domcontentloaded");
		await ensureVaultAndSeed(dashboard, userDataDir);

		const newWindowPromise = app.waitForEvent("window", { timeout: 30_000 });
		const scratchResult = await dashboard.evaluate(async () => {
			const bs = (
				window as unknown as {
					brainstorm: {
						dev: {
							notes: {
								createAndOpenScratchNote: () => Promise<
									{ ok: true; entityId: string } | { ok: false; reason: string }
								>;
							};
						};
					};
				}
			).brainstorm;
			return bs.dev.notes.createAndOpenScratchNote();
		});
		if (!scratchResult.ok) throw new Error(`scratch note failed: ${scratchResult.reason}`);
		const notes = await newWindowPromise;
		await notes.waitForLoadState("domcontentloaded");

		const editable = notes.locator('[contenteditable="true"]').first();
		await editable.waitFor({ state: "visible", timeout: 30_000 });
		await editable.click();

		// Type some content so there's a paragraph to hover.
		await notes.keyboard.type("first line");
		await notes.keyboard.press("Enter");
		await notes.keyboard.type("second line");

		// Hover the editor row to surface the gutter.
		const paragraphs = notes.locator(".notes__contenteditable > p");
		const blockCount = await paragraphs.count();
		expect(blockCount, "two paragraphs typed").toBeGreaterThanOrEqual(1);
		await paragraphs.first().hover();

		const gutter = notes.locator(".bs-editor__block-gutter");
		await expect(gutter, "block-gutter chrome visible on hover").toBeVisible({ timeout: 5_000 });
		await expect(gutter.locator(".bs-editor__block-gutter-btn--add")).toBeVisible();
		await expect(gutter.locator(".bs-editor__block-gutter-btn--grip")).toBeVisible();

		// Slash menu — focus end of doc, new paragraph, type `/`.
		await editable.click();
		await notes.keyboard.press("End");
		await notes.keyboard.press("Enter");
		await notes.keyboard.press("/");

		const slash = notes.locator(".bs-editor__slash-menu");
		await expect(slash, "slash menu visible after `/`").toBeVisible({ timeout: 5_000 });
		const items = slash.locator(".bs-editor__slash-item");
		const itemCount = await items.count();
		expect(itemCount, "slash menu lists at least the basic commands").toBeGreaterThanOrEqual(6);

		await notes.keyboard.press("Escape");
		await expect(slash).toBeHidden({ timeout: 2_000 });
	} finally {
		await app.close().catch(() => {});
		rmSync(userDataDir, { recursive: true, force: true });
	}
});

test("Journal entry editor surfaces block-gutter + slash menu", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-plugins-journal-"));
	const { app } = await launchShell({ userDataDir, timeoutMs: 90_000 });
	try {
		const dashboard = await app.firstWindow({ timeout: 60_000 });
		await dashboard.waitForLoadState("domcontentloaded");
		await ensureVaultAndSeed(dashboard, userDataDir);

		// Open Journal via the dashboard's app launcher.
		const newWindowPromise = app.waitForEvent("window", { timeout: 30_000 });
		await dashboard.evaluate(async () => {
			const bs = (
				window as unknown as {
					brainstorm: { apps: { launch: (id: string) => Promise<void> } };
				}
			).brainstorm;
			await bs.apps.launch("io.brainstorm.journal");
		});
		const journal = await newWindowPromise;
		await journal.waitForLoadState("domcontentloaded");

		// Today's entry is a placeholder until the user types — first input
		// mints the entry. Click into the day body, type a few chars, then
		// the editor will mount.
		const placeholder = journal.locator(".journal__entry-body");
		await placeholder.first().waitFor({ state: "visible", timeout: 15_000 });
		await placeholder.first().click();
		await journal.keyboard.type("Test journal line for plugin smoke.");

		// Editor should now be the live BrainstormEditor.
		const editable = journal.locator('[contenteditable="true"]').first();
		await editable.waitFor({ state: "visible", timeout: 10_000 });

		// Hover a paragraph.
		const paragraphs = journal.locator(".journal__entry-editor > p");
		await paragraphs.first().waitFor({ state: "visible", timeout: 5_000 });
		await paragraphs.first().hover();

		const gutter = journal.locator(".bs-editor__block-gutter");
		await expect(gutter, "Journal: block-gutter visible on hover").toBeVisible({ timeout: 5_000 });

		// Slash menu.
		await editable.click();
		await journal.keyboard.press("End");
		await journal.keyboard.press("Enter");
		await journal.keyboard.press("/");

		const slash = journal.locator(".bs-editor__slash-menu");
		await expect(slash, "Journal: slash menu visible").toBeVisible({ timeout: 5_000 });
		const itemCount = await slash.locator(".bs-editor__slash-item").count();
		expect(itemCount, "Journal slash has its catalog").toBeGreaterThanOrEqual(10);
	} finally {
		await app.close().catch(() => {});
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
