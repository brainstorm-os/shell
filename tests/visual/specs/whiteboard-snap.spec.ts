/**
 * Whiteboard snap-to-guides end-to-end smoke (9.17.14).
 *
 * Boots the real Electron shell, adds two stickies (both spawn at the
 * viewport centre, so they overlap), then drags one via the dev hook
 * (`__brainstormWhiteboardDev.dragNodeBy` — a Playwright synthetic pointer
 * can't drive the node's `setPointerCapture` drag, the same reason Notes
 * uses `__brainstormNotesDev`; the hook runs the *exact* snap + move path the
 * pointer loop uses). We assert the magnet engaged (the dragged node's top
 * snapped back to its neighbour's), an alignment guide painted into the live
 * DOM, and that it clears on drag-end — with no renderer console errors.
 * The snap geometry itself is unit-tested (snap.test.ts).
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
const SCREENSHOT_DIR = join(REPO_ROOT, ".screenshots", "whiteboard-snap");

interface WbDev {
	nodeIds: () => string[];
	seedGrid: (count: number, opts?: { cols?: number; cell?: number }) => string[];
	dragNodeBy: (id: string, dx: number, dy: number) => { x: number; y: number; guides: number };
	endDrag: () => void;
}

test("whiteboard drag snaps to a neighbour + draws an alignment guide", async () => {
	test.setTimeout(5 * 60 * 1000);
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-wb-snap-"));
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

		// Two stickies at a known separation. (The old flow clicked the header
		// Add menu via `.whiteboard__add-trigger`, a selector the React-chrome
		// migration retired — dev seeding is deterministic and chrome-free.)
		await wb.evaluate(() => {
			(window as unknown as { __brainstormWhiteboardDev: WbDev }).__brainstormWhiteboardDev.seedGrid(
				2,
				{ cols: 2, cell: 240 },
			);
		});
		await expect(wb.locator(".whiteboard__node")).toHaveCount(2, { timeout: 10_000 });

		// Drag the first node right 200px and *almost* aligned vertically (4px
		// off — inside the 6px threshold). The magnet should pull its top back
		// to the neighbour's top and paint a horizontal guide.
		const result = await wb.evaluate(() => {
			const dev = (window as unknown as { __brainstormWhiteboardDev: WbDev })
				.__brainstormWhiteboardDev;
			const [first] = dev.nodeIds();
			return dev.dragNodeBy(first, 200, 4);
		});

		expect(result.guides).toBeGreaterThanOrEqual(1);
		await expect(wb.locator(".whiteboard__guide").first()).toBeVisible({ timeout: 5_000 });
		await wb.screenshot({ path: join(SCREENSHOT_DIR, "01-guide.png"), fullPage: false });

		// The dragged node's top snapped back to the stationary neighbour's top.
		const tops = await wb.evaluate(() => {
			const nodes = Array.from(
				document.querySelectorAll<HTMLElement>(".whiteboard__node[data-node-id]"),
			);
			return nodes.map((n) => n.style.top);
		});
		expect(tops[0]).toBe(tops[1]);

		// Guides clear once the gesture ends.
		await wb.evaluate(() => {
			(window as unknown as { __brainstormWhiteboardDev: WbDev }).__brainstormWhiteboardDev.endDrag();
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
