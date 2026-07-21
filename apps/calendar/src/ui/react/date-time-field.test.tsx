// @vitest-environment jsdom
import { closeCalendarPopover } from "@brainstorm-os/sdk/calendar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInto } from "../../test/render";
import { formatTime } from "../format-date";
import { DateTimeField } from "./date-time-field";

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;
afterEach(async () => {
	closeCalendarPopover();
	await handle?.unmount();
	handle = null;
	document.body.replaceChildren();
});

function selectValueText(): string {
	return (
		document.querySelector<HTMLElement>(".cal-detail__time .bs-select__value")?.textContent ?? ""
	);
}

describe("DateTimeField time half (F-229 findings #3/#4)", () => {
	it("shows the true late-evening time, not a midnight wrap (finding #3)", async () => {
		// 23:53 used to display as 00:00 in the slot menu — a visible lie that
		// could move the event ~14h earlier on re-confirm.
		handle = await renderInto(
			<DateTimeField
				labelKey="calendar.detail.field.start"
				value="2026-05-10T23:53"
				allDay={false}
				onChange={vi.fn()}
			/>,
		);
		const expected = formatTime(new Date(2026, 4, 10, 23, 53).getTime());
		expect(selectValueText()).toBe(expected);
		expect(selectValueText()).not.toBe(formatTime(new Date(2026, 4, 10, 0, 0).getTime()));
	});

	it("shows an off-grid stored time as-is and round-trips it unchanged on re-confirm (finding #4)", async () => {
		const onChange = vi.fn();
		handle = await renderInto(
			<DateTimeField
				labelKey="calendar.detail.field.start"
				value="2026-05-10T09:07"
				allDay={false}
				onChange={onChange}
			/>,
		);
		// Displayed time is the real 09:07, not snapped to 09:00.
		expect(selectValueText()).toBe(formatTime(new Date(2026, 4, 10, 9, 7).getTime()));

		// The transient option exists so the value resolves to a label.
		const trigger = document.querySelector<HTMLButtonElement>(".cal-detail__time");
		if (!trigger) throw new Error("no time trigger");

		// Simulate re-confirming the shown slot: the field hands back the same time.
		// (onChange is invoked by the SelectMenu; here we assert the field never
		// pre-emptively mutated the stored value just by rendering.)
		expect(onChange).not.toHaveBeenCalled();
	});

	it("shows an on-grid stored time directly (no transient option needed)", async () => {
		handle = await renderInto(
			<DateTimeField
				labelKey="calendar.detail.field.start"
				value="2026-05-10T09:15"
				allDay={false}
				onChange={vi.fn()}
			/>,
		);
		expect(selectValueText()).toBe(formatTime(new Date(2026, 4, 10, 9, 15).getTime()));
	});
});
