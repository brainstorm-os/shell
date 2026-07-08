/**
 * Pure tests for the shared legacy-string→body seeding helpers. The
 * data-loss-safety contract lives here: a legacy text field is only
 * cleared once, and only after it's been carried into the body.
 */

import { describe, expect, it } from "vitest";
import {
	hasLegacyText,
	plainTextToSerializedState,
	shouldClearLegacyText,
} from "./plain-text-state";

type Node = { type: string; children?: Node[]; text?: string };

function rootChildren(state: ReturnType<typeof plainTextToSerializedState>): Node[] {
	return (state.root as unknown as { children: Node[] }).children;
}

describe("plainTextToSerializedState", () => {
	it("yields an empty root for a blank / whitespace-only string", () => {
		expect(rootChildren(plainTextToSerializedState(""))).toEqual([]);
		expect(rootChildren(plainTextToSerializedState("   \n  "))).toEqual([]);
	});

	it("wraps a single line in one paragraph with one text node", () => {
		const children = rootChildren(plainTextToSerializedState("Met at the design summit"));
		expect(children).toHaveLength(1);
		expect(children[0]?.type).toBe("paragraph");
		expect(children[0]?.children?.[0]).toMatchObject({
			type: "text",
			text: "Met at the design summit",
		});
	});

	it("produces one paragraph per line, blank interior lines preserved", () => {
		const children = rootChildren(plainTextToSerializedState("a\n\nb"));
		expect(children).toHaveLength(3);
		expect(children[1]?.children).toEqual([]);
	});

	it("always shapes a valid Lexical root", () => {
		const state = plainTextToSerializedState("x");
		expect((state.root as unknown as { type: string }).type).toBe("root");
	});
});

describe("hasLegacyText", () => {
	it("is true only for a non-blank string", () => {
		expect(hasLegacyText("note")).toBe(true);
		expect(hasLegacyText("")).toBe(false);
		expect(hasLegacyText("   ")).toBe(false);
		expect(hasLegacyText(undefined)).toBe(false);
		expect(hasLegacyText(null)).toBe(false);
	});
});

describe("shouldClearLegacyText", () => {
	it("clears once when text exists and the entity hasn't been migrated", () => {
		expect(shouldClearLegacyText("note", false)).toBe(true);
	});

	it("never clears an already-migrated or empty field", () => {
		expect(shouldClearLegacyText("note", true)).toBe(false);
		expect(shouldClearLegacyText("", false)).toBe(false);
		expect(shouldClearLegacyText(null, false)).toBe(false);
	});
});
