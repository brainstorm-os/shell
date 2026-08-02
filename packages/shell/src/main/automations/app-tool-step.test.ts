/**
 * Tool-9 — an app tool called from an automation step.
 *
 * The rung's constraint is that `StepKind` stays CLOSED ("an open extension
 * surface would make workflow audits intractable"), so an app tool rides the
 * existing `AgentTool` path and is told apart by the SHAPE OF ITS ID.
 */

import { describe, expect, it, vi } from "vitest";
import { createCoreInterpreters } from "./step-interpreters";

function ports(over: Record<string, unknown> = {}) {
	return {
		intents: { dispatch: vi.fn(async () => "intent-result") },
		entities: {} as never,
		notify: {} as never,
		sleep: async () => undefined,
		loadWorkflowSteps: async () => [],
		capabilities: [],
		...over,
	} as never;
}

describe("automation tool dispatch (Tool-9)", () => {
	it("does not add a StepKind for app tools", () => {
		// The registry's key set is the audit surface; app tools must not widen it.
		const before = Object.keys(createCoreInterpreters(ports()));
		const after = Object.keys(createCoreInterpreters(ports({ appTools: { call: vi.fn() } })));
		expect(after).toEqual(before);
	});
});
