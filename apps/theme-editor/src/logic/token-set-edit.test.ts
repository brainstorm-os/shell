import { TokenSetAppearance, type TokenSetDef } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	clearOverride,
	composePreviewVars,
	effectiveValue,
	isOverridden,
	setOverride,
} from "./token-set-edit";

function set(overrides: Record<string, string> = {}): TokenSetDef {
	return { name: "S", appearance: TokenSetAppearance.Light, overrides };
}

const base = { "--color-text-primary": "#111", "--color-background-primary": "#fff" };

describe("setOverride / clearOverride", () => {
	it("adds an override immutably", () => {
		const s = set();
		const next = setOverride(s, "--color-text-primary", "#abc");
		expect(next.overrides).toEqual({ "--color-text-primary": "#abc" });
		expect(s.overrides).toEqual({});
	});

	it("clears the override when the value is blank", () => {
		const s = set({ "--color-text-primary": "#abc" });
		expect(setOverride(s, "--color-text-primary", "   ").overrides).toEqual({});
	});

	it("clearOverride removes a key and is a no-op when absent", () => {
		const s = set({ "--color-text-primary": "#abc" });
		expect(clearOverride(s, "--color-text-primary").overrides).toEqual({});
		expect(clearOverride(s, "--space-2")).toBe(s);
	});
});

describe("isOverridden", () => {
	it("reflects presence in the overrides map", () => {
		const s = set({ "--color-text-primary": "#abc" });
		expect(isOverridden(s, "--color-text-primary")).toBe(true);
		expect(isOverridden(s, "--space-2")).toBe(false);
	});
});

describe("effectiveValue", () => {
	it("prefers a non-blank override, else the base, else empty", () => {
		const s = set({ "--color-text-primary": "#abc" });
		expect(effectiveValue(base, s, "--color-text-primary")).toBe("#abc");
		expect(effectiveValue(base, s, "--color-background-primary")).toBe("#fff");
		expect(effectiveValue(base, s, "--not-a-token")).toBe("");
	});
});

describe("composePreviewVars", () => {
	it("layers clean overrides over the base", () => {
		const s = set({ "--color-text-primary": "  #abc  ", "--color-not-real": "#000" });
		expect(composePreviewVars(base, s)).toEqual({
			"--color-text-primary": "#abc",
			"--color-background-primary": "#fff",
		});
	});
});
