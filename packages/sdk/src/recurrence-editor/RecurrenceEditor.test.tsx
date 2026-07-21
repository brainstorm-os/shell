// @vitest-environment jsdom
import { type Recurrence, RecurrenceKind, Weekday } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRecurrenceLabels } from "../i18n/recurrence-labels";
import {
	BrainstormMenuProvider,
	CONTEXT_MENU_ID,
	type ContextMenuItem,
	closeContextMenu,
	getActiveMenuStore,
} from "../menus";
import { RepeatKind } from "../recurrence-edit";
import { RecurrenceEditor } from "./RecurrenceEditor";
import type { RecurrenceEditorLabels } from "./recurrence-editor";

// 2024-01-03 is a Wednesday.
const WED = new Date(2024, 0, 3, 9, 0).getTime();

const SUMMARY = buildRecurrenceLabels((key, params) =>
	params ? Object.values(params).join(" ") : key,
);

const LABELS: RecurrenceEditorLabels = {
	fieldLabel: "Repeat",
	kind: {
		[RepeatKind.None]: "Does not repeat",
		[RepeatKind.Daily]: "Daily",
		[RepeatKind.Weekly]: "Weekly",
		[RepeatKind.Monthly]: "Monthly",
		[RepeatKind.Yearly]: "Yearly",
		[RepeatKind.Custom]: "Custom",
	},
	editEvery: "Every",
	unitDays: "days",
	unitWeeks: "weeks",
	unitMonths: "months",
	intervalLabel: "Interval",
	onDays: "On days",
	monthlyMode: "Monthly mode",
	monthlyByDayLabel: "On day",
	monthlyByWeekdayLabel: "On the",
	yearlyMonth: "Month",
	yearlyDay: "Day",
	customLabel: "RRULE",
	customPlaceholder: "FREQ=WEEKLY",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => closeContextMenu());
	act(() => root.unmount());
	container.remove();
});

function render(value: Recurrence | null, onChange = vi.fn()) {
	act(() => {
		root.render(
			<BrainstormMenuProvider>
				<RecurrenceEditor
					value={value}
					start={WED}
					labels={LABELS}
					summaryLabels={SUMMARY}
					onChange={onChange}
				/>
			</BrainstormMenuProvider>,
		);
	});
	return onChange;
}

function kindSelect(): HTMLButtonElement {
	const el = container.querySelector<HTMLButtonElement>(".bs-recur__kind");
	if (!el) throw new Error("no kind select trigger");
	return el;
}

/** Open a select-menu trigger and return the option rows the shared
 *  context-menu config received (one menu open at a time). */
function openOptions(trigger: HTMLElement, menuLabel: string): ContextMenuItem[] {
	act(() => trigger.click());
	const store = getActiveMenuStore();
	const id = `${CONTEXT_MENU_ID}:${menuLabel}`;
	const open = store?.getAll().find((m) => m.id === id);
	expect(open, `menu ${id} should be open`).toBeDefined();
	return (open?.param.data as { items: ContextMenuItem[] }).items;
}

function pickOption(trigger: HTMLElement, menuLabel: string, optionLabel: string): void {
	const items = openOptions(trigger, menuLabel);
	const item = items.find((it) => it.label === optionLabel);
	if (!item) throw new Error(`no option ${optionLabel} in ${menuLabel}`);
	act(() => item.onSelect?.());
	act(() => closeContextMenu());
}

