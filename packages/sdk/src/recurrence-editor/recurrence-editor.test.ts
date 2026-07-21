// @vitest-environment jsdom
import { RecurrenceKind, Weekday } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRecurrenceLabels } from "../i18n/recurrence-labels";
import {
	CONTEXT_MENU_ID,
	type ContextMenuItem,
	closeContextMenu,
	getActiveMenuStore,
	mountMenuHost,
} from "../menus";
import { RepeatKind } from "../recurrence-edit";
import { type RecurrenceEditorLabels, createRecurrenceEditor } from "./recurrence-editor";

// 2024-01-03 is a Wednesday.
const WED = new Date(2024, 0, 3, 9, 0).getTime();

// Phrase templates collapse to their interpolated params so the summary
// contains the weekday short name; weekday/month names come from the locale.
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

let disposeMenuHost: () => void = () => {};

beforeEach(() => {
	act(() => {
		disposeMenuHost = mountMenuHost();
	});
});

afterEach(() => {
	act(() => closeContextMenu());
	act(() => disposeMenuHost());
	document.body.replaceChildren();
});

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

function kindTrigger(editor: { element: HTMLElement }): HTMLButtonElement {
	const el = editor.element.querySelector<HTMLButtonElement>(".bs-recur__kind");
	if (!el) throw new Error("no kind select trigger");
	return el;
}

describe("createRecurrenceEditor (SDK)", () => {
	it("opens on 'none' for null, getValue null, kind options use injected labels", () => {
		const editor = createRecurrenceEditor({
			value: null,
			start: WED,
			labels: LABELS,
			summaryLabels: SUMMARY,
		});
		document.body.appendChild(editor.element);
		const trigger = kindTrigger(editor);
		expect(trigger.querySelector(".bs-select__value")?.textContent).toBe("Does not repeat");
		const items = openOptions(trigger, LABELS.fieldLabel);
		expect(items.map((it) => it.label)).toContain("Weekly");
		act(() => closeContextMenu());
		expect(editor.getValue()).toBeNull();
	});

	it("switching to weekly seeds the start weekday + live summary", () => {
		const editor = createRecurrenceEditor({
			value: null,
			start: WED,
			labels: LABELS,
			summaryLabels: SUMMARY,
		});
		document.body.appendChild(editor.element);
		pickOption(kindTrigger(editor), LABELS.fieldLabel, "Weekly");
		expect(editor.getValue()).toEqual({
			kind: RecurrenceKind.Weekly,
			every: 1,
			days: [Weekday.Wed],
		});
		expect(editor.element.querySelector(".bs-recur__summary")?.textContent).toContain("Wed");
	});

	it("weekday toggles never empty the set", () => {
		const editor = createRecurrenceEditor({
			value: { kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Wed] },
			start: WED,
			labels: LABELS,
			summaryLabels: SUMMARY,
		});
		document.body.appendChild(editor.element);
		const wed = editor.element.querySelector<HTMLButtonElement>('[data-weekday="wed"]');
		wed?.click(); // would empty → normalized back to anchor (Wed)
		const days = (editor.getValue() as unknown as { days: Weekday[] }).days;
		expect(days.length).toBeGreaterThanOrEqual(1);
	});

	it("interval clamps to >= 1", () => {
		const editor = createRecurrenceEditor({
			value: { kind: RecurrenceKind.Daily, every: 1 },
			start: WED,
			labels: LABELS,
			summaryLabels: SUMMARY,
		});
		document.body.appendChild(editor.element);
		const input = editor.element.querySelector<HTMLInputElement>(".bs-recur__interval");
		if (!input) throw new Error("no interval input");
		input.value = "0";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		expect(editor.getValue()).toEqual({ kind: RecurrenceKind.Daily, every: 1 });
	});

	it("onChange fires with the coerced value", () => {
		const seen: (unknown | null)[] = [];
		const editor = createRecurrenceEditor({
			value: null,
			start: WED,
			labels: LABELS,
			summaryLabels: SUMMARY,
			onChange: (v) => seen.push(v),
		});
		document.body.appendChild(editor.element);
		pickOption(kindTrigger(editor), LABELS.fieldLabel, "Daily");
		expect(seen.at(-1)).toEqual({ kind: RecurrenceKind.Daily, every: 1 });
	});
});
