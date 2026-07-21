// @vitest-environment jsdom
/**
 * Reminders quick-capture (F-219): the primary is disabled while the
 * subject is blank (no silent no-op click), enables the moment a subject
 * is typed, and the form's submit path (what Enter in the subject input
 * drives in the browser) captures with the default due when the date is
 * left blank.
 */

import type { ReminderDef } from "@brainstorm-os/sdk-types";
import type { CalendarPopoverOptions } from "@brainstorm-os/sdk/calendar";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { defaultDue } from "../logic/reminder-capture";
import { flush, renderInto } from "../test/render";
import { RemindersView } from "./reminders-view";

// Capture the popover options so a test can drive `onSelect` (the picked-day
// callback) the way clicking a day in the real shared calendar would.
const openCalendarPopover = vi.fn();
vi.mock("@brainstorm-os/sdk/calendar", () => ({
	openCalendarPopover: (opts: CalendarPopoverOptions) => openCalendarPopover(opts),
}));
// The time half is the shared <SelectMenu>; render a minimal stand-in so the
// capture test doesn't depend on the fancy-menus runtime.
vi.mock("@brainstorm-os/sdk/select-menu", () => ({
	SelectMenu: ({ value, ariaLabel }: { value: string; ariaLabel: string }) => (
		<button type="button" className="au-capture__due-time" aria-label={ariaLabel}>
			{value}
		</button>
	),
}));

const NOW = Date.parse("2026-06-11T12:00:00.000Z");

async function mount(onAdd: (def: ReminderDef) => void = () => {}) {
	const handle = await renderInto(
		<RemindersView
			reminders={[]}
			now={() => NOW}
			onAdd={onAdd}
			onMutate={() => {}}
			onDelete={() => {}}
		/>,
	);
	await flush();
	return handle;
}

function subjectInput(container: HTMLElement): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>(".au-capture__subject");
	if (!input) throw new Error("subject input missing");
	return input;
}

function addButton(container: HTMLElement): HTMLButtonElement {
	const btn = container.querySelector<HTMLButtonElement>('.au-capture button[type="submit"]');
	if (!btn) throw new Error("Add reminder button missing");
	return btn;
}

async function typeSubject(input: HTMLInputElement, value: string): Promise<void> {
	const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	await act(async () => {
		set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("reminder quick-capture validity (F-219)", () => {
	it("renders Add disabled (+aria-disabled) on an empty form", async () => {
		const handle = await mount();
		const btn = addButton(handle.container);
		expect(btn.disabled).toBe(true);
		expect(btn.getAttribute("aria-disabled")).toBe("true");
		await handle.unmount();
	});

	it("typing a subject enables Add; clearing it disables again", async () => {
		const handle = await mount();
		const input = subjectInput(handle.container);
		await typeSubject(input, "Renewal check — Beacon Analytics");
		expect(addButton(handle.container).disabled).toBe(false);
		expect(addButton(handle.container).hasAttribute("aria-disabled")).toBe(false);
		await typeSubject(input, "   ");
		expect(addButton(handle.container).disabled).toBe(true);
		await handle.unmount();
	});

	it("submit (the Enter path) captures with defaultDue when the date is blank, then resets", async () => {
		const onAdd = vi.fn();
		const handle = await mount(onAdd);
		const input = subjectInput(handle.container);
		await typeSubject(input, "Renewal check");
		const form = handle.container.querySelector<HTMLFormElement>("form.au-capture");
		await act(async () => {
			form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(onAdd).toHaveBeenCalledTimes(1);
		const def = onAdd.mock.calls[0]?.[0] as ReminderDef;
		expect(def.subject).toBe("Renewal check");
		expect(def.dueAt).toBe(new Date(defaultDue(NOW)).toISOString());
		// The form resets for the next capture and disables the primary again.
		expect(subjectInput(handle.container).value).toBe("");
		expect(addButton(handle.container).disabled).toBe(true);
		await handle.unmount();
	});
});

describe("reminder due picker (F-229 — no native datetime-local)", () => {
	it("uses a themed date trigger, never a native datetime-local input", async () => {
		const handle = await mount();
		expect(handle.container.querySelector('input[type="datetime-local"]')).toBeNull();
		const trigger = handle.container.querySelector<HTMLButtonElement>(".au-capture__due-trigger");
		expect(trigger).toBeTruthy();
		expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");
		// Blank state shows the empty label, the time slot + clear are hidden.
		expect(trigger?.querySelector(".au-capture__due-text")?.getAttribute("data-empty")).toBe("true");
		expect(handle.container.querySelector(".au-capture__due-time")).toBeNull();
		expect(handle.container.querySelector(".au-capture__due-clear")).toBeNull();
		await handle.unmount();
	});

	it("opens the shared calendar popover and a picked day flows into the captured dueAt", async () => {
		openCalendarPopover.mockClear();
		const onAdd = vi.fn();
		const handle = await mount(onAdd);
		const input = subjectInput(handle.container);
		await typeSubject(input, "Renewal check");

		const trigger = handle.container.querySelector<HTMLButtonElement>(".au-capture__due-trigger");
		await act(async () => {
			trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(openCalendarPopover).toHaveBeenCalledTimes(1);

		// Drive the popover's onSelect the way clicking a day would — Jun 20 2026
		// local. With no prior time the field defaults to 09:00 local.
		const opts = openCalendarPopover.mock.calls[0]?.[0] as CalendarPopoverOptions;
		const picked = new Date(2026, 5, 20, 0, 0, 0, 0).getTime();
		await act(async () => {
			opts.onSelect(picked);
		});

		// The trigger now reflects the picked date and reveals the time + clear.
		const text = handle.container.querySelector(".au-capture__due-text");
		expect(text?.getAttribute("data-empty")).toBe("false");
		expect(handle.container.querySelector(".au-capture__due-time")).toBeTruthy();
		expect(handle.container.querySelector(".au-capture__due-clear")).toBeTruthy();

		const form = handle.container.querySelector<HTMLFormElement>("form.au-capture");
		await act(async () => {
			form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(onAdd).toHaveBeenCalledTimes(1);
		const def = onAdd.mock.calls[0]?.[0] as ReminderDef;
		expect(def.dueAt).toBe(new Date(2026, 5, 20, 9, 0, 0, 0).toISOString());
		await handle.unmount();
	});

	it("clearing the due date returns to the blank (defaultDue) state", async () => {
		openCalendarPopover.mockClear();
		const onAdd = vi.fn();
		const handle = await mount(onAdd);
		await typeSubject(subjectInput(handle.container), "Renewal check");

		const trigger = handle.container.querySelector<HTMLButtonElement>(".au-capture__due-trigger");
		await act(async () => {
			trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const opts = openCalendarPopover.mock.calls[0]?.[0] as CalendarPopoverOptions;
		await act(async () => {
			opts.onSelect(new Date(2026, 5, 20, 0, 0, 0, 0).getTime());
		});

		const clear = handle.container.querySelector<HTMLButtonElement>(".au-capture__due-clear");
		await act(async () => {
			clear?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(handle.container.querySelector(".au-capture__due-text")?.getAttribute("data-empty")).toBe(
			"true",
		);

		const form = handle.container.querySelector<HTMLFormElement>("form.au-capture");
		await act(async () => {
			form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		const def = onAdd.mock.calls[0]?.[0] as ReminderDef;
		expect(def.dueAt).toBe(new Date(defaultDue(NOW)).toISOString());
		await handle.unmount();
	});
});
