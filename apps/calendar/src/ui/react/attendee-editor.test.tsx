// @vitest-environment jsdom
import {
	BrainstormMenuProvider,
	CONTEXT_MENU_ID,
	type ContextMenuItem,
	closeContextMenu,
	getActiveMenuStore,
} from "@brainstorm-os/sdk/menus";
import { type ReactElement, act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTENDEE_RSVPS } from "../../logic/attendees";
import { flush, renderInto } from "../../test/render";
import { type Attendee, AttendeeRsvp } from "../../types/attendee";
import { AttendeeEditor } from "./attendee-editor";

/** Stateful host so the controlled editor reflects edits + exposes the value. */
function Host({
	initial,
	onValue,
}: { initial: Attendee[]; onValue: (v: Attendee[]) => void }): ReactElement {
	const [value, setValue] = useState<Attendee[]>(initial);
	return (
		<AttendeeEditor
			value={value}
			onChange={(v) => {
				setValue(v);
				onValue(v);
			}}
		/>
	);
}

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;
afterEach(async () => {
	await act(async () => closeContextMenu());
	await handle?.unmount();
	handle = null;
});

function setInput(el: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AttendeeEditor", () => {
	it("starts empty", async () => {
		handle = await renderInto(<Host initial={[]} onValue={vi.fn()} />);
		expect(handle.container.querySelector(".cal-attendees__empty")).not.toBeNull();
	});

	it("adds an attendee via the add row", async () => {
		const onValue = vi.fn();
		handle = await renderInto(<Host initial={[]} onValue={onValue} />);
		const [nameInput, emailInput] = handle.container.querySelectorAll<HTMLInputElement>(
			".cal-attendees__add input",
		);
		if (!nameInput || !emailInput) throw new Error("no add inputs");
		setInput(nameInput, "Mira");
		setInput(emailInput, "mira@x.io");
		await flush();
		handle.container.querySelector<HTMLButtonElement>(".cal-attendees__add button")?.click();
		await flush();
		expect(onValue).toHaveBeenLastCalledWith([
			{ name: "Mira", email: "mira@x.io", rsvp: AttendeeRsvp.NeedsAction },
		]);
	});

	it("picking an RSVP from the select menu updates that attendee", async () => {
		const onValue = vi.fn();
		handle = await renderInto(
			<BrainstormMenuProvider>
				<Host
					initial={[{ name: "Mira", email: null, rsvp: AttendeeRsvp.NeedsAction }]}
					onValue={onValue}
				/>
			</BrainstormMenuProvider>,
		);
		const trigger = handle.container.querySelector<HTMLButtonElement>(".cal-attendees__rsvp");
		if (!trigger) throw new Error("no rsvp trigger");
		expect(trigger.classList.contains("bs-select")).toBe(true);
		await act(async () => trigger.click());
		const label = trigger.getAttribute("aria-label") ?? "";
		const open = getActiveMenuStore()
			?.getAll()
			.find((m) => m.id === `${CONTEXT_MENU_ID}:${label}`);
		expect(open, "rsvp menu should be open").toBeDefined();
		const items = (open?.param.data as { items: ContextMenuItem[] }).items;
		const accepted = ATTENDEE_RSVPS.indexOf(AttendeeRsvp.Accepted);
		await act(async () => items[accepted]?.onSelect?.());
		await flush();
		expect(onValue.mock.calls.at(-1)?.[0][0].rsvp).toBe(AttendeeRsvp.Accepted);
	});

	it("removing an attendee drops it from the value", async () => {
		const onValue = vi.fn();
		handle = await renderInto(
			<Host
				initial={[
					{ name: "Mira", email: null, rsvp: AttendeeRsvp.Accepted },
					{ name: "Jules", email: null, rsvp: AttendeeRsvp.Tentative },
				]}
				onValue={onValue}
			/>,
		);
		handle.container.querySelector<HTMLButtonElement>(".cal-attendees__remove")?.click();
		await flush();
		expect(onValue.mock.calls.at(-1)?.[0].map((a: Attendee) => a.name)).toEqual(["Jules"]);
	});

	it("does not add a duplicate (same email)", async () => {
		const onValue = vi.fn();
		handle = await renderInto(
			<Host
				initial={[{ name: "Mira", email: "m@x.io", rsvp: AttendeeRsvp.Accepted }]}
				onValue={onValue}
			/>,
		);
		const [nameInput, emailInput] = handle.container.querySelectorAll<HTMLInputElement>(
			".cal-attendees__add input",
		);
		if (!nameInput || !emailInput) throw new Error("no add inputs");
		setInput(nameInput, "Mira Dup");
		setInput(emailInput, "m@x.io");
		await flush();
		handle.container.querySelector<HTMLButtonElement>(".cal-attendees__add button")?.click();
		await flush();
		// No new attendee emitted (the add was a no-op duplicate).
		expect(handle.container.querySelectorAll(".cal-attendees__item")).toHaveLength(1);
	});
});
