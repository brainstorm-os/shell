// @vitest-environment jsdom
import { closeCalendarPopover } from "@brainstorm/sdk/calendar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, renderInto } from "../../test/render";
import { BulkReschedule } from "./bulk-reschedule";

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;
afterEach(async () => {
	closeCalendarPopover();
	await handle?.unmount();
	handle = null;
	document.body.replaceChildren();
});

describe("BulkReschedule (F-229 — themed date picker, no native input)", () => {
	it("uses the shared calendar trigger, not a native date input", async () => {
		const defaultDay = new Date(2026, 4, 10, 0, 0).getTime();
		handle = await renderInto(
			<BulkReschedule count={2} defaultDayStart={defaultDay} onMove={vi.fn()} onClose={vi.fn()} />,
		);
		expect(document.querySelector('.cal-bulk input[type="date"]')).toBeNull();
		const trigger = document.querySelector<HTMLElement>(".cal-detail__date-trigger");
		if (!trigger) throw new Error("no date trigger");
		expect(trigger.querySelector<HTMLElement>(".cal-detail__date-text")?.dataset.empty).toBe("false");
	});

	it("DND-6 — a `title` override names the single item (the Move-to-date twin)", async () => {
		const defaultDay = new Date(2026, 4, 10, 0, 0).getTime();
		handle = await renderInto(
			<BulkReschedule
				count={1}
				title={'Move "Standup"'}
				defaultDayStart={defaultDay}
				onMove={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(document.body.textContent).toContain('Move "Standup"');
	});

	it("pre-fills the default day and emits the day chosen in the popover on Move", async () => {
		const onMove = vi.fn();
		const defaultDay = new Date(2026, 4, 10, 0, 0).getTime();
		handle = await renderInto(
			<BulkReschedule count={2} defaultDayStart={defaultDay} onMove={onMove} onClose={vi.fn()} />,
		);
		document.querySelector<HTMLButtonElement>(".cal-detail__date-trigger")?.click();
		await flush();
		const target = new Date(2026, 5, 1, 0, 0, 0, 0).getTime();
		const cell = document.querySelector<HTMLElement>(
			`.bs-cal-popover [data-date-epoch-ms="${target}"] .bs-cal-month__date`,
		);
		if (!cell) throw new Error("expected the 2026-06-01 day cell in the popover");
		cell.click();
		await flush();
		document.querySelector<HTMLButtonElement>("[data-bs-primary]")?.click();
		expect(onMove).toHaveBeenCalledTimes(1);
		expect(onMove.mock.calls[0]?.[0]).toBe(target);
	});
});
