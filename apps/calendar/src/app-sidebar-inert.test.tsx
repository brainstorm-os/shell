// @vitest-environment jsdom
/**
 * F-489 follow-up. Calendar's sidebar slides out on `transform:
 * translateX(-100%)` and the CSS guard (`visibility: hidden`) rides the same
 * 180ms transition, so it only lands at the END of the close — for that whole
 * duration every source checkbox and mini-month day stays tabbable and
 * announced. `inert` on the slot closes the window immediately, and holds if
 * the stylesheet is ever overridden.
 */

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CalendarApp } from "./app";
import { flush, renderInto } from "./test/render";

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;
afterEach(async () => {
	await handle?.unmount();
	handle = null;
	document.body.replaceChildren();
	localStorage.clear();
});

describe("CalendarApp collapsed sidebar (F-489)", () => {
	it("drops the sidebar out of the tab order the moment it closes", async () => {
		localStorage.clear();
		handle = await renderInto(<CalendarApp />);
		await flush();
		const c = handle.container;
		const slot = c.querySelector("#calendar-sidebar-slot") as HTMLElement;
		expect(slot).not.toBeNull();
		expect(slot.hasAttribute("inert")).toBe(false);

		const toggle = c.querySelector<HTMLButtonElement>(".bs-panel-toggle");
		expect(toggle).not.toBeNull();
		await act(async () => toggle?.click());

		expect(slot.hasAttribute("inert")).toBe(true);
		expect(slot.getAttribute("aria-hidden")).toBe("true");
	});
});
