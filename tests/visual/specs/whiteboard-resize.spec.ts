/**
 * Whiteboard node-resize end-to-end smoke (9.17.23).
 *
 * Boots the real Electron shell, adds two stickies, selects one and checks
 * the resize grips materialise (single-selection chrome), then resizes it
 * via the dev hook (`__brainstormWhiteboardDev.resizeNodeBy` — a Playwright
 * synthetic pointer can't drive the grip's `setPointerCapture` loop, same
 * reason the snap spec uses `dragNodeBy`; the hook runs the *exact* resize +
 * snap path the pointer loop uses). We assert the moving edge magnetised to
 * the neighbour's edge, a guide painted, and that it clears on gesture end —
 * with no renderer console errors. The resize geometry itself is unit-tested
 * (resize.test.ts) and the grip pipeline jsdom-tested (engine-resize.test.tsx).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ConsoleMessage, expect, test } from "@playwright/test";
import { waitForAppTabPage } from "../lib/app-window";
import { launchShell } from "../lib/launch-shell";
import { ensureVaultAndSeed } from "../lib/seed-vault";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCREENSHOT_DIR = join(REPO_ROOT, ".screenshots", "whiteboard-resize");

interface WbDev {
	nodeIds: () => string[];
	nodeEl: (id: string) => HTMLElement | null;
	seedGrid: (count: number, opts?: { cols?: number; cell?: number }) => string[];
	resizeNodeBy: (
		id: string,
		handle: string,
		dx: number,
		dy: number,
	) => { x: number; y: number; width: number; height: number; guides: number };
	endResize: () => void;
}

test("whiteboard node resize snaps its moving edge to a neighbour", async () => {
	test.setTimeout(5 * 60 * 1000);
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-wb-resize-"));
	const { app } = await launchShell({ userDataDir });
	try {
		const dashboard = await app.firstWindow({ timeout: 60_000 });
		await dashboard.waitForLoadState("load", { timeout: 60_000 });
		await ensureVaultAndSeed(dashboard, userDataDir);

		const consoleErrors: string[] = [];
		const trackConsole = (msg: ConsoleMessage) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		};

		await dashboard.evaluate(() =>
			(
				window as unknown as { brainstorm: { apps: { launch: (id: string) => Promise<void> } } }
			).brainstorm.apps.launch("io.brainstorm.whiteboard"),
		);
		const wb = await waitForAppTabPage(app);
		wb.on("console", trackConsole);
		await wb.waitForLoadState("load", { timeout: 30_000 });
		await wb.waitForSelector(".whiteboard__canvas", { state: "visible", timeout: 30_000 });

		// Two stickies at a known separation (the same dev seeding the perf
		// suite uses — deterministic, no menu-chrome selectors).
		await wb.evaluate(() => {
			(
				window as unknown as { __brainstormWhiteboardDev: WbDev }
			).__brainstormWhiteboardDev.seedGrid(2, { cols: 2, cell: 300 });
		});
		await expect(wb.locator(".whiteboard__node")).toHaveCount(2, { timeout: 10_000 });

		// Selecting a node materialises the resize grips (single-selection chrome).
		await wb.locator(".whiteboard__node").first().click();
		await expect(wb.locator(".whiteboard__resize-handle--se").first()).toBeVisible({
			timeout: 5_000,
		});
		await wb.screenshot({ path: join(SCREENSHOT_DIR, "01-grips.png"), fullPage: false });

		// Grow the first node's right edge to 4px shy of the neighbour's left
		// edge (inside the 6px threshold) — the magnet closes the gap.
		const result = await wb.evaluate(() => {
			const dev = (window as unknown as { __brainstormWhiteboardDev: WbDev })
				.__brainstormWhiteboardDev;
			const [firstId, secondId] = dev.nodeIds();
			const first = dev.nodeEl(firstId as string) as HTMLElement;
			const second = dev.nodeEl(secondId as string) as HTMLElement;
			const ax = Number.parseFloat(first.style.left);
			const aw = Number.parseFloat(first.style.width);
			const bx = Number.parseFloat(second.style.left);
			const dx = bx - 4 - (ax + aw);
			const out = dev.resizeNodeBy(firstId as string, "e", dx, 0);
			return { ...out, expectedWidth: bx - ax };
		});

		expect(result.guides).toBeGreaterThanOrEqual(1);
		expect(result.width).toBe(result.expectedWidth);
		await expect(wb.locator(".whiteboard__guide").first()).toBeVisible({ timeout: 5_000 });
		await wb.screenshot({ path: join(SCREENSHOT_DIR, "02-snap-guide.png"), fullPage: false });

		// Guides clear once the gesture ends.
		await wb.evaluate(() => {
			(
				window as unknown as { __brainstormWhiteboardDev: WbDev }
			).__brainstormWhiteboardDev.endResize();
		});
		await expect(wb.locator(".whiteboard__guide")).toHaveCount(0, { timeout: 5_000 });

		expect(
			consoleErrors,
			`unexpected console errors:\n${consoleErrors.map((e) => `  - ${e}`).join("\n")}`,
		).toEqual([]);

		await wb.close().catch(() => {});
	} finally {
		await app.close().catch(() => {});
		if (existsSync(userDataDir)) {
			rmSync(userDataDir, { recursive: true, force: true });
		}
	}
});
