import { describe, expect, it } from "vitest";
import {
	auditOffCanvasGuards,
	declarationBlocks,
	isOffCanvasTransform,
} from "./check-offcanvas-guard.mjs";

describe("declarationBlocks", () => {
	it("reports each rule with its 1-based line, counting comment lines", () => {
		const css = [
			"/* a",
			"   comment */",
			".a {",
			"\tcolor: red;",
			"}",
			"",
			".b {",
			"\ttop: 0;",
			"}",
		].join("\n");
		const blocks = [...declarationBlocks(css)];
		expect(blocks.map((b) => [b.selector, b.line])).toEqual([
			[".a", 3],
			[".b", 7],
		]);
	});

	it("descends into @media instead of reporting the wrapper", () => {
		const css = "@media (min-width: 600px) {\n\t.a {\n\t\ttop: 0;\n\t}\n}";
		expect([...declarationBlocks(css)].map((b) => b.selector)).toEqual([".a"]);
	});

	it("does not let a commented-out declaration count as real", () => {
		const css = ".a {\n\ttransform: translateX(-100%);\n\t/* visibility: hidden; */\n}";
		const [block] = [...declarationBlocks(css)];
		expect(block.body).not.toContain("visibility");
	});
});

describe("isOffCanvasTransform", () => {
	it.each([
		"translateX(-100%)",
		"translateX(100%)",
		"translateX(calc(100% + 1px))",
		"translateX(calc(-100% - 1px))",
		"translate3d(100%, 0, 0)",
	])("flags %s", (value) => {
		expect(isOffCanvasTransform(value)).toBe(true);
	});

	it.each([
		"translateX(0)",
		"translateX(-50%)",
		"translateX(12px)",
		"translateY(100%)",
		"none",
		// Graph's `.zoom-controls` rides the sidebar's width while fully
		// visible — a variable offset is NOT an off-canvas tell.
		"translateX(calc(-1 * var(--graph-sidebar-width, 320px)))",
	])("does not flag %s", (value) => {
		expect(isOffCanvasTransform(value)).toBe(false);
	});
});

describe("auditOffCanvasGuards", () => {
	const audit = (src, baseline = []) =>
		auditOffCanvasGuards({ sources: [{ file: "apps/a/src/styles.css", src }], baseline });

	it("flags a panel slid off-canvas with no guard", () => {
		const res = audit('.a[data-open="false"] .p {\n\ttransform: translateX(-100%);\n}');
		expect(res.newViolations.map((v) => v.selector)).toEqual(['.a[data-open="false"] .p']);
	});

	it("passes when the same block hides it", () => {
		const res = audit(
			'.a[data-open="false"] .p {\n\ttransform: translateX(-100%);\n\tvisibility: hidden;\n}',
		);
		expect(res.newViolations).toEqual([]);
	});

	it("passes `display: none` too", () => {
		const res = audit(
			'.a[data-open="false"] .p {\n\ttransform: translateX(-100%);\n\tdisplay: none;\n}',
		);
		expect(res.newViolations).toEqual([]);
	});

	it("does not accept a guard from a neighbouring rule — the check is per block", () => {
		const src = ".p {\n\tvisibility: hidden;\n}\n.q {\n\ttransform: translateX(100%);\n}";
		expect(audit(src).newViolations.map((v) => v.selector)).toEqual([".q"]);
	});

	it("is not fooled by `pointer-events: none`, which blocks the mouse only", () => {
		const src = ".p {\n\ttransform: translateX(100%);\n\tpointer-events: none;\n}";
		expect(audit(src).newViolations.map((v) => v.selector)).toEqual([".p"]);
	});

	it("ignores a visible element translated by a variable width", () => {
		const src = ".zoom {\n\ttransform: translateX(calc(-1 * var(--w, 320px)));\n}";
		expect(audit(src).newViolations).toEqual([]);
	});

	it("suppresses a baselined rule and reports it once it is guarded", () => {
		const bad = ".p {\n\ttransform: translateX(100%);\n}";
		const key = "apps/a/src/styles.css:.p";
		expect(audit(bad, [key]).newViolations).toEqual([]);
		expect(audit(bad, [key]).staleBaseline).toEqual([]);

		const good = ".p {\n\ttransform: translateX(100%);\n\tvisibility: hidden;\n}";
		expect(audit(good, [key]).staleBaseline).toEqual([key]);
	});
});
