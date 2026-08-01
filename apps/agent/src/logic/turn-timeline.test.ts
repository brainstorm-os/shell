import { ToolRefusalReason } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	TurnTimelineKind,
	capabilityForVerb,
	timelineDenialCount,
	turnTimeline,
} from "./turn-timeline";

describe("turnTimeline", () => {
	it("maps result/error/refused, drops assistant + bare tool-call, and orders them", () => {
		const items = turnTimeline([
			{ kind: "assistant", content: '{"tool":"open","args":{"secret":"x"}}' },
			{ kind: "tool-call", call: { tool: "open", args: { secret: "x" } } },
			{ kind: "tool-result", tool: "search", output: { hits: 3 } },
			{ kind: "tool-error", tool: "open", error: "boom" },
			{ kind: "tool-refused", tool: "open", reason: ToolRefusalReason.CapabilityDenied },
			{ kind: "tool-refused", tool: "phantom", reason: ToolRefusalReason.UnknownTool },
		]);
		expect(items.map((i) => [i.kind, i.tool, i.capability])).toEqual([
			[TurnTimelineKind.ToolCall, "search", null],
			[TurnTimelineKind.ToolError, "open", null],
			[TurnTimelineKind.Denied, "open", "intents.dispatch:open"],
			[TurnTimelineKind.Denied, "phantom", null],
		]);
	});

	it("keys repeated verbs per occurrence", () => {
		const items = turnTimeline([
			{ kind: "tool-result", tool: "open", output: 1 },
			{ kind: "tool-result", tool: "open", output: 2 },
		]);
		expect(items.map((i) => i.key)).toEqual(["open#0", "open#1"]);
	});

	it("is tolerant of the untyped persisted shape", () => {
		expect(turnTimeline(undefined)).toEqual([]);
		expect(turnTimeline("nope")).toEqual([]);
		expect(turnTimeline([null, 42, { kind: 7 }, {}])).toEqual([]);
	});

	it("carries no argument or output bytes into any item", () => {
		const items = turnTimeline([
			{ kind: "tool-call", call: { tool: "open", args: { secret: "SEKRIT" } } },
			{ kind: "tool-result", tool: "open", output: { leaked: "SEKRIT" } },
		]);
		expect(JSON.stringify(items).includes("SEKRIT")).toBe(false);
	});

	it("timelineDenialCount counts only denials", () => {
		const items = turnTimeline([
			{ kind: "tool-result", tool: "open", output: 1 },
			{ kind: "tool-refused", tool: "open", reason: ToolRefusalReason.CapabilityDenied },
			{ kind: "tool-refused", tool: "x", reason: ToolRefusalReason.UnknownTool },
		]);
		expect(timelineDenialCount(items)).toBe(2);
	});

	it("capabilityForVerb mirrors intents.dispatch:<verb>", () => {
		expect(capabilityForVerb("open")).toBe("intents.dispatch:open");
	});
});
