import { describe, expect, it } from "vitest";
import { themeToCss } from "./theme-css";

describe("themeToCss", () => {
	it("declares the tokens on :root ahead of the typographic base", () => {
		const css = themeToCss({
			"--color-background-primary": "#101014",
			"--color-text-link": "rgb(120, 170, 255)",
			"--color-field-border": "var(--color-border-default)",
		});
		expect(css.startsWith(":root {\n\t--color-background-primary: #101014;\n")).toBe(true);
		expect(css).toContain("\t--color-text-link: rgb(120, 170, 255);");
		expect(css).toContain("\t--color-field-border: var(--color-border-default);");
		expect(css).toContain("background: var(--color-background-primary, #ffffff);");
	});

	it("still styles a site when no tokens are given", () => {
		expect(themeToCss({})).toContain("max-width: 42rem");
	});

	it("loads nothing from outside the site", () => {
		const css = themeToCss({ "--color-text-primary": "#111" });
		expect(css).not.toMatch(/url\(|@import|@font-face|https?:/);
	});

	it.each([
		["--color-x", "red; } body { display: none"],
		["--color-x", "red } html { color: blue"],
		["--color-x", 'url("file:///Users/me/wallpaper.png")'],
		["--color-x", "URL (https://tracker.example/p.gif)"],
		["--color-x", "red; @import 'https://evil.example/x.css'"],
		["--color-x", "</style><script>alert(1)</script>"],
		["--color-x", "\\75 rl(https://evil.example)"],
		["--color-x", "red /* swallow"],
		["--color-x", "red\n}"],
		["--color-x; } body { color: red", "blue"],
		["color", "blue"],
		["--Color-X", "blue"],
		["--", "blue"],
	])("drops the hostile token %j: %j", (name, value) => {
		expect(themeToCss({ [name]: value })).toBe(themeToCss({}));
	});
});
