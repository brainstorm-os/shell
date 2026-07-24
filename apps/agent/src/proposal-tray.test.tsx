// @vitest-environment jsdom
/**
 * Agent-11b — the preview-confirm tray interaction contract: a staged draft
 * renders an editable card; Add persists (fires onApprove with the live
 * artifact), Discard drops it, editing a field fires onEditField, and Add is
 * disabled once the required primary field is cleared (never a blank write).
 */

import { GENERIC_OBJECT_TYPE, ValueType } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposeKind, type ProposedArtifact, buildProposal } from "./logic/propose-artifacts";
import { PROPOSE_DATABASE_VERB, buildDatabaseProposal, rowCellKey } from "./logic/propose-database";
import { PROPOSE_ROW_VERB, buildRowProposal } from "./logic/propose-row";
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

describe("ProposalTray — database rows (Agent-11d)", () => {
	const rowSchema = {
		id: "list_crm",
		name: "Pipeline",
		entityType: GENERIC_OBJECT_TYPE,
		addToMembers: true,
		columns: [
			{ key: "name", label: "Name", valueType: ValueType.Text },
			{ key: "amount", label: "Amount", valueType: ValueType.Number },
		],
	};
	const stageRow = (values: Record<string, string>): ProposedArtifact => {
		const r = buildRowProposal({
			verb: PROPOSE_ROW_VERB,
			args: { database: "Pipeline", values },
			id: "r1",
			schemas: [rowSchema],
		});
		if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
		return r.artifact;
	};

	it("renders one editable cell per column of the target database", async () => {
		handle = await renderInto(
			<ProposalTray
				proposals={[stageRow({ name: "Globex", amount: "5400" })]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={noop}
			/>,
		);
		const card = handle.container.querySelector("[data-testid='agent-proposal']");
		expect(card?.getAttribute("data-kind")).toBe(ProposeKind.Row);
		const inputs = handle.container.querySelectorAll<HTMLInputElement>(".agent-proposal__input");
		expect(inputs).toHaveLength(2);
		expect(inputs[0]?.value).toBe("Globex");
		expect(inputs[1]?.value).toBe("5400");
		expect(handle.container.querySelectorAll(".agent-proposal__field-label")[1]?.textContent).toBe(
			"Amount",
		);
	});

	it("names the target database on the card", async () => {
		handle = await renderInto(
			<ProposalTray
				proposals={[stageRow({ name: "Globex" })]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={noop}
			/>,
		);
		expect(
			handle.container.querySelector("[data-testid='agent-proposal-database']")?.textContent,
		).toContain("Pipeline");
	});

	it("edits a cell through onEditField, keyed by the column's property key", async () => {
		const onEditField = vi.fn();
		handle = await renderInto(
			<ProposalTray
				proposals={[stageRow({ name: "Globex", amount: "5400" })]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={onEditField}
			/>,
		);
		const amount = handle.container.querySelectorAll<HTMLInputElement>(".agent-proposal__input")[1];
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(amount, "6000");
			amount?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(onEditField).toHaveBeenCalledWith("r1", "amount", "6000");
	});

	it("disables Add once the row's title cell is cleared (never a blank row)", async () => {
		const artifact = stageRow({ name: "Globex" });
		handle = await renderInto(
			<ProposalTray
				proposals={[{ ...artifact, fields: { ...artifact.fields, name: "  " } }]}
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
});

describe("ProposalTray — a proposed new database (Agent-11e)", () => {
	const stageDb = (args: Record<string, unknown>): ProposedArtifact => {
		const r = buildDatabaseProposal({
			verb: PROPOSE_DATABASE_VERB,
			args,
			id: "d1",
			existing: [],
		});
		if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
		return r.artifact;
	};
	const READING_LIST = {
		name: "Reading list",
		columns: [{ name: "Author" }, { name: "Pages", type: "number" }],
		rows: [{ Name: "Dune", Author: "Herbert", Pages: "412" }],
	};

	it("shows the inferred schema and an editable name", async () => {
		handle = await renderInto(
			<ProposalTray
				proposals={[stageDb(READING_LIST)]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={noop}
			/>,
		);
		const card = handle.container.querySelector("[data-testid='agent-proposal']");
		expect(card?.getAttribute("data-kind")).toBe(ProposeKind.Database);
		const schema = handle.container.querySelector("[data-testid='agent-proposal-schema']");
		expect(schema?.textContent).toContain("Author");
		expect(schema?.textContent).toContain("Pages");
		const nameInput = handle.container.querySelector<HTMLInputElement>(".agent-proposal__input");
		expect(nameInput?.value).toBe("Reading list");
	});

	it("renders the seed rows as a grid of editable cells", async () => {
		handle = await renderInto(
			<ProposalTray
				proposals={[stageDb(READING_LIST)]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={noop}
			/>,
		);
		const grid = handle.container.querySelector("[data-testid='agent-proposal-seed-rows']");
		expect(grid).not.toBeNull();
		const heads = grid?.querySelectorAll(".agent-proposal__seed-head");
		expect([...(heads ?? [])].map((h) => h.textContent)).toEqual(["Name", "Author", "Pages"]);
		const cells = grid?.querySelectorAll<HTMLInputElement>("input");
		expect([...(cells ?? [])].map((c) => c.value)).toEqual(["Dune", "Herbert", "412"]);
	});

	it("edits a seed cell under its rowCellKey (what the persist step reads back)", async () => {
		const onEditField = vi.fn();
		handle = await renderInto(
			<ProposalTray
				proposals={[stageDb(READING_LIST)]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={onEditField}
			/>,
		);
		const grid = handle.container.querySelector("[data-testid='agent-proposal-seed-rows']");
		const pages = grid?.querySelectorAll<HTMLInputElement>("input")[2];
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(pages, "500");
			pages?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(onEditField).toHaveBeenCalledWith("d1", rowCellKey(0, "pages"), "500");
	});

	it("renders no seed grid for a database proposed without rows", async () => {
		handle = await renderInto(
			<ProposalTray
				proposals={[stageDb({ name: "Empty", columns: ["Stage"] })]}
				busyIds={new Set()}
				onApprove={noop}
				onDiscard={noop}
				onEditField={noop}
			/>,
		);
		expect(handle.container.querySelector("[data-testid='agent-proposal-seed-rows']")).toBeNull();
	});
});
