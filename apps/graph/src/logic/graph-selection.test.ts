import { SelectionModifier } from "@brainstorm-os/sdk/selection";
import { describe, expect, it } from "vitest";
import { EMPTY_NODE_SELECTION, applyNodeSelection, clearNodeSelection } from "./graph-selection";

const order = ["a", "b", "c", "d"];

describe("applyNodeSelection", () => {
	it("plain click replaces the selection and sets the anchor", () => {
		const next = applyNodeSelection(
			{ selected: new Set(["a", "b"]), anchor: "a" },
			"c",
			SelectionModifier.None,
			order,
		);
		expect([...next.selected]).toEqual(["c"]);
		expect(next.anchor).toBe("c");
	});

	it("Mod-click toggles a node on, leaving the rest and moving the anchor", () => {
		const next = applyNodeSelection(EMPTY_NODE_SELECTION, "b", SelectionModifier.Toggle, order);
		expect([...next.selected]).toEqual(["b"]);
		expect(next.anchor).toBe("b");
		const off = applyNodeSelection(next, "b", SelectionModifier.Toggle, order);
		expect(off.selected.size).toBe(0);
		expect(off.anchor).toBe("b"); // toggle-off keeps the prior anchor
	});

	it("Shift-click extends an inclusive range from the anchor", () => {
		const next = applyNodeSelection(
			{ selected: new Set(["a"]), anchor: "a" },
			"c",
			SelectionModifier.Range,
			order,
		);
		expect([...next.selected].sort()).toEqual(["a", "b", "c"]);
		expect(next.anchor).toBe("a");
	});

	it("Shift-click with no anchor anchors on the target", () => {
		const next = applyNodeSelection(EMPTY_NODE_SELECTION, "c", SelectionModifier.Range, order);
		expect([...next.selected]).toEqual(["c"]);
		expect(next.anchor).toBe("c");
	});

	it("clearNodeSelection empties everything", () => {
		expect(clearNodeSelection().selected.size).toBe(0);
		expect(clearNodeSelection().anchor).toBeNull();
	});
});
