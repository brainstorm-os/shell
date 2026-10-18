// @vitest-environment jsdom
import {
	type AgentRunChanges,
	AgentRunSurface,
	type AgentTraceService,
	AgentWriteKind,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunChangesPanel } from "./run-changes-panel";

const changed: AgentRunChanges = {
	runId: "run_a",
	changes: [
		{
			entityId: "ent_1",
			entityType: "brainstorm/Task/v1",
			kind: AgentWriteKind.Created,
			title: "Call Globex",
			fields: [],
			moreFields: 0,
			oversize: false,
			at: 1,
		},
	],
	moreChanges: 0,
	revertedAt: null,
};

function trace(): AgentTraceService & { undoRun: ReturnType<typeof vi.fn> } {
	const run = (id: string) => ({
		id,
		surface: AgentRunSurface.Chat,
		conversationId: "conv",
		workflowRunId: null,
		agent: "io.brainstorm.agent",
		startedAt: 1,
		endedAt: 2,
		outcome: null,
		denialCount: 0,
	});
	return {
		beginTurn: vi.fn(),
		endTurn: vi.fn(),
		listEvents: vi.fn(),
		listRuns: vi.fn(async () => ({ runs: [run("run_a"), run("run_b")] })),
		listChanges: vi.fn(async ({ runId }: { runId: string }) =>
			runId === "run_a" ? changed : { ...changed, runId, changes: [] },
		),
		undoRun: vi.fn(async () => ({ ok: true as const, reverted: 1 })),
	} as unknown as AgentTraceService & { undoRun: ReturnType<typeof vi.fn> };
}

describe("RunChangesPanel (Agent-15)", () => {
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

	it("shows only runs that changed something and undoes the chosen run", async () => {
		const svc = trace();
		const open = vi.fn();
		await act(async () => {
			root.render(
				<RunChangesPanel trace={svc} conversationId="conv" refreshKey="" onOpenEntity={open} />,
			);
		});
		expect(host.querySelectorAll(".bs-run-changes")).toHaveLength(1);
		expect(host.textContent).toContain("Call Globex");
		const titleButton = [...host.querySelectorAll("button")].find(
			(b) => b.textContent === "Call Globex",
		);
		act(() => titleButton?.click());
		expect(open).toHaveBeenCalledWith("ent_1");
		const undo = [...host.querySelectorAll("button")].find((b) => b.textContent === "Undo this run");
		await act(async () => undo?.click());
		expect(svc.undoRun).toHaveBeenCalledWith({ runId: "run_a" });
	});

	it("renders nothing on a shell without the Agent-15 methods", async () => {
		const svc = { ...trace(), listChanges: undefined } as unknown as AgentTraceService;
		await act(async () => {
			root.render(
				<RunChangesPanel trace={svc} conversationId="conv" refreshKey="" onOpenEntity={vi.fn()} />,
			);
		});
		expect(host.innerHTML).toBe("");
	});
});
