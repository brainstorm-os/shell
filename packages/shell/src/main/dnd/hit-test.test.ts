import {
	type WindowBounds,
	type WindowEntry,
	WindowState,
} from "@brainstorm-os/protocol/window-types";
import { describe, expect, it } from "vitest";
import { hitTestWindow } from "./hit-test";

function win(
	appId: string,
	bounds: WindowBounds,
	overrides: Partial<WindowEntry> = {},
): WindowEntry {
	return {
		id: `${appId}::w1`,
		appId,
		appName: appId,
		windowId: "w1",
		title: appId,
		route: null,
		monitorId: "m1",
		bounds,
		state: WindowState.Normal,
		focused: false,
		lastFocusedAt: 0,
		...overrides,
	};
}

describe("hitTestWindow", () => {
	it("returns the window under the point with a within-window offset", () => {
		const entries = [win("notes", { x: 100, y: 100, width: 400, height: 300 })];
		expect(hitTestWindow(entries, { x: 150, y: 140 })).toEqual({
			appId: "notes",
			windowId: "w1",
			pointInWindow: { x: 50, y: 40 },
		});
	});

	it("returns null over empty space", () => {
		const entries = [win("notes", { x: 100, y: 100, width: 400, height: 300 })];
		expect(hitTestWindow(entries, { x: 10, y: 10 })).toBeNull();
	});

	it("picks the first (most-recently-focused) of overlapping windows", () => {
		// entries are passed most-recently-focused first (as WindowIndex.list()).
		const entries = [
			win("front", { x: 0, y: 0, width: 200, height: 200 }, { windowId: "wf" }),
			win("back", { x: 0, y: 0, width: 200, height: 200 }, { windowId: "wb" }),
		];
		expect(hitTestWindow(entries, { x: 50, y: 50 })?.appId).toBe("front");
	});

	it("skips minimized windows", () => {
		const entries = [
			win("min", { x: 0, y: 0, width: 200, height: 200 }, { state: WindowState.Minimized }),
			win("normal", { x: 0, y: 0, width: 200, height: 200 }, { windowId: "w2" }),
		];
		expect(hitTestWindow(entries, { x: 50, y: 50 })?.appId).toBe("normal");
	});

	it("treats the right/bottom edge as exclusive, left/top inclusive", () => {
		const entries = [win("n", { x: 0, y: 0, width: 100, height: 100 })];
		expect(hitTestWindow(entries, { x: 0, y: 0 })).not.toBeNull(); // top-left inclusive
		expect(hitTestWindow(entries, { x: 100, y: 50 })).toBeNull(); // right edge exclusive
		expect(hitTestWindow(entries, { x: 50, y: 100 })).toBeNull(); // bottom edge exclusive
		expect(hitTestWindow(entries, { x: 99, y: 99 })).not.toBeNull();
	});

	it("returns null for an empty index", () => {
		expect(hitTestWindow([], { x: 5, y: 5 })).toBeNull();
	});
});
