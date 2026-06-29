// @vitest-environment jsdom
import { closeCalendarPopover } from "@brainstorm/sdk/calendar";
import {
	BrainstormMenuProvider,
	CONTEXT_MENU_ID,
	type ContextMenuItem,
	closeContextMenu,
	getActiveMenuStore,
} from "@brainstorm/sdk/menus";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, renderInto } from "../../test/render";
import type { Event } from "../../types/event";
import { EventDetail } from "./event-detail";

function makeEvent(over: Partial<Event> = {}): Event {
	const now = 1_700_000_000_000;
	return {
		id: "evt-1",
		title: "Standup",
		icon: null,
		start: now,
		end: now + 3_600_000,
		allDay: false,
		location: null,
		recurrence: null,
		statusKey: null,
		colorHint: null,
		reminders: [],
		attendees: [],
		timeZone: null,
		createdAt: now,
		updatedAt: now,
		...over,
	};
}

const objectMenu = () => ({
	target: { entityId: "evt-1", entityType: "brainstorm/Event/v1", label: "Standup" },
	runtime: null,
});

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;
afterEach(async () => {
	await act(async () => closeContextMenu());
	closeCalendarPopover();
	await handle?.unmount();
	handle = null;
	document.body.replaceChildren();
});

function setValue(el: HTMLInputElement, value: string): void {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Items of the open select-menu popup for the trigger's accessible name. */
function openMenuItems(menuLabel: string): ContextMenuItem[] {
	const open = getActiveMenuStore()
		?.getAll()
		.find((m) => m.id === `${CONTEXT_MENU_ID}:${menuLabel}`);
	expect(open, `menu ${menuLabel} should be open`).toBeDefined();
	return (open?.param.data as { items: ContextMenuItem[] }).items;
}

describe("EventDetail — object menu in the title row", () => {
	it("editing an existing event exposes the ⋯ object-menu button", async () => {
		handle = await renderInto(
			<EventDetail
				event={makeEvent()}
				defaultStart={Date.now()}
				onResolve={vi.fn()}
				onClose={vi.fn()}
				objectMenu={objectMenu}
			/>,
		);
		const titleRow = document.querySelector(".cal-detail__title-row");
		expect(titleRow).not.toBeNull();
		const more = titleRow?.querySelector(".bs-object-menu__more");
		expect(more).not.toBeNull();
		expect(more?.classList.contains("cal-detail__more")).toBe(true);
	});

	it("right-click on the title row opens the menu (preventDefault'd)", async () => {
		const provider = vi.fn(objectMenu);
		handle = await renderInto(
			<EventDetail
				event={makeEvent()}
				defaultStart={Date.now()}
				onResolve={vi.fn()}
				onClose={vi.fn()}
				objectMenu={provider}
			/>,
		);
		const titleRow = document.querySelector(".cal-detail__title-row") as HTMLElement;
		const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		titleRow.dispatchEvent(evt);
		expect(provider).toHaveBeenCalled();
		expect(evt.defaultPrevented).toBe(true);
	});

	it("the create surface carries NO object menu", async () => {
		handle = await renderInto(
			<EventDetail
				event={null}
				defaultStart={Date.now()}
				onResolve={vi.fn()}
				onClose={vi.fn()}
				objectMenu={objectMenu}
			/>,
		);
		const titleRow = document.querySelector(".cal-detail__title-row");
		expect(titleRow).not.toBeNull();
		expect(titleRow?.querySelector(".bs-object-menu__more")).toBeNull();
	});
});

describe("EventDetail — fields", () => {
	it("picking a status + colour writes them into the saved event", async () => {
		const onResolve = vi.fn();
		handle = await renderInto(
			<BrainstormMenuProvider>
				<EventDetail
					event={makeEvent()}
					defaultStart={Date.now()}
					onResolve={onResolve}
					onClose={vi.fn()}
				/>
			</BrainstormMenuProvider>,
		);
		// Status is the shared <SelectMenu> — open it, pick "Tentative".
		const status = document.querySelector<HTMLButtonElement>(".cal-detail__status");
		if (!status) throw new Error("no status select");
		await act(async () => status.click());
		const tentative = openMenuItems("Status").find((it) => it.label === "Tentative");
		await act(async () => tentative?.onSelect?.());
		await flush();
		expect(status.querySelector(".bs-select__value")?.textContent).toBe("Tentative");

		const swatch = document.querySelector<HTMLButtonElement>(
			'.cal-detail__swatch[data-color="amber"]',
		);
		swatch?.click();
		await flush();
		expect(swatch?.getAttribute("aria-checked")).toBe("true");

		document.querySelector<HTMLButtonElement>("[data-bs-primary]")?.click();
		const resolved = onResolve.mock.calls[0]?.[0];
		expect(resolved.kind).toBe("saved");
		expect(resolved.event.statusKey).toBe("tentative");
		expect(resolved.event.colorHint).toBe("#d49241");
	});

	it("the confirmed default + default colour persist as null", async () => {
		const onResolve = vi.fn();
		handle = await renderInto(
			<BrainstormMenuProvider>
				<EventDetail
					event={makeEvent({ statusKey: "tentative", colorHint: "#d49241" })}
					defaultStart={Date.now()}
					onResolve={onResolve}
					onClose={vi.fn()}
				/>
			</BrainstormMenuProvider>,
		);
		const status = document.querySelector<HTMLButtonElement>(".cal-detail__status");
		if (!status) throw new Error("no status select");
		await act(async () => status.click());
		const confirmed = openMenuItems("Status").find((it) => it.label === "Confirmed");
		await act(async () => confirmed?.onSelect?.());
		await flush();
		document.querySelector<HTMLButtonElement>(".cal-detail__swatch--none")?.click();
		await flush();
		document.querySelector<HTMLButtonElement>("[data-bs-primary]")?.click();
		const resolved = onResolve.mock.calls[0]?.[0];
		expect(resolved.event.statusKey).toBeNull();
		expect(resolved.event.colorHint).toBeNull();
	});

	it("toggling reminder presets writes a normalized offset list", async () => {
		const onResolve = vi.fn();
		handle = await renderInto(
			<EventDetail
				event={makeEvent()}
				defaultStart={Date.now()}
				onResolve={onResolve}
				onClose={vi.fn()}
			/>,
		);
		document.querySelector<HTMLButtonElement>('.cal-detail__reminder[data-minutes="60"]')?.click();
		await flush();
		document.querySelector<HTMLButtonElement>('.cal-detail__reminder[data-minutes="10"]')?.click();
		await flush();
		document.querySelector<HTMLButtonElement>("[data-bs-primary]")?.click();
		const resolved = onResolve.mock.calls[0]?.[0];
		expect(resolved.event.reminders).toEqual([10, 60]);
	});

	it("picking a time zone writes it and reinterprets the wall-clock", async () => {
		const onResolve = vi.fn();
		const start = Date.UTC(2026, 6, 1, 16, 0, 0);
		handle = await renderInto(
			<BrainstormMenuProvider>
				<EventDetail
					event={makeEvent({ start, end: start + 3_600_000 })}
					defaultStart={start}
					onResolve={onResolve}
					onClose={vi.fn()}
				/>
			</BrainstormMenuProvider>,
		);
		const tz = document.querySelector<HTMLButtonElement>(".cal-detail__tz");
		if (!tz) throw new Error("no tz select");
		expect(tz.querySelector(".bs-select__value")?.textContent).toBe("Local time");
		await act(async () => tz.click());
		const utc = openMenuItems("Time zone").find((it) => !it.section && it.label === "UTC");
		await act(async () => utc?.onSelect?.());
		await flush();
		document.querySelector<HTMLButtonElement>("[data-bs-primary]")?.click();
		expect(onResolve.mock.calls[0]?.[0]?.event.timeZone).toBe("UTC");
	});

	it("opens an existing UTC-zoned event with the zone preselected", async () => {
		handle = await renderInto(
			<EventDetail
				event={makeEvent({ timeZone: "UTC", start: Date.UTC(2026, 6, 1, 16, 0, 0) })}
				defaultStart={Date.now()}
				onResolve={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(document.querySelector(".cal-detail__tz .bs-select__value")?.textContent).toBe("UTC");
	});

	it("groups the zone picker: a 'Common' shortlist ahead of the full set", async () => {
		handle = await renderInto(
			<BrainstormMenuProvider>
				<EventDetail
					event={makeEvent({ start: Date.UTC(2026, 6, 1, 16, 0, 0) })}
					defaultStart={Date.now()}
					onResolve={vi.fn()}
					onClose={vi.fn()}
				/>
			</BrainstormMenuProvider>,
		);
		const tz = document.querySelector<HTMLButtonElement>(".cal-detail__tz");
		if (!tz) throw new Error("no tz select");
		await act(async () => tz.click());
		const items = openMenuItems("Time zone");
		const sectionIdx = items.flatMap((it, i) => (it.section ? [i] : []));
		expect(sectionIdx.length).toBeGreaterThan(1);
		const first = sectionIdx[0] ?? -1;
		const second = sectionIdx[1] ?? items.length;
		expect(items[first]?.label).toBe("Common");
		// The Common shortlist = the run of options between the first two headings.
		expect(second - first - 1).toBeLessThan(15);
		// The unset "Local time" option leads, ahead of any heading.
		expect(items[0]?.section).toBeUndefined();
		expect(items[0]?.label).toBe("Local time");
	});

	it("KBN-A: status + colour radiogroup roles come from the binding", async () => {
		handle = await renderInto(
			<EventDetail
				event={makeEvent()}
				defaultStart={Date.now()}
				onResolve={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		// Status is now the shared <SelectMenu> (its own a11y is SDK-tested);
		// colour stays a swatch radiogroup.
		expect(document.querySelector(".cal-detail__status")?.classList.contains("bs-select")).toBe(true);
		expect(document.querySelector(".cal-detail__swatches")?.getAttribute("role")).toBe("radiogroup");
		for (const sw of document.querySelectorAll(".cal-detail__swatch")) {
			expect(sw.getAttribute("role")).toBe("radio");
		}
	});

	it("adding an attendee writes it into the saved event", async () => {
		const onResolve = vi.fn();
		handle = await renderInto(
			<EventDetail
				event={makeEvent()}
				defaultStart={Date.now()}
				onResolve={onResolve}
				onClose={vi.fn()}
			/>,
		);
		const adds = document.querySelectorAll<HTMLInputElement>(".cal-attendees__add input");
		const [nameInput, emailInput] = adds;
		if (!nameInput || !emailInput) throw new Error("no attendee add inputs");
		setValue(nameInput, "Mira");
		setValue(emailInput, "mira@x.io");
		await flush();
		document.querySelector<HTMLButtonElement>(".cal-attendees__add button")?.click();
		await flush();
		document.querySelector<HTMLButtonElement>("[data-bs-primary]")?.click();
		const resolved = onResolve.mock.calls[0]?.[0];
		expect(resolved.event.attendees).toEqual([
			{ name: "Mira", email: "mira@x.io", rsvp: "needs-action" },
		]);
	});

	it("renders no native date/time inputs — start/end use the shared picker (F-229)", async () => {
		handle = await renderInto(
			<EventDetail
				event={makeEvent()}
				defaultStart={Date.now()}
				onResolve={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(document.querySelector('input[type="date"]')).toBeNull();
		expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
		expect(document.querySelector('input[type="time"]')).toBeNull();
		expect(document.querySelectorAll(".cal-detail__date-trigger").length).toBe(2);
	});

	it("moving the start day via the calendar carries the end by the same delta (F-025)", async () => {
		const onResolve = vi.fn();
		const start = new Date(2030, 0, 10, 9, 0, 0, 0).getTime();
		handle = await renderInto(
			<EventDetail
				event={makeEvent({ start, end: start + 3_600_000 })}
				defaultStart={start}
				onResolve={onResolve}
				onClose={vi.fn()}
			/>,
		);
		const startTrigger = document.querySelectorAll<HTMLButtonElement>(".cal-detail__date-trigger")[0];
		if (!startTrigger) throw new Error("expected the start date trigger");
		startTrigger.click();
		await flush();
		// Move the start three days later; the day cell commits a local-midnight ms.
		const newDay = new Date(2030, 0, 13, 0, 0, 0, 0).getTime();
		const cell = document.querySelector<HTMLElement>(
			`.bs-cal-popover [data-date-epoch-ms="${newDay}"] .bs-cal-month__date`,
		);
		if (!cell) throw new Error("expected the 2030-01-13 day cell in the popover");
		cell.click();
		await flush();

		document.querySelector<HTMLButtonElement>("[data-bs-primary]")?.click();
		expect(onResolve).toHaveBeenCalledTimes(1);
		const resolved = onResolve.mock.calls[0]?.[0];
		expect(resolved.kind).toBe("saved");
		// Start moved 3 days; end carried so the 1h duration is preserved.
		expect(resolved.event.end - resolved.event.start).toBe(3_600_000);
		expect(resolved.event.start).toBe(new Date(2030, 0, 13, 9, 0, 0, 0).getTime());
	});
});

describe("EventDetail — Enter in the title commits the save (F-218)", () => {
	it("Enter in the title input resolves the typed event", async () => {
		const onResolve = vi.fn();
		const onClose = vi.fn();
		// Minute-aligned: the start round-trips through a `datetime-local` input.
		const start = new Date(2026, 5, 11, 15, 0, 0, 0).getTime();
		handle = await renderInto(
			<EventDetail event={null} defaultStart={start} onResolve={onResolve} onClose={onClose} />,
		);
		const title = document.querySelector<HTMLInputElement>(".cal-detail__input--title");
		if (!title) throw new Error("expected the title input");
		setValue(title, "Design sync");
		await flush();
		title.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
		);
		await flush();
		expect(onResolve).toHaveBeenCalledTimes(1);
		const resolved = onResolve.mock.calls[0]?.[0];
		expect(resolved.kind).toBe("saved");
		expect(resolved.event.title).toBe("Design sync");
		expect(resolved.event.start).toBe(start);
		expect(onClose).toHaveBeenCalled();
	});

	it("Enter with an empty title surfaces the validation error instead of saving", async () => {
		const onResolve = vi.fn();
		handle = await renderInto(
			<EventDetail event={null} defaultStart={Date.now()} onResolve={onResolve} onClose={vi.fn()} />,
		);
		const title = document.querySelector<HTMLInputElement>(".cal-detail__input--title");
		title?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
		);
		await flush();
		expect(onResolve).not.toHaveBeenCalled();
		const error = document.querySelector<HTMLElement>(".cal-detail__error");
		expect(error?.hidden).toBe(false);
	});
});
