// @vitest-environment jsdom
/**
 * Agent-12c — the run drill-in renders the trace (step → tool → outcome →
 * duration), and the headline claim: a capability-refused run names the
 * DENYING CAPABILITY instead of the bare `capability-denied:…` error string.
 * Denial posture is passive per OQ-AO-4 — a badge + denial state on the row,
 * never a toast.
 */

import {
	AgentEventKind,
	AgentEventOutcome,
	AgentRunOutcome,
	type AgentRunSummary,
	AgentRunSurface,
	type AgentTraceEventRecord,
	WORKFLOW_RUN_DENIED_ERROR_PREFIX,
	WorkflowRunStatus,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { RunView } from "../logic/run-view";
import { flush, renderInto } from "../test/render";
import { RunsView } from "./runs-view";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const MISSING_CAP = "entities.write:io.example/Note/v1";
const RUN_ENTITY_ID = "wfr_1";

function deniedRun(overrides: Partial<RunView> = {}): RunView {
	return {
		id: RUN_ENTITY_ID,
		workflowId: "wf1",
		workflowName: "Weekly digest",
		status: WorkflowRunStatus.Failed,
		triggeredAtMs: NOW - 60_000,
		triggeredBy: "manual:wf1",
		error: `${WORKFLOW_RUN_DENIED_ERROR_PREFIX}${MISSING_CAP}`,
		steps: [],
		...overrides,
	};
}

function traceRun(overrides: Partial<AgentRunSummary> = {}): AgentRunSummary {
	return {
		id: "run_1",
		surface: AgentRunSurface.Automation,
		conversationId: null,
		workflowRunId: RUN_ENTITY_ID,
		agent: "io.brainstorm.automations",
		startedAt: NOW - 60_000,
		endedAt: NOW - 59_000,
		outcome: AgentRunOutcome.Refused,
		denialCount: 1,
		...overrides,
	};
}

function traceEvent(overrides: Partial<AgentTraceEventRecord> = {}): AgentTraceEventRecord {
	return {
		runId: "run_1",
		seq: 1,
		ts: NOW - 59_500,
		kind: AgentEventKind.ToolCall,
		tool: "Notify:n1",
		targetEntityId: null,
		capability: null,
		outcome: AgentEventOutcome.Ok,
		detail: null,
		durationMs: 12,
		...overrides,
	};
}

async function expand(container: HTMLElement): Promise<void> {
	const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
	expect(toggle).not.toBeNull();
	await act(async () => {
		toggle?.click();
	});
	await flush();
}

describe("RunsView — Agent-12c denial rendering", () => {
	it("a capability-refused run names the denying capability, never the bare error string", async () => {
		const handle = await renderInto(<RunsView runs={[deniedRun()]} now={() => NOW} />);
		await expand(handle.container);
		const text = handle.container.textContent ?? "";
		expect(text).toContain(MISSING_CAP);
		expect(text).not.toContain(WORKFLOW_RUN_DENIED_ERROR_PREFIX);
		await handle.unmount();
	});

	it("shows a passive denial badge on the run row (no expand needed)", async () => {
		const handle = await renderInto(
			<RunsView
				runs={[deniedRun()]}
				now={() => NOW}
				traceByRunId={new Map([[RUN_ENTITY_ID, traceRun({ denialCount: 2 })]])}
			/>,
		);
		const badge = handle.container.querySelector('[data-testid="run-denial-badge"]');
		expect(badge).not.toBeNull();
		expect(badge?.textContent).toContain("2");
		await handle.unmount();
	});

	it("the drill-in renders the trace — tool, outcome, duration — with denials named", async () => {
		const events: AgentTraceEventRecord[] = [
			traceEvent({ seq: 1, tool: "Notify:n1", durationMs: 12 }),
			traceEvent({
				seq: 2,
				kind: AgentEventKind.ToolDenied,
				tool: "create_note",
				capability: MISSING_CAP,
				outcome: AgentEventOutcome.Denied,
				durationMs: 0,
			}),
		];
		const handle = await renderInto(
			<RunsView
				runs={[
					deniedRun({
						status: WorkflowRunStatus.Failed,
						steps: [{ stepId: "n1", kind: "Notify", status: "succeeded", depth: 0, durationMs: 12 }],
					}),
				]}
				now={() => NOW}
				traceByRunId={new Map([[RUN_ENTITY_ID, traceRun()]])}
				loadTraceEvents={async () => events}
			/>,
		);
		await expand(handle.container);
		await flush();
		const text = handle.container.textContent ?? "";
		expect(text).toContain("Notify:n1");
		expect(text).toContain("12");
		expect(text).toContain("create_note");
		expect(text).toContain(MISSING_CAP);
		await handle.unmount();
	});

	it("a hostile tool name renders as text, never as markup", async () => {
		const hostile = '<img src=x onerror="window.__pwned=1">';
		const handle = await renderInto(
			<RunsView
				runs={[deniedRun()]}
				now={() => NOW}
				traceByRunId={new Map([[RUN_ENTITY_ID, traceRun()]])}
				loadTraceEvents={async () => [traceEvent({ tool: hostile })]}
			/>,
		);
		await expand(handle.container);
		await flush();
		expect(handle.container.querySelector("img")).toBeNull();
		expect(handle.container.textContent).toContain(hostile);
		expect((window as { __pwned?: number }).__pwned).toBeUndefined();
		await handle.unmount();
	});
});
