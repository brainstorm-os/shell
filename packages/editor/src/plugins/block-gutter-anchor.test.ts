// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { gutterAnchor, gutterOwnsPointer } from "./block-gutter-anchor";

const main = { top: 100, bottom: 700, left: 0 };

describe("gutterAnchor", () => {
	it("anchors at the block's top, inset by the gutter offset, when in view", () => {
		expect(gutterAnchor({ top: 300, bottom: 340, left: 220 }, main, 68)).toEqual({
			top: 300,
			left: 152,
		});
	});

	it("clamps to the container top when the block is partially scrolled above it", () => {
		// Block straddles the top edge (top above the container, bottom below).
		expect(gutterAnchor({ top: 60, bottom: 130, left: 220 }, main, 68)).toEqual({
			top: 100, // clamped to mainRect.top, not the off-screen 60
			left: 152,
		});
	});

	it("hides (null) when the block has scrolled fully above the container", () => {
		expect(gutterAnchor({ top: 10, bottom: 90, left: 220 }, main, 68)).toBeNull();
	});

	it("hides (null) when the block has scrolled fully below the container", () => {
		expect(gutterAnchor({ top: 720, bottom: 760, left: 220 }, main, 68)).toBeNull();
	});

	it("keeps showing while any part of the block is still in the band", () => {
		// Bottom edge exactly at the container top → still touching.
		expect(gutterAnchor({ top: 40, bottom: 100, left: 220 }, main, 68)).not.toBeNull();
		// Top edge exactly at the container bottom → still touching.
		expect(gutterAnchor({ top: 700, bottom: 760, left: 220 }, main, 68)).not.toBeNull();
	});
});

describe("gutterOwnsPointer (nested editors, B11.22)", () => {
	function editorEl(top: number, bottom: number, editable: boolean): HTMLElement {
		const el = document.createElement("div");
		el.setAttribute("data-lexical-editor", "true");
		el.setAttribute("contenteditable", editable ? "true" : "false");
		el.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
		return el;
	}

	function tree(nestedEditable: boolean) {
		const host = editorEl(0, 1000, true);
		const card = document.createElement("div");
		const nested = editorEl(300, 500, nestedEditable);
		card.append(nested);
		host.append(card);
		return { host, nested };
	}

	it("the host yields inside an editing nested body, keeps the rest of the page", () => {
		const { host } = tree(true);
		expect(gutterOwnsPointer(host, 400)).toBe(false);
		expect(gutterOwnsPointer(host, 100)).toBe(true);
	});

	it("the host keeps a read-only nested body (the transclusion acts as one block)", () => {
		const { host } = tree(false);
		expect(gutterOwnsPointer(host, 400)).toBe(true);
	});

	it("a nested editor answers only inside its own band", () => {
		const { nested } = tree(true);
		expect(gutterOwnsPointer(nested, 400)).toBe(true);
		expect(gutterOwnsPointer(nested, 100)).toBe(false);
	});
});
