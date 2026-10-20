// @vitest-environment jsdom
import {
	type AgentRunChanges,
	AgentUndoRefusal,
	type AgentUndoResult,
	AgentWriteKind,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunChanges, type RunChangesLabels } from "./run-changes";

const labels: RunChangesLabels = {
	heading: "Changes",
	empty: "Nothing",
	untitled: "Untitled",
	oversize: "Too large",
	kind: {
		[AgentWriteKind.Created]: "Created",
		[AgentWriteKind.Updated]: "Edited",
		[AgentWriteKind.Trashed]: "Trashed",
	},
	field: (key, before, after) => `${key}: ${before ?? "-"} -> ${after ?? "-"}`,
	lines: (a, r) => `+${a}/-${r}`,
	more: (n) => `+${n} more`,
	undo: "Undo this run",
	undoing: "Undoing",
	undone: "Undone",
	refusal: (reason, field) => `refused:${reason}:${field ?? ""}`,
	failed: "Failed",
};

const changes: AgentRunChanges = {
	runId: "run_1",
	changes: [
		{
			entityId: "e1",
			entityType: "t",
			kind: AgentWriteKind.Updated,
			title: null,
			fields: [{ key: "body", before: "a", after: "b", lines: { added: 2, removed: 1 } }],
			moreFields: 3,
			oversize: false,
			at: 1,
		},
	],
	moreChanges: 0,
	revertedAt: null,
};

describe("<RunChanges>", () => {
	let host: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	const undoButton = () =>
		[...host.querySelectorAll("button")].find((b) => b.textContent === "Undo this run");

	it("renders each change with its field, line summary and overflow count", () => {
		act(() => root.render(<RunChanges changes={changes} labels={labels} />));
		expect(host.textContent).toContain("Edited");
		expect(host.textContent).toContain("Untitled");
		expect(host.textContent).toContain("body: a -> b");
		expect(host.textContent).toContain("+2/-1");
		expect(host.textContent).toContain("+3 more");
		// Read-only without an onUndo.
		expect(undoButton()).toBeUndefined();
	});

	it("hides host bookkeeping and empty bags, and reads date stamps for people", () => {
		const stamp = 1792445200119;
		const created: AgentRunChanges = {
			...changes,
			changes: [
				{
					entityId: "e2",
					entityType: "t",
					kind: AgentWriteKind.Created,
					title: "Signage checklist",
					fields: [
						{ key: "title", before: null, after: "Signage checklist" },
						{ key: "values", before: null, after: "{}" },
						{ key: "createdAt", before: null, after: String(stamp) },
						{ key: "updatedAt", before: null, after: String(stamp) },
						{ key: "dueAt", before: null, after: String(stamp) },
					],
					moreFields: 0,
					oversize: false,
					at: 1,
				},
			],
		};
		act(() =>
			root.render(
				<RunChanges changes={created} labels={labels} format={{ locale: "en-GB", timeZone: "UTC" }} />,
			),
		);
		const text = host.textContent ?? "";
		expect(text).toContain("title: - -> Signage checklist");
		expect(text).not.toContain("values");
		expect(text).not.toContain("createdAt");
		expect(text).not.toContain("updatedAt");
		expect(text).not.toContain(String(stamp));
		expect(text).toMatch(/dueAt: - -> .*2026/);
	});

	it("names the refusal in a status line and keeps the button usable", async () => {
		const onUndo = vi.fn(
			async (): Promise<AgentUndoResult> => ({
				ok: false,
				reason: AgentUndoRefusal.EditedSince,
				entityId: "e1",
				field: "body",
			}),
		);
		act(() => root.render(<RunChanges changes={changes} labels={labels} onUndo={onUndo} />));
		await act(async () => undoButton()?.click());
		expect(onUndo).toHaveBeenCalledTimes(1);
		expect(host.querySelector('[role="status"]')?.textContent).toBe("refused:edited-since:body");
	});

	it("reports success and lets the host refetch; an undone run is disabled", async () => {
		const onUndone = vi.fn();
		act(() =>
			root.render(
				<RunChanges
					changes={changes}
					labels={labels}
					onUndo={async () => ({ ok: true, reverted: 1 })}
					onUndone={onUndone}
				/>,
			),
		);
		await act(async () => undoButton()?.click());
		expect(onUndone).toHaveBeenCalled();
		act(() =>
			root.render(
				<RunChanges
					changes={{ ...changes, revertedAt: 5 }}
					labels={labels}
					onUndo={async () => ({ ok: true, reverted: 1 })}
				/>,
			),
		);
		const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Undone");
		expect(button?.disabled).toBe(true);
	});
});
