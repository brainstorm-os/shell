/**
 * Note export e2e — the real-shell proof for B11.12 (Export as Markdown /
 * HTML / PDF) that the in-process suites can't give: `export.printToPdf`
 * renders in a privileged offscreen BrowserWindow (Electron-only) and the
 * saved bytes cross broker → files-service → disk.
 *
 * The OS save dialog is the one piece that can't run headless — the spec
 * stubs `dialog.showSaveDialog` in the main process to commit a fixed path
 * inside the temp userDataDir, then asserts real bytes landed (`%PDF-`
 * magic for the PDF row, the typed text for Markdown).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { launchShell } from "../../perf/lib/launch-shell";
import { waitForAppTabPage } from "../../visual/lib/app-window";

async function createVault(dashboard: Page, userDataDir: string): Promise<void> {
	await dashboard.evaluate(
		async ({ userDataDir }) => {
			const bs = (
				window as unknown as {
					brainstorm: {
						vaults: {
							list: () => Promise<Array<{ id: string }>>;
							create: (o: { name: string; path: string }) => Promise<unknown>;
							activate: (id: string) => Promise<unknown>;
							session: () => Promise<unknown>;
						};
					};
				}
			).brainstorm;
			const list = await bs.vaults.list();
			if (list.length === 0) {
				await bs.vaults.create({ name: "e2e-export", path: `${userDataDir}/vault` });
			} else if (list[0]) {
				await bs.vaults.activate(list[0].id);
			}
			if (!(await bs.vaults.session())) throw new Error("no active vault after create");
		},
		{ userDataDir },
	);
}

test("note export — PDF and Markdown land real bytes on disk", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-e2e-export-"));
	const TYPED = "export e2e probe body";
	try {
		const { app } = await launchShell({ userDataDir });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });
			await createVault(dashboard, userDataDir);
			await dashboard.evaluate(() =>
				(
					window as unknown as { brainstorm: { dev: { seedPrebuiltApps: () => Promise<unknown> } } }
				).brainstorm.dev.seedPrebuiltApps(),
			);

			await dashboard.evaluate(async () => {
				const bs = (
					window as unknown as {
						brainstorm: { dev: { notes?: { createAndOpenScratchNote: () => Promise<void> } } };
					}
				).brainstorm;
				if (!bs.dev.notes) throw new Error("dev.notes scratch helper unavailable");
				await bs.dev.notes.createAndOpenScratchNote();
			});
			const notes = await waitForAppTabPage(app);
			const editable = notes.locator('[contenteditable="true"]').first();
			await editable.waitFor({ state: "visible", timeout: 30_000 });
			await editable.click();
			await notes.keyboard.type(TYPED);
			await expect(editable).toContainText(TYPED, { timeout: 10_000 });

			// Stub the OS save dialog: whatever `nextSavePath` holds is "the
			// user's pick". Re-armed per export below.
			await app.evaluate(({ dialog }) => {
				const g = globalThis as unknown as { __e2eNextSavePath?: string };
				dialog.showSaveDialog = (async () => ({
					canceled: !g.__e2eNextSavePath,
					filePath: g.__e2eNextSavePath,
				})) as typeof dialog.showSaveDialog;
			});
			const armSavePath = (path: string) =>
				app.evaluate(({ app: _app }, p) => {
					(globalThis as unknown as { __e2eNextSavePath?: string }).__e2eNextSavePath = p;
				}, path);
			const readSaved = (path: string) => {
				if (!existsSync(path)) return null;
				const buf = readFileSync(path);
				return { size: buf.length, head: buf.subarray(0, 8).toString("latin1") };
			};

			// The ⋯ menu now offers a single "Export…" row that opens the shared
			// format-picker popover (Markdown / HTML / PDF) + an Export button.
			const exportVia = async (format: string) => {
				await notes.locator(".bs-object-menu__more").first().click();
				await notes.getByText("Export…").click();
				await notes.locator(".bs-export-popover__format").filter({ hasText: format }).click();
				await notes.locator(".bs-export-popover__btn[data-bs-primary]").click();
			};

			const pdfPath = join(userDataDir, "note-export-probe.pdf");
			await test.step("⋯ menu → Export… → PDF → bytes on disk", async () => {
				await armSavePath(pdfPath);
				await exportVia("PDF");
				await expect
					.poll(() => readSaved(pdfPath), { timeout: 45_000 })
					.toMatchObject({ head: expect.stringContaining("%PDF-") });
			});

			const mdPath = join(userDataDir, "note-export-probe.md");
			await test.step("⋯ menu → Export… → Markdown → typed text on disk", async () => {
				await armSavePath(mdPath);
				await exportVia("Markdown");
				await expect.poll(() => readSaved(mdPath), { timeout: 30_000 }).not.toBeNull();
				expect(readFileSync(mdPath, "utf8")).toContain(TYPED);
			});
		} finally {
			await app.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
