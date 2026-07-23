// @vitest-environment jsdom
/**
 * Agent-11b — the preview-confirm tray interaction contract: a staged draft
 * renders an editable card; Add persists (fires onApprove with the live
 * artifact), Discard drops it, editing a field fires onEditField, and Add is
 * disabled once the required primary field is cleared (never a blank write).
 */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposeKind, type ProposedArtifact, buildProposal } from "./logic/propose-artifacts";
import { ProposalTray } from "./proposal-tray";
import { type RenderHandle, renderInto } from "./test/render";

function stage(verb: string, args: Record<string, unknown>, id: string): ProposedArtifact {
	const r = buildProposal({ verb, args, id });
	if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
	return r.artifact;
}

let handle: RenderHandle | null = null;
afterEach(async () => {
	await handle?.unmount();
	handle = null;
});

const noop = () => {};

describe("ProposalTray", () => {
	it("renders nothing when there are no proposals", async () => {
		handle = await renderInto(
			<ProposalTray
				proposals={[]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={noop}
			/>,
		);
		expect(handle.container.querySelector(".agent-proposal-tray")).toBeNull();
	});

	it("renders a card per staged proposal with the kind on the element", async () => {
		const note = stage("propose-note", { title: "Weekly review", body: "x" }, "a");
		const task = stage("propose-task", { title: "Ship it" }, "b");
		handle = await renderInto(
			<ProposalTray
				proposals={[note, task]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={noop}
			/>,
		);
		const cards = handle.container.querySelectorAll("[data-testid='agent-proposal']");
		expect(cards).toHaveLength(2);
		expect(cards[0]?.getAttribute("data-kind")).toBe(ProposeKind.Note);
		expect(cards[1]?.getAttribute("data-kind")).toBe(ProposeKind.Task);
	});

	it("Add fires onApprove with the live artifact; Discard fires onDiscard", async () => {
		const note = stage("propose-note", { title: "Weekly review" }, "a");
		const onApprove = vi.fn();
		const onDiscard = vi.fn();
		handle = await renderInto(
			<ProposalTray
				proposals={[note]}
				busyIds={new Set()}
				onApprove={onApprove}
				onDiscard={onDiscard}
				onEditField={noop}
			/>,
		);
		const approve = handle.container.querySelector<HTMLButtonElement>(
			"[data-testid='agent-proposal-approve']",
		);
		const discard = handle.container.querySelector<HTMLButtonElement>(
			"[data-testid='agent-proposal-discard']",
		);
		await act(async () => approve?.click());
		await act(async () => discard?.click());
		expect(onApprove).toHaveBeenCalledWith(note);
		expect(onDiscard).toHaveBeenCalledWith("a");
	});

	it("editing a field fires onEditField(id, field, value)", async () => {
		const note = stage("propose-note", { title: "Draft" }, "a");
		const onEditField = vi.fn();
		handle = await renderInto(
			<ProposalTray
				proposals={[note]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={onEditField}
			/>,
		);
		const titleInput = handle.container.querySelector<HTMLInputElement>("#a-title");
		expect(titleInput?.value).toBe("Draft");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(titleInput, "Draft renamed");
			titleInput?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(onEditField).toHaveBeenCalledWith("a", "title", "Draft renamed");
	});

	it("disables Add when the required primary field is cleared (no blank write)", async () => {
		// Edit the buffer to empty the title, then re-render (the app owns state).
		const note = stage("propose-note", { title: "Temp" }, "a");
		const empty: ProposedArtifact = { ...note, fields: { ...note.fields, title: "" }, summary: "" };
		handle = await renderInto(
			<ProposalTray
				proposals={[empty]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={noop}
			/>,
		);
		const approve = handle.container.querySelector<HTMLButtonElement>(
			"[data-testid='agent-proposal-approve']",
		);
		expect(approve?.disabled).toBe(true);
	});

	it("a busy card disables all its controls (approve in flight)", async () => {
		const note = stage("propose-note", { title: "Saving" }, "a");
		handle = await renderInto(
			<ProposalTray
				proposals={[note]}
				busyIds={new Set(["a"])}
				onApprove={noop}
				onDiscard={noop}
				onEditField={noop}
			/>,
		);
		const buttons = handle.container.querySelectorAll<HTMLButtonElement>(".agent-proposal__btn");
		for (const btn of buttons) expect(btn.disabled).toBe(true);
	});
});
