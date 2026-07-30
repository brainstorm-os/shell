/**
 * Stacked-dialog readability capture — the marketplace consent frame the
 * VID-build-apps shoot caught broken.
 *
 * Drives the REAL production-built shell through the exact reported path:
 *   Marketplace → "Install from…" → "From vault code files…" → Install
 * so the "Install <app>?" confirm renders ON TOP of the still-mounted picker,
 * then screenshots that stacked state.
 *
 * The vault needs `CodeFile/v1` rows carrying a `manifest.json` for a
 * candidate to exist, so the spec launches the Code app once and creates them
 * through its own capability-gated `entities.create` — no privileged back
 * door, the same write path a user typing in the editor takes.
 *
 * Run: `bunx playwright test --config=playwright.visual.config.ts \
 *        tests/visual/specs/stacked-confirm.spec.ts`
 * Output: `tests/visual/out/stacked-confirm/*.png`.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";

import { launchAppPage } from "../lib/app-window";
import { launchShell } from "../lib/launch-shell";
import { ensureVaultAndSeed } from "../lib/seed-vault";

const CODE_APP_ID = "io.brainstorm.code-editor";
const OUT_DIR = join(process.cwd(), "tests/visual/out/stacked-confirm");

const CANDIDATE_FILES: ReadonlyArray<{ path: string; content: string }> = [
	{
		path: "client-pulse/manifest.json",
		content: JSON.stringify(
			{
				id: "studio.northbound.client-pulse",
				name: "Client Pulse",
				version: "1.0.0",
				sdk: "1",
				description: "A vault-authored dashboard of client health signals.",
				entry: "index.html",
				capabilities: ["storage.kv", "entities.read:*", "dashboard.pin"],
			},
			null,
			2,
		),
	},
	{ path: "client-pulse/index.html", content: "<!doctype html><title>Client Pulse</title>" },
	{ path: "client-pulse/app.js", content: "document.title = 'Client Pulse';\n" },
];

async function seedAppCandidate(app: ElectronApplication, dashboard: Page): Promise<void> {
	const codeWindow = await launchAppPage(app, dashboard, CODE_APP_ID);
	try {
		await codeWindow.waitForLoadState("load", { timeout: 30_000 });
		await codeWindow.waitForSelector(".app-header", { state: "attached", timeout: 30_000 });
		await codeWindow.evaluate(async (files) => {
			const bs = (
				window as unknown as {
					brainstorm: {
						services: {
							entities: {
								create: (type: string, properties: Record<string, unknown>) => Promise<unknown>;
							};
						};
					};
				}
			).brainstorm;
			const now = Date.now();
			for (const file of files) {
				await bs.services.entities.create("brainstorm/CodeFile/v1", {
					path: file.path,
					content: file.content,
					language: file.path.endsWith(".json")
						? "json"
						: file.path.endsWith(".html")
							? "html"
							: "javascript",
					sizeBytes: file.content.length,
					lineCount: file.content.split("\n").length,
					isDirty: false,
					createdAt: now,
					updatedAt: now,
				});
			}
		}, CANDIDATE_FILES);
	} finally {
		await codeWindow.close().catch(() => undefined);
	}
}

test("stacked confirm over the install-from-vault picker stays readable", async () => {
	test.setTimeout(8 * 60 * 1000);
	mkdirSync(OUT_DIR, { recursive: true });
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-stackfix-"));
	let app: ElectronApplication | null = null;
	try {
		const launched = await launchShell({ userDataDir });
		app = launched.app;
		const dashboard = await app.firstWindow({ timeout: 60_000 });
		await dashboard.waitForLoadState("load", { timeout: 60_000 });
		await ensureVaultAndSeed(dashboard, userDataDir);

		// The auto changelog popover would itself be a dialog on screen.
		await dashboard.evaluate(async () => {
			const bs = (
				window as unknown as {
					brainstorm: {
						help: { getChangelog: () => Promise<{ releases: Array<{ version: string }> }> };
						dashboard: { setLastSeenChangelogVersion: (v: string) => Promise<unknown> };
					};
				}
			).brainstorm;
			const changelog = await bs.help.getChangelog();
			const newest = changelog.releases[0]?.version;
			if (newest) await bs.dashboard.setLastSeenChangelogVersion(newest);
		});
		if ((await dashboard.locator('div[role="dialog"][aria-modal="true"]').count()) > 0) {
			await dashboard.keyboard.press("Escape");
		}

		await seedAppCandidate(app, dashboard);

		await dashboard.getByRole("button", { name: "Open Marketplace" }).click();
		await dashboard.waitForSelector('[data-testid="marketplace"]', { timeout: 30_000 });
		await dashboard.getByRole("button", { name: "Install from…" }).click();
		await dashboard.getByText("From vault code files…").click();

		const picker = dashboard.locator('[data-testid="install-from-vault-dialog"]');
		await expect(picker).toBeVisible({ timeout: 30_000 });
		await expect(dashboard.getByText("Client Pulse")).toBeVisible({ timeout: 30_000 });
		await dashboard.screenshot({ path: join(OUT_DIR, "01-picker-alone.png"), type: "png" });

		// Fire the consent confirm from INSIDE the picker — the reported frame.
		await picker.getByRole("button", { name: "Install", exact: true }).first().click();
		const confirmDialog = dashboard.locator('[data-testid="confirm-dialog"]');
		await expect(confirmDialog).toBeVisible({ timeout: 30_000 });
		await dashboard.waitForTimeout(400);
		await dashboard.screenshot({ path: join(OUT_DIR, "02-stacked-confirm.png"), type: "png" });

		// The fix, asserted on the live DOM rather than only in the pixels.
		const confirmRoot = dashboard.locator(".popover--stacked");
		await expect(confirmRoot).toHaveCount(1);
		await expect(confirmRoot).toHaveAttribute("data-popover-depth", "1");
		await expect(confirmDialog).toHaveClass(/popover__panel--solid/);
		const pickerRoot = dashboard.locator(".popover:not(.popover--stacked)");
		await expect(pickerRoot).toHaveAttribute("inert", "");
		await expect(pickerRoot).toHaveAttribute("aria-hidden", "true");
		// Focus is inside the confirm, not the inert picker below it.
		expect(
			await dashboard.evaluate(() => document.activeElement?.closest(".popover--stacked") !== null),
		).toBe(true);

		// Cancelling hands the picker back — the parent must go live again.
		await confirmDialog.getByRole("button", { name: "Cancel" }).click();
		await expect(confirmDialog).toHaveCount(0);
		await expect(picker).toBeVisible();
		await expect(dashboard.locator(".popover")).not.toHaveAttribute("inert", "");
		await dashboard.screenshot({ path: join(OUT_DIR, "03-picker-restored.png"), type: "png" });
	} finally {
		await app?.close().catch(() => undefined);
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
