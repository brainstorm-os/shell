// @vitest-environment jsdom
/**
 * Guards the fancy-menus portal target for the Theme Editor. The runtime and
 * `mountMenuHost()` portal every menu straight into `document.body`; if `body`
 * is a flex container those portaled menu nodes are coerced into flex items and
 * hit-testing breaks, so the overflow ⋯ menu renders but never reacts to the
 * pointer (the real-shell dead-menu bug). The invariant: the flex column lives
 * on `#root`, `body` stays a plain block, and the host attaches at body root.
 */

import { mountMenuHost } from "@brainstorm-os/sdk/menus";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
	for (const host of Array.from(document.querySelectorAll("[data-fm-host]"))) host.remove();
});

describe("theme-editor menu host", () => {
	it("attaches the menu host as a direct child of document.body", () => {
		const dispose = mountMenuHost();
		const host = document.querySelector("[data-fm-host]");
		expect(host).toBeTruthy();
		expect(host?.parentElement).toBe(document.body);
		dispose();
		expect(document.querySelector("[data-fm-host]")).toBeNull();
	});
});
