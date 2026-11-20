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
		"#fff",
		"#1A2b3c80",
		"transparent",
		"rgb(120, 170, 255)",
		"rgba(0, 0, 0, 0.08)",
		"rgb(0 0 0 / 8%)",
		"hsl(210 40% 50%)",
		"oklch(62% 0.19 250 / 0.5)",
		"color-mix(in srgb, #ffffff 20%, transparent)",
		"var(--color-border-default)",
		"var(--color-a, rgb(0, 0, 0))",
		"calc(4px * 2)",
		"16px",
		"0.5rem 1rem",
		"-2px",
	])("keeps the colour or length %j", (value) => {
		expect(themeToCss({ "--color-x": value })).toContain(`\t--color-x: ${value};`);
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
		["--color-x", 'image-set("https://tracker.example/p.png" 1x)'],
		["--color-x", "image-set('https://tracker.example/p.png' 1x)"],
		["--color-x", "-webkit-image-set(https://tracker.example/p.png 1x)"],
		["--color-x", 'cross-fade("https://tracker.example/p.png", red)'],
		["--color-x", "image(https://tracker.example/p.png)"],
		["--color-x", "element(#x)"],
		["--color-x", "paint(worklet)"],
		["--color-x", "attr(data-x)"],
		["--color-x", "env(safe-area-inset-top)"],
		["--color-x", '"https://tracker.example/p.png"'],
		["--color-x", "'quoted'"],
		["--color-x", "https://tracker.example/p.png"],
		["--color-x", "//tracker.example/p.png"],
		["--color-x", "var(--a, image-set('https://tracker.example/p.png' 1x))"],
		["--color-x", "rgb(0 0 0"],
		["--color-x", "red)"],
		["--color-x; } body { color: red", "blue"],
		["color", "blue"],
		["--Color-X", "blue"],
		["--", "blue"],
	])("drops the hostile token %j: %j", (name, value) => {
		expect(themeToCss({ [name]: value })).toBe(themeToCss({}));
	});
});
