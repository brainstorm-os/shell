// @vitest-environment jsdom
/**
 * `shellAppearanceDark` — the shell paints the resolved appearance as
 * `color-scheme` on `<body>` (#brainstorm-tokens); this helper is how every
 * highlight consumer reads it. Guards the dark-sweep 2026-07-29 regression
 * class: resolving a highlight theme from the OS media query (or from
 * `<html>`, masked by the app's `:root { color-scheme: light dark }`) painted
 * the wrong Shiki palette on the opposite surface.
 */

import { afterEach, describe, expect, it } from "vitest";
import { shellAppearanceDark } from "./index";

describe("shellAppearanceDark", () => {
	afterEach(() => {
		document.body.style.removeProperty("color-scheme");
	});

	it("reads the painted body appearance in both directions", () => {
		document.body.style.setProperty("color-scheme", "dark");
		expect(shellAppearanceDark()).toBe(true);
		document.body.style.setProperty("color-scheme", "light");
		expect(shellAppearanceDark()).toBe(false);
	});

	it("returns null when no shell painted a scheme (tests, detached docs)", () => {
		expect(shellAppearanceDark()).toBeNull();
	});

	it("treats the un-resolved 'light dark' pair as not painted", () => {
		// The app's own `:root { color-scheme: light dark }` inherits onto
		// `<body>` when the shell's rule is absent — that is NOT an appearance.
		document.body.style.setProperty("color-scheme", "light dark");
		expect(shellAppearanceDark()).toBeNull();
	});
});
