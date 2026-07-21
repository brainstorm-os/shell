/**
 * B11.4 — Shiki syntax highlighting in Notes code blocks. CodeHighlightPlugin
 * paints a per-block token overlay (`.notes__code-highlight`) over the
 * transparent block text, themed via the shared `@brainstorm-os/sdk/code-highlight`
 * tokenizer. Verified in the real shell: a TypeScript code block grows a
 * highlight overlay carrying coloured token spans. Driven through the
 * `__brainstormNotesDev` hooks (Playwright keystrokes corrupt the Yjs editor).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForDashboard } from "../lib/keyboard-assertions";
import { launchShell } from "../lib/launch-shell";
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
			await bs.vaults.create({ name: "fm-code-highlight", path: `${d}/vault` });
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

async function launchApp(app: ElectronApplication, dashboard: Page, label: string): Promise<Page> {
	const whatsNew = dashboard.locator(".popover");
	if (await whatsNew.isVisible().catch(() => false)) {
		await dashboard.keyboard.press("Escape");
		await whatsNew.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
	}
	const icon = dashboard.locator(".dashboard-icons__icon", { hasText: label }).first();
	await icon.waitFor({ state: "visible", timeout: 10_000 });
	const [win] = await Promise.all([app.waitForEvent("window"), icon.click()]);
	await win.waitForLoadState("domcontentloaded");
	return win;
}

type NotesDev = {
	runBlockCommand: (id: string) => Promise<void>;
	setSelectedCodeText: (text: string) => Promise<void>;
	setSelectedCodeLanguage: (language: string) => Promise<void>;
};

function run<K extends keyof NotesDev>(page: Page, method: K, arg?: unknown): Promise<void> {
	return page.evaluate(
		(a) => {
			const dev = (
				window as unknown as { __brainstormNotesDev: Record<string, (x?: unknown) => Promise<void>> }
			).__brainstormNotesDev;
			return dev[a.method as string]?.(a.arg);
		},
		{ method, arg },
	) as Promise<void>;
}

test.describe("notes code-block syntax highlighting (B11.4)", () => {
	test("a TypeScript code block paints a coloured Shiki overlay", async () => {
		test.setTimeout(300_000);
		const userDataDir = mkdtempSync(join(tmpdir(), "bs-fm-code-highlight-"));
		try {
			const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				await waitForFirstContentfulPaintAbsoluteMs(dashboard);
				await openSeededDashboard(dashboard, userDataDir);

				const notes = await launchApp(app, dashboard, "Notes");
				await notes.locator('[contenteditable="true"]').first().waitFor({
					state: "visible",
					timeout: 20_000,
				});

				await run(notes, "runBlockCommand", "block.text.code");
				await expect(notes.locator(".notes__code").first()).toBeVisible({ timeout: 10_000 });
				await run(notes, "setSelectedCodeLanguage", "typescript");
				await run(notes, "setSelectedCodeText", "const greeting = 42;");

				// The scroll container is marked + a highlight overlay mounts.
				await expect(notes.locator(".notes__main.notes--code-highlighted")).toBeVisible({
					timeout: 10_000,
				});
				const overlay = notes.locator(".notes__code-highlight").first();
				await expect(overlay).toBeAttached({ timeout: 10_000 });

				// Once the grammar loads, Shiki paints coloured token spans (a
				// keyword gets a non-empty inline colour).
				await expect
					.poll(
						async () =>
							overlay
								.locator('code span[style*="color"]')
								.count()
								.catch(() => 0),
						{ timeout: 20_000 },
					)
					.toBeGreaterThan(0);
				// The overlay text mirrors the source.
				await expect(overlay).toContainText("const greeting = 42;");
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	});
});