function changeInput(el: HTMLInputElement, value: string): void {
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("<RecurrenceEditor>", () => {
	it("opens on 'none' for null with the bs-recur chrome + injected kind labels, no body", () => {
		render(null);
		expect(container.querySelector(".bs-recur")).not.toBeNull();
		const select = kindSelect();
		expect(select.querySelector(".bs-select__value")?.textContent).toBe("Does not repeat");
		const items = openOptions(select, LABELS.fieldLabel);
		expect(items.map((it) => it.label)).toContain("Weekly");
		act(() => closeContextMenu());
		expect(container.querySelector(".bs-recur__body")).toBeNull();
		expect(container.querySelector(".bs-recur__summary")).toBeNull();
	});

	it("does not fire onChange on mount", () => {
		const onChange = render(null);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("picking weekly emits a Weekly recurrence seeded on the start weekday", () => {
		const onChange = render(null);
		pickOption(kindSelect(), LABELS.fieldLabel, "Weekly");
		expect(onChange).toHaveBeenCalledWith({
			kind: RecurrenceKind.Weekly,
			every: 1,
			days: [Weekday.Wed],
		});
	});

	it("picking daily emits a Daily recurrence", () => {
		const onChange = render(null);
		pickOption(kindSelect(), LABELS.fieldLabel, "Daily");
		expect(onChange).toHaveBeenCalledWith({ kind: RecurrenceKind.Daily, every: 1 });
	});

	it("renders the daily interval row and the live summary caption", () => {
		render({ kind: RecurrenceKind.Daily, every: 3 });
		const input = container.querySelector<HTMLInputElement>(".bs-recur__interval");
		expect(input?.value).toBe("3");
		const summary = container.querySelector(".bs-recur__summary");
		expect(summary?.textContent).toContain("3");
	});

	it("interval clamps to >= 1 on edit", () => {
		const onChange = render({ kind: RecurrenceKind.Daily, every: 2 });
		const input = container.querySelector<HTMLInputElement>(".bs-recur__interval");
		if (!input) throw new Error("no interval");
		changeInput(input, "0");
		expect(onChange).toHaveBeenCalledWith({ kind: RecurrenceKind.Daily, every: 1 });
	});

	it("weekly renders 7 weekday toggles with the anchor day selected + summary names it", () => {
		render({ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Wed] });
		const toggles = container.querySelectorAll<HTMLButtonElement>(".bs-recur__weekday");
		expect(toggles).toHaveLength(7);
		const wed = container.querySelector<HTMLButtonElement>('[data-weekday="wed"]');
		expect(wed?.dataset.selected).toBe("true");
		expect(wed?.getAttribute("aria-checked")).toBe("true");
		expect(container.querySelector(".bs-recur__summary")?.textContent).toContain("Wed");
	});

	it("weekday toggle never empties the set (normalizes back to anchor)", () => {
		const onChange = render({ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Wed] });
		const wed = container.querySelector<HTMLButtonElement>('[data-weekday="wed"]');
		act(() => wed?.click());
		const last = onChange.mock.calls.at(-1)?.[0] as { days: Weekday[] };
		expect(last.days.length).toBeGreaterThanOrEqual(1);
	});

	it("adding a weekday emits the canonical-ordered set", () => {
		const onChange = render({ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Wed] });
		const mon = container.querySelector<HTMLButtonElement>('[data-weekday="mon"]');
		act(() => mon?.click());
		expect(onChange).toHaveBeenCalledWith({
			kind: RecurrenceKind.Weekly,
			every: 1,
			days: [Weekday.Mon, Weekday.Wed],
		});
	});

	it("monthly renders a by-day / by-weekday radiogroup, by-day selected when dayOfMonth set", () => {
		render({ kind: RecurrenceKind.Monthly, every: 1, dayOfMonth: 3 });
		const group = container.querySelector(".bs-recur__monthly");
		expect(group?.getAttribute("role")).toBe("radiogroup");
		const radios = container.querySelectorAll<HTMLInputElement>(".bs-recur__radio");
		expect(radios).toHaveLength(2);
		expect(radios[0]?.checked).toBe(true);
	});

	it("monthly by-weekday emits a dayOfWeek recurrence", () => {
		const onChange = render({ kind: RecurrenceKind.Monthly, every: 1, dayOfMonth: 3 });
		const radios = container.querySelectorAll<HTMLInputElement>(".bs-recur__radio");
		act(() => {
			radios[1]?.click();
		});
		const last = onChange.mock.calls.at(-1)?.[0] as { dayOfWeek?: unknown; dayOfMonth?: unknown };
		expect(last.dayOfWeek).toBeDefined();
		expect(last.dayOfMonth).toBeUndefined();
	});

	it("yearly renders 12 month options + a day input", () => {
		render({ kind: RecurrenceKind.Yearly, month: 1, day: 3 });
		const monthTrigger = container.querySelector<HTMLButtonElement>(".bs-recur__body .bs-select");
		if (!monthTrigger) throw new Error("no month select trigger");
		const items = openOptions(monthTrigger, LABELS.yearlyMonth);
		expect(items).toHaveLength(12);
		act(() => closeContextMenu());
		const day = container.querySelector<HTMLInputElement>(".bs-recur__interval");
		expect(day?.value).toBe("3");
	});

	it("custom renders the rrule text field and trims on edit", () => {
		const onChange = render({ kind: RecurrenceKind.Custom, rrule: "FREQ=WEEKLY" });
		const input = container.querySelector<HTMLInputElement>(".bs-recur__body input[type='text']");
		expect(input?.value).toBe("FREQ=WEEKLY");
		if (!input) throw new Error("no rrule input");
		changeInput(input, "  FREQ=DAILY  ");
		expect(onChange).toHaveBeenCalledWith({ kind: RecurrenceKind.Custom, rrule: "FREQ=DAILY" });
	});

	it("picking 'none' emits null", () => {
		const onChange = render({ kind: RecurrenceKind.Daily, every: 1 });
		pickOption(kindSelect(), LABELS.fieldLabel, "Does not repeat");
		expect(onChange).toHaveBeenCalledWith(null);
	});
});
