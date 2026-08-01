// @vitest-environment jsdom
/**
 * Agent-12d — Settings → AI → Agent activity. Under test:
 *   - the denials-only toggle is FIRST-CLASS: pressing it re-queries with
 *     `denialsOnly: true` (a real server-side predicate, not a client filter);
 *   - a run row expands to its events, and a denial names the missing
 *     capability;
 *   - a hostile tool string that originated in model output / an MCP server
 *     renders as TEXT, never as markup;
 *   - click-through dispatches the privileged `open` intent;
 *   - the empty vault shows the shared <EmptyState> (discoverability).
 */

import {
	AgentEventKind,
	AgentEventOutcome,
	AgentRunOutcome,
	AgentRunSurface,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityEventView, AgentActivityRunView } from "../../preload";
import { AgentActivitySection } from "./agent-activity-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The filter dropdowns are the shared SelectMenu (fancy-menus). Render a
// minimal stand-in so this suite doesn't depend on the menu runtime.
vi.mock("@brainstorm-os/sdk/select-menu", () => ({
	SelectMenu: ({ ariaLabel, value }: { ariaLabel: string; value: string }) => (
		<button type="button" className="bs-select" aria-label={ariaLabel}>
			{value}
		</button>
	),
}));

const NOW = Date.parse("2026-08-01T10:00:00.000Z");
const HOSTILE_TOOL = '<img src=x onerror="window.__pwned_12d=1">';

function run(over: Partial<AgentActivityRunView> = {}): AgentActivityRunView {
	return {
		id: "run_1",
		surface: AgentRunSurface.Chat,
		conversationId: "conv-1",
		workflowRunId: null,
		agent: "io.brainstorm.agent",
		startedAt: NOW - 60_000,
		endedAt: NOW - 55_000,
		outcome: AgentRunOutcome.Ok,
		denialCount: 0,
		...over,
	};
}

function event(over: Partial<AgentActivityEventView> = {}): AgentActivityEventView {
	return {
		runId: "run_1",
		seq: 1,
		ts: NOW - 59_000,
		kind: AgentEventKind.ToolCall,
		tool: "open",
		targetEntityId: null,
		capability: null,
		outcome: AgentEventOutcome.Ok,
		detail: null,
		durationMs: 8,
		...over,
	};
}

type Stub = {
	queries: unknown[];
	eventsCalls: string[];
	entityHistoryCalls: string[];
	dispatched: unknown[];
};

function installBridge(
	runs: readonly AgentActivityRunView[],
	events: readonly AgentActivityEventView[] = [],
): Stub {
	const stub: Stub = { queries: [], eventsCalls: [], entityHistoryCalls: [], dispatched: [] };
	(window as { brainstorm?: unknown }).brainstorm = {
		agentActivity: {
			runs: (query: unknown) => {
				stub.queries.push(query);
				return Promise.resolve({ runs });
			},
			events: (runId: string) => {
				stub.eventsCalls.push(runId);
				return Promise.resolve({ events });
			},
			entityHistory: (entityId: string) => {
				stub.entityHistoryCalls.push(entityId);
				return Promise.resolve({ events });
			},
			agents: () => Promise.resolve({ agents: ["io.brainstorm.agent"] }),
		},
		intents: {
			dispatch: (envelope: unknown) => {
				stub.dispatched.push(envelope);
				return Promise.resolve({ handled: true, handler: { appId: "x" } });
			},
		},
	};
	return stub;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(): Promise<HTMLDivElement> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(<AgentActivitySection />);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return host;
}

afterEach(async () => {
	if (root) {
		const r = root;
		await act(async () => r.unmount());
	}
	host?.remove();
	root = null;
	host = null;
	(window as { brainstorm?: unknown }).brainstorm = undefined;
});

async function click(el: Element | null): Promise<void> {
	expect(el).not.toBeNull();
	await act(async () => {
		(el as HTMLButtonElement).click();
	});
	await act(async () => {
		await Promise.resolve();
	});
}

describe("AgentActivitySection (12d)", () => {
	it("renders the section with resolved strings, filters, and the run list", async () => {
		installBridge([run(), run({ id: "run_2", surface: AgentRunSurface.Automation })]);
		const el = await mount();
		expect(el.textContent).toContain("Agent activity");
		expect(el.textContent).not.toContain("shell.settings.ai.activity");
		expect(el.querySelectorAll(".settings__activity-run")).toHaveLength(2);
		// All four filter dimensions + the first-class toggle are present.
		expect(el.querySelector('[data-testid="ai-activity-denials-only"]')).not.toBeNull();
		expect(el.querySelectorAll(".bs-select").length).toBe(4);
	});

	it("the denials-only toggle re-queries with a server-side denialsOnly predicate", async () => {
		const stub = installBridge([run({ denialCount: 2, outcome: AgentRunOutcome.Refused })]);
		const el = await mount();
		const toggle = el.querySelector('[data-testid="ai-activity-denials-only"]');
		expect(toggle?.getAttribute("aria-pressed")).toBe("false");
		await click(toggle);
		expect(toggle?.getAttribute("aria-pressed")).toBe("true");
		const last = stub.queries.at(-1) as { denialsOnly?: boolean };
		expect(last.denialsOnly).toBe(true);
	});

	it("expanding a run fetches its events and a denial names the missing capability", async () => {
		const stub = installBridge(
			[run({ denialCount: 1, outcome: AgentRunOutcome.Error })],
			[
				event(),
				event({
					seq: 2,
					kind: AgentEventKind.ToolDenied,
					tool: "create_note",
					capability: "entities.write:io.example/Note/v1",
					outcome: AgentEventOutcome.Denied,
				}),
			],
		);
		const el = await mount();
		await click(el.querySelector(".settings__activity-run-head"));
		expect(stub.eventsCalls).toEqual(["run_1"]);
		expect(el.textContent).toContain("entities.write:io.example/Note/v1");
		expect(el.textContent).toContain("create_note");
	});

	it("a hostile tool string renders as text, never markup", async () => {
		installBridge([run()], [event({ tool: HOSTILE_TOOL })]);
		const el = await mount();
		await click(el.querySelector(".settings__activity-run-head"));
		expect(el.querySelector("img")).toBeNull();
		expect(el.textContent).toContain(HOSTILE_TOOL);
		expect((window as { __pwned_12d?: number }).__pwned_12d).toBeUndefined();
	});

	it("click-through dispatches the privileged open intent for the conversation", async () => {
		const stub = installBridge([run({ conversationId: "conv-9" })]);
		const el = await mount();
		await click(el.querySelector(".settings__activity-run-head"));
		const buttons = [...el.querySelectorAll("button")];
		const open = buttons.find((b) => b.textContent?.includes("Open conversation"));
		await click(open ?? null);
		expect(stub.dispatched).toContainEqual({ verb: "open", payload: { entityId: "conv-9" } });
	});

	it("an event's entity chip switches to per-entity agent history (target_entity_id query)", async () => {
		const stub = installBridge([run()], [event({ targetEntityId: "ent-7" })]);
		const el = await mount();
		await click(el.querySelector(".settings__activity-run-head"));
		await click(el.querySelector(".settings__activity-entity"));
		expect(stub.entityHistoryCalls).toEqual(["ent-7"]);
		expect(el.querySelector('[data-testid="ai-activity-entity-history"]')).not.toBeNull();
	});

	it("an empty vault shows the shared EmptyState (discoverability path)", async () => {
		installBridge([]);
		const el = await mount();
		expect(el.querySelector(".bs-empty-state")).not.toBeNull();
		expect(el.textContent).toContain("No agent runs yet");
	});
});
