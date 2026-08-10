/**
 * F-485 — the perf harness picked the wrong Playwright page after a launch
 * click.
 *
 * An app window is one Electron `BaseWindow` hosting several
 * `WebContentsView`s, and Playwright reports each of them as a `Page`. The
 * container mounts its tab-strip chrome view before it adds the app tab, so
 * the strip's `window` event fires FIRST: `app.waitForEvent("window")` handed
 * back the strip, which is laid out at height 0 while the container holds a
 * single tab. Every downstream `visible` locator then timed out and every
 * screenshot threw "0 width".
 *
 * These units pin the URL-based selection that replaces it, against the real
 * URL shapes the shell produces: the dashboard (`out/renderer/index.html`),
 * the strip (`out/renderer/chrome/tab-strip.html`), an installed app bundle
 * (`<vault>/apps/<appId>/<version>/index.html?v=<sha8>`), the drag-ghost
 * overlay (`data:`) and a Browser web view (`https:`).
 */

import type { ElectronApplication, Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { isAppPage, waitForAppPage } from "./launch-shell";

const DASHBOARD_URL = "file:///repo/packages/shell/out/renderer/index.html";
const STRIP_URL = "file:///repo/packages/shell/out/renderer/chrome/tab-strip.html";
const NOTES_URL = "file:///tmp/bs-perf/vault/apps/io.brainstorm.notes/1.0.0/index.html?v=deadbeef";
const GRAPH_URL = "file:///tmp/bs-perf/vault/apps/io.brainstorm.graph/1.0.0/index.html?v=deadbeef";
const GHOST_URL = "data:text/html;charset=utf-8,%3Chtml%3E";
const WEB_VIEW_URL = "https://example.com/";

function fakePage(url: string): Page {
	return { url: () => url } as unknown as Page;
}

/** An `ElectronApplication` stand-in whose page list grows on a schedule, so a
 *  test can reproduce "the strip appears before the app tab". */
function fakeApp(steps: readonly (readonly Page[])[]): ElectronApplication {
	let index = 0;
	return {
		windows: () => [...(steps[Math.min(index, steps.length - 1)] ?? [])],
		waitForEvent: async () => {
			index += 1;
			return undefined;
		},
	} as unknown as ElectronApplication;
}

describe("isAppPage", () => {
	it("rejects the shell's own surfaces", () => {
		expect(isAppPage(fakePage(DASHBOARD_URL))).toBe(false);
		expect(isAppPage(fakePage(STRIP_URL))).toBe(false);
	});

	it("rejects non-file surfaces parked in the same window list", () => {
		expect(isAppPage(fakePage(GHOST_URL))).toBe(false);
		expect(isAppPage(fakePage(WEB_VIEW_URL))).toBe(false);
		expect(isAppPage(fakePage("about:blank"))).toBe(false);
		expect(isAppPage(fakePage(""))).toBe(false);
	});

	it("accepts an installed app bundle's entry URL", () => {
		expect(isAppPage(fakePage(NOTES_URL))).toBe(true);
	});

	it("narrows to one app when an id is given", () => {
		expect(isAppPage(fakePage(NOTES_URL), "io.brainstorm.notes")).toBe(true);
		expect(isAppPage(fakePage(NOTES_URL), "io.brainstorm.graph")).toBe(false);
	});
});

describe("waitForAppPage", () => {
	it("skips the tab strip that mounts before the app tab", async () => {
		const dashboard = fakePage(DASHBOARD_URL);
		const strip = fakePage(STRIP_URL);
		const notes = fakePage(NOTES_URL);
		const app = fakeApp([[dashboard], [dashboard, strip], [dashboard, strip, notes]]);

		await expect(waitForAppPage(app, { timeoutMs: 5_000 })).resolves.toBe(notes);
	});

	it("ignores pages the caller already held", async () => {
		const dashboard = fakePage(DASHBOARD_URL);
		const notes = fakePage(NOTES_URL);
		const graph = fakePage(GRAPH_URL);
		const app = fakeApp([
			[dashboard, notes],
			[dashboard, notes, graph],
		]);

		await expect(waitForAppPage(app, { exclude: [notes], timeoutMs: 5_000 })).resolves.toBe(graph);
	});

	it("reports the pages it did see when no app renderer shows up", async () => {
		const app = fakeApp([[fakePage(DASHBOARD_URL), fakePage(STRIP_URL)]]);

		await expect(
			waitForAppPage(app, { appId: "io.brainstorm.notes", timeoutMs: 20 }),
		).rejects.toThrow(/io\.brainstorm\.notes.*tab-strip/s);
	});
});
