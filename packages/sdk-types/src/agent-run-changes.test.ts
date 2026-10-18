import { describe, expect, it } from "vitest";
import {
	AGENT_CHANGE_PREVIEW_MAX,
	describeFieldChange,
	lineDelta,
	summarizeChangeValue,
} from "./agent-run-changes";

describe("agent run changes (Agent-15)", () => {
	it("previews values bounded, control-stripped, and null when empty", () => {
		expect(summarizeChangeValue(undefined)).toBeNull();
		expect(summarizeChangeValue("  ")).toBeNull();
		expect(summarizeChangeValue([])).toBeNull();
		expect(summarizeChangeValue(3)).toBe("3");
		expect(summarizeChangeValue(["a", 2])).toBe("a, 2");
		expect(summarizeChangeValue([{ x: 1 }])).toBe("[1]");
		expect(summarizeChangeValue("a‮b\u0000c")).toBe("a b c");
		const long = summarizeChangeValue("x".repeat(1000)) ?? "";
		expect(long.length).toBe(AGENT_CHANGE_PREVIEW_MAX);
		expect(long.endsWith("…")).toBe(true);
	});

	it("counts added / removed lines as a multiset difference", () => {
		expect(lineDelta("a\nb\nc", "a\nc\nd\ne")).toEqual({ added: 2, removed: 1 });
		expect(lineDelta("", "")).toEqual({ added: 0, removed: 0 });
	});

	it("attaches a line summary only to multi-line text", () => {
		expect(describeFieldChange("t", "a", "b").lines).toBeUndefined();
		expect(describeFieldChange("body", null, "a\nb").lines).toEqual({ added: 2, removed: 0 });
	});
});
