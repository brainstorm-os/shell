import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	focusStealingDisabled,
	hiddenWindowsRequested,
	revealWindow,
	surfaceWindow,
} from "./reveal-window";

beforeEach(() => {
	vi.stubEnv("BRAINSTORM_HIDDEN_WINDOWS", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function fakeWindow(destroyed = false) {
	return {
		isDestroyed: () => destroyed,
		show: vi.fn(),
		showInactive: vi.fn(),
	} as unknown as BrowserWindow;
}

function fakeSurfaceable(opts: { destroyed?: boolean; minimized?: boolean } = {}) {
	return {
		isDestroyed: () => opts.destroyed ?? false,
		isMinimized: () => opts.minimized ?? false,
		restore: vi.fn(),
		show: vi.fn(),
		showInactive: vi.fn(),
		focus: vi.fn(),
	};
}

describe("focusStealingDisabled", () => {
	it("is false by default", () => {
		vi.stubEnv("BRAINSTORM_NO_FOCUS", "");
		vi.stubEnv("BRAINSTORM_SOAK_DEBUG", "");
		expect(focusStealingDisabled()).toBe(false);
	});

	it("is true under BRAINSTORM_NO_FOCUS", () => {
		vi.stubEnv("BRAINSTORM_NO_FOCUS", "1");
		vi.stubEnv("BRAINSTORM_SOAK_DEBUG", "");
		expect(focusStealingDisabled()).toBe(true);
	});

	it("is true under BRAINSTORM_SOAK_DEBUG", () => {
		vi.stubEnv("BRAINSTORM_NO_FOCUS", "");
		vi.stubEnv("BRAINSTORM_SOAK_DEBUG", "1");
		expect(focusStealingDisabled()).toBe(true);
	});
});

describe("revealWindow", () => {
	it("activates with show() when focus-stealing is allowed", () => {
		vi.stubEnv("BRAINSTORM_NO_FOCUS", "");
		vi.stubEnv("BRAINSTORM_SOAK_DEBUG", "");
		const win = fakeWindow();
		revealWindow(win);
		expect(win.show).toHaveBeenCalledOnce();
		expect(win.showInactive).not.toHaveBeenCalled();
	});

	it("reveals without activating under the no-focus flag", () => {
		vi.stubEnv("BRAINSTORM_NO_FOCUS", "1");
		const win = fakeWindow();
		revealWindow(win);
		expect(win.showInactive).toHaveBeenCalledOnce();
		expect(win.show).not.toHaveBeenCalled();
	});

	it("no-ops on a destroyed window", () => {
		vi.stubEnv("BRAINSTORM_NO_FOCUS", "1");
		const win = fakeWindow(true);
		revealWindow(win);
		expect(win.show).not.toHaveBeenCalled();
		expect(win.showInactive).not.toHaveBeenCalled();
	});

	it("activates with show() when the window cannot showInactive", () => {
		vi.stubEnv("BRAINSTORM_NO_FOCUS", "1");
		const win = { isDestroyed: () => false, show: vi.fn() };
		revealWindow(win);
		expect(win.show).toHaveBeenCalledOnce();
	});
});

describe("hiddenWindowsRequested", () => {
	it("is false by default", () => {
		expect(hiddenWindowsRequested()).toBe(false);
	});

	it("is true under BRAINSTORM_HIDDEN_WINDOWS", () => {
		vi.stubEnv("BRAINSTORM_HIDDEN_WINDOWS", "1");
		expect(hiddenWindowsRequested()).toBe(true);
	});

	it("is not implied by the no-focus flags", () => {
		vi.stubEnv("BRAINSTORM_NO_FOCUS", "1");
		vi.stubEnv("BRAINSTORM_SOAK_DEBUG", "1");
		expect(hiddenWindowsRequested()).toBe(false);
	});
});

describe("hidden-window mode", () => {
	it("never maps a window", () => {
		vi.stubEnv("BRAINSTORM_HIDDEN_WINDOWS", "1");
		const win = fakeWindow();
		revealWindow(win);
		expect(win.show).not.toHaveBeenCalled();
		expect(win.showInactive).not.toHaveBeenCalled();
	});

	it("never restores, reveals or focuses on surface", () => {
		vi.stubEnv("BRAINSTORM_HIDDEN_WINDOWS", "1");
		const win = fakeSurfaceable({ minimized: true });
		surfaceWindow(win);
		expect(win.restore).not.toHaveBeenCalled();
		expect(win.show).not.toHaveBeenCalled();
		expect(win.showInactive).not.toHaveBeenCalled();
		expect(win.focus).not.toHaveBeenCalled();
	});
});

describe("surfaceWindow", () => {
	it("restores, shows and focuses a minimized window", () => {
		const win = fakeSurfaceable({ minimized: true });
		surfaceWindow(win);
		expect(win.restore).toHaveBeenCalledOnce();
		expect(win.show).toHaveBeenCalledOnce();
		expect(win.focus).toHaveBeenCalledOnce();
	});

	it("reveals without focus under the no-focus flag", () => {
		vi.stubEnv("BRAINSTORM_NO_FOCUS", "1");
		const win = fakeSurfaceable();
		surfaceWindow(win);
		expect(win.showInactive).toHaveBeenCalledOnce();
		expect(win.focus).not.toHaveBeenCalled();
	});

	it("no-ops on a destroyed window", () => {
		const win = fakeSurfaceable({ destroyed: true, minimized: true });
		surfaceWindow(win);
		expect(win.restore).not.toHaveBeenCalled();
		expect(win.show).not.toHaveBeenCalled();
		expect(win.focus).not.toHaveBeenCalled();
	});
});
