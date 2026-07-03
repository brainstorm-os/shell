// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { readPanelOpen, writePanelOpen } from "./panel-state";

describe("panel-state", () => {
	afterEach(() => {
		sessionStorage.clear();
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it("returns the fallback when nothing is stored", () => {
		expect(readPanelOpen("x:props-open", false)).toBe(false);
		expect(readPanelOpen("x:props-open", true)).toBe(true);
	});

	it("round-trips open/closed through sessionStorage", () => {
		writePanelOpen("x:props-open", true);
		expect(readPanelOpen("x:props-open", false)).toBe(true);
		writePanelOpen("x:props-open", false);
		expect(readPanelOpen("x:props-open", true)).toBe(false);
	});

	it("never touches localStorage — the state must not outlive the window", () => {
		writePanelOpen("x:props-open", true);
		expect(localStorage.length).toBe(0);
		expect(sessionStorage.getItem("x:props-open")).toBe("true");
		localStorage.setItem("x:props-open", "true");
		expect(readPanelOpen("x:props-open", false)).toBe(true);
		sessionStorage.clear();
		expect(readPanelOpen("x:props-open", false)).toBe(false);
	});

	it("falls back when sessionStorage throws (storage disabled)", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("denied");
		});
		expect(() => writePanelOpen("x:props-open", true)).not.toThrow();
		expect(readPanelOpen("x:props-open", true)).toBe(true);
		expect(readPanelOpen("x:props-open", false)).toBe(false);
	});
});
