/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IconName } from "../icon";
import { EmptyState } from "./EmptyState";
import { createEmptyState } from "./create-empty-state";
import { EmptyStateTone, emptyStateClassName } from "./tone";

describe("emptyStateClassName", () => {
	it("encodes the tone and appends extra classes", () => {
		expect(emptyStateClassName(EmptyStateTone.Hero)).toBe("bs-empty-state bs-empty-state--hero");
		expect(emptyStateClassName(EmptyStateTone.Compact)).toBe(
			"bs-empty-state bs-empty-state--compact",
		);
		expect(emptyStateClassName(EmptyStateTone.Hero, "x__slot")).toBe(
			"bs-empty-state bs-empty-state--hero x__slot",
		);
	});
});

describe("<EmptyState>", () => {
	let host: HTMLElement;
	let root: Root;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});

	afterEach(() => {
		flushSync(() => root.unmount());
		host.remove();
	});

	it("renders glyph + title and defaults to the hero tone", () => {
		flushSync(() =>
			root.render(createElement(EmptyState, { icon: IconName.Read, title: "Nothing here" })),
		);
		const surface = host.querySelector(".bs-empty-state");
		expect(surface?.classList.contains("bs-empty-state--hero")).toBe(true);
		expect(host.querySelector(".bs-empty-state__title")?.textContent).toBe("Nothing here");
		expect(host.querySelector('.bs-empty-state__glyph[aria-hidden="true"]')).not.toBeNull();
		// hint + action are opt-in
		expect(host.querySelector(".bs-empty-state__hint")).toBeNull();
		expect(host.querySelector(".bs-empty-state__action")).toBeNull();
	});

	it("renders the hint and action when provided", () => {
		flushSync(() =>
			root.render(
				createElement(EmptyState, {
					icon: IconName.Warning,
					title: "Couldn't open",
					hint: "Try again",
					tone: EmptyStateTone.Compact,
					action: createElement("button", { type: "button" }, "Retry"),
				}),
			),
		);
		expect(host.querySelector(".bs-empty-state--compact")).not.toBeNull();
		expect(host.querySelector(".bs-empty-state__hint")?.textContent).toBe("Try again");
		expect(host.querySelector(".bs-empty-state__action button")?.textContent).toBe("Retry");
	});

	it("accepts a rich-node hint (inline <kbd>, the Notes empty path)", () => {
		flushSync(() =>
			root.render(
				createElement(EmptyState, {
					icon: IconName.View,
					title: "No note open",
					hint: createElement("span", null, "Press ", createElement("kbd", null, "New note")),
				}),
			),
		);
		const hint = host.querySelector(".bs-empty-state__hint");
		expect(hint?.querySelector("kbd")?.textContent).toBe("New note");
		expect(hint?.textContent).toBe("Press New note");
	});
});

describe("createEmptyState (DOM twin)", () => {
	it("builds the same markup as the React component (hero default)", () => {
		const el = createEmptyState({ icon: IconName.Inbox, title: "All clear" });
		expect(el.classList.contains("bs-empty-state")).toBe(true);
		expect(el.classList.contains("bs-empty-state--hero")).toBe(true);
		expect(el.querySelector('.bs-empty-state__glyph[aria-hidden="true"]')).not.toBeNull();
		expect(el.querySelector(".bs-empty-state__title")?.textContent).toBe("All clear");
		expect(el.querySelector(".bs-empty-state__hint")).toBeNull();
		expect(el.querySelector(".bs-empty-state__action")).toBeNull();
	});

	it("renders hint, action element, and a compact tone when given", () => {
		const action = document.createElement("button");
		action.textContent = "New";
		const el = createEmptyState({
			icon: IconName.Sun,
			title: "Nothing today",
			hint: "Add a task",
			action,
			tone: EmptyStateTone.Compact,
		});
		expect(el.classList.contains("bs-empty-state--compact")).toBe(true);
		expect(el.querySelector(".bs-empty-state__hint")?.textContent).toBe("Add a task");
		expect(el.querySelector(".bs-empty-state__action button")?.textContent).toBe("New");
	});
});
