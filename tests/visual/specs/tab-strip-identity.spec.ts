/**
 * Tab-strip object identity end-to-end smoke.
 *
 * Boots the real shell + seeded vault, opens the Code Editor, forces a second
 * tab (the strip only renders with 2+ tabs), and asserts the strip labels the
 * file tab with the OPEN OBJECT's name (published via
 * `@brainstorm-os/sdk/tab-identity` → `page-title-updated`), then that a
 * published emoji favicon surfaces as the tab's icon
 * (`page-favicon-updated` → `ChromeTab.icon` → strip `<img>`). The encoding
 * is unit-tested in sdk-types/sdk; this proves the live Electron wiring.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { waitForAppTabPage } from "../lib/app-window";
import { launchShell } from "../lib/launch-shell";
import { ensureVaultAndSeed } from "../lib/seed-vault";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCREENSHOT_DIR = join(REPO_ROOT, ".screenshots", "tab-strip-identity");

const EMOJI_FAVICON = `data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="50" text-anchor="middle" dominant-baseline="central" font-size="88">📝</text></svg>',
)}`;

async function waitForStripPage(app: ElectronApplication, timeout = 30_000): Promise<Page> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const hit = app.windows().find((p) => p.url().includes("tab-strip"));
		if (hit) return hit;
		if (Date.now() > deadline) throw new Error("tab-strip page never appeared");
		await app.windows()[0]?.waitForTimeout(100);
	}
}

test("tab strip shows the open object's name and published icon", async () => {
	test.setTimeout(9 * 60 * 1000);
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-tab-strip-"));
	const { app } = await launchShell({ userDataDir });
	try {
		const dashboard = await app.firstWindow({ timeout: 60_000 });
		await dashboard.waitForLoadState("load", { timeout: 60_000 });
		await ensureVaultAndSeed(dashboard, userDataDir);
		await dashboard.evaluate(() =>
			(
				window as unknown as { brainstorm: { dev: { reseedVault: () => Promise<unknown> } } }
			).brainstorm.dev.reseedVault(),
		);

		await dashboard.evaluate(() =>
			(
				window as unknown as { brainstorm: { apps: { launch: (id: string) => Promise<void> } } }
			).brainstorm.apps.launch("io.brainstorm.code-editor"),
		);
		const editor = await waitForAppTabPage(app);
		await editor.waitForLoadState("load", { timeout: 30_000 });
		await editor.waitForSelector(".editor__file", { state: "visible", timeout: 30_000 });
		const openFileName = (
			await editor.locator('.editor__file[aria-current="true"] .editor__file-name').innerText()
		).trim();
		expect(openFileName).not.toBe("");

		// Second tab via the chrome view's own bridge — the strip mounts hidden
		// with one tab, so this is the deterministic way to make it visible.
		const strip = await waitForStripPage(app);
		await strip.evaluate(() =>
			(window as unknown as { brainstormChrome: { newTab: () => void } }).brainstormChrome.newTab(),
		);
		await expect(strip.locator(".tab")).toHaveCount(2, { timeout: 30_000 });

		// The file tab is labeled with the open object's name, not the app name.
		await expect(strip.locator(".tab__title").first()).toHaveText(openFileName, {
			timeout: 15_000,
		});

		// Publish an icon from the (now background) file tab — background tabs
		// stay wired, and the strip must paint it. The app already wrote the
		// marked favicon link via publishTabIdentity; update it the same way.
		await editor.evaluate((href) => {
			const link = document.head.querySelector('link[rel="icon"][data-bs-tab-icon]');
			if (!link) throw new Error("tab-identity favicon link missing");
			link.setAttribute("href", href);
		}, EMOJI_FAVICON);
		const icon = strip.locator(".tab").first().locator(".tab__icon");
		await expect(icon).toBeVisible({ timeout: 15_000 });
		expect(await icon.getAttribute("src")).toBe(EMOJI_FAVICON);

		await strip.screenshot({ path: join(SCREENSHOT_DIR, "strip.png") });
	} finally {
		await app.close();
	}
});
