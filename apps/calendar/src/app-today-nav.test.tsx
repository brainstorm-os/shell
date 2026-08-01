// @vitest-environment jsdom
/**
 * POLISH-LAY-5 repro probe — "Calendar Today doesn't return after paging".
 *
 * The `228-deep-calendar` dogfood step reported Today as dead, but its
 * locator was `button[aria-label="Today"], [title="Today"]` — the shared
 * `DatePager` Today button is a plain TEXT button (`.bs-date-pager__today`)
 * with neither attribute, so the spec clicked nothing and the `.catch()`
 * swallowed the miss. This test drives the REAL buttons end-to-end (page
 * Next twice, click Today) and pins that the range label returns home —
 * the product behaviour was never broken.
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

describe("CalendarApp Today after paging (POLISH-LAY-5)", () => {
	it("Next ×2 then Today returns the range to the current month", async () => {
		localStorage.clear();
		handle = await renderInto(<CalendarApp />);
		await flush();
		const c = handle.container;
		const range = () => c.querySelector(".cal-toolbar__range")?.textContent ?? "";
		const home = range();
		expect(home).not.toBe("");

		const next = c.querySelector<HTMLButtonElement>(".bs-date-pager__arrow--next");
		expect(next).not.toBeNull();
		await act(async () => next?.click());
		await act(async () => next?.click());
		const away = range();
		expect(away).not.toBe(home);

		const today = c.querySelector<HTMLButtonElement>(".bs-date-pager__today");
		expect(today).not.toBeNull();
		await act(async () => today?.click());
		expect(range()).toBe(home);
	});
});
