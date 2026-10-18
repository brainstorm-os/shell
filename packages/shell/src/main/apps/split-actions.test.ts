import { describe, expect, it, vi } from "vitest";
import { SplitShortcut } from "../shortcuts/split-shortcut";
import { SplitStep } from "../window/split-layout";
import { isSplitShortcut, launchForRoute, runSplitShortcut } from "./split-actions";
import type { WindowContainer } from "./window-container";

function fakeContainer(over: Partial<Record<keyof WindowContainer, unknown>> = {}) {
	return {
		id: "c1",
		sidePane: () => null,
		focusSidePane: vi.fn(() => true),
		tabByWebContents: () => ({ appId: "io.example.notes", route: "brainstorm://entity/n%201" }),
		focusOtherPane: vi.fn(() => true),
		swapPanes: vi.fn(() => true),
		stepSplit: vi.fn(() => true),
		...over,
	} as unknown as WindowContainer;
}

describe("split shortcut actions", () => {
	it("recognises only split ids", () => {
		expect(isSplitShortcut(SplitShortcut.Swap)).toBe(true);
		expect(isSplitShortcut("shell/launcher")).toBe(false);
	});

	it("Open re-opens the focused pane's object beside it, in the same app", () => {
		const openSide = vi.fn();
		const ok = runSplitShortcut(SplitShortcut.Open, 9, {
			containerFor: () => fakeContainer(),
			openSide,
		});
		expect(ok).toBe(true);
		expect(openSide).toHaveBeenCalledWith("c1", "io.example.notes", {
			reason: "open-entity",
			entityId: "n 1",
		});
	});

	it("Open on an already-split window moves to the side pane instead of replacing it", () => {
		const openSide = vi.fn();
		const container = fakeContainer({ sidePane: () => ({ tabId: "s" }) });
		expect(runSplitShortcut(SplitShortcut.Open, 9, { containerFor: () => container, openSide })).toBe(
			true,
		);
		expect(openSide).not.toHaveBeenCalled();
		expect(container.focusSidePane).toHaveBeenCalled();
	});

	it("maps the divider ids to keyboard steps", () => {
		const container = fakeContainer();
		const deps = { containerFor: () => container, openSide: vi.fn() };
		runSplitShortcut(SplitShortcut.DividerLeft, 1, deps);
		runSplitShortcut(SplitShortcut.DividerRight, 1, deps);
		expect(container.stepSplit).toHaveBeenNthCalledWith(1, SplitStep.Left);
		expect(container.stepSplit).toHaveBeenNthCalledWith(2, SplitStep.Right);
	});

	it("falls through (false) for a renderer that isn't an app pane", () => {
		const deps = { containerFor: () => null, openSide: vi.fn() };
		for (const id of Object.values(SplitShortcut)) expect(runSplitShortcut(id, 1, deps)).toBe(false);
	});

	it("passes through the container's own verdict on an unsplit window", () => {
		const container = fakeContainer({ swapPanes: () => false, focusOtherPane: () => false });
		const deps = { containerFor: () => container, openSide: vi.fn() };
		expect(runSplitShortcut(SplitShortcut.Swap, 1, deps)).toBe(false);
		expect(runSplitShortcut(SplitShortcut.FocusOther, 1, deps)).toBe(false);
	});

	it("a pane with no entity route opens a fresh view", () => {
		expect(launchForRoute(null)).toEqual({ reason: "fresh" });
		expect(launchForRoute("brainstorm://settings")).toEqual({ reason: "fresh" });
	});
});
