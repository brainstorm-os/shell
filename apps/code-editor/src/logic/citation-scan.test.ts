import { describe, expect, it } from "vitest";
import { type CitationEntry, type CitationIndex, CitationKind } from "./citation-index";
import { collectReferences, lineAtOffset, scanCitations } from "./citation-scan";

function entry(code: string, kind = CitationKind.Iteration): CitationEntry {
	return {
		kind,
		key: code.toUpperCase(),
		code,
		entityId: `e-${code}`,
		entityType:
			kind === CitationKind.Iteration ? "brainstorm/Iteration/v1" : "brainstorm/OpenQuestion/v1",
		title: `Title ${code}`,
		status: "done",
		summary: `Summary ${code}`,
	};
}

function index(codes: Array<[string, CitationKind?]>): CitationIndex {
	const m = new Map<string, CitationEntry>();
	for (const [code, kind] of codes) {
		const e = entry(code, kind);
		m.set(e.key, e);
	}
	return m;
}

describe("scanCitations", () => {
	const idx = index([["9.14.1.5"], ["9.14"], ["SH-14"], ["OQ-GR-1", CitationKind.OpenQuestion]]);

	it("matches the longest code at a position, not its prefix", () => {
		const spans = scanCitations("see 9.14.1.5 for detail", idx);
		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({ code: "9.14.1.5", start: 4, end: 12 });
	});

	it("matches a bare shorter code when no longer one applies", () => {
		const spans = scanCitations("stage 9.14 overview", idx);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.code).toBe("9.14");
	});

	it("resolves a case-insensitive hit back to the canonical entry", () => {
		const spans = scanCitations("ref oq-gr-1 here", idx);
		expect(spans[0]?.code).toBe("oq-gr-1");
		expect(spans[0]?.entry.code).toBe("OQ-GR-1");
		expect(spans[0]?.entry.kind).toBe(CitationKind.OpenQuestion);
	});

	it("does not match a code embedded in a larger token", () => {
		expect(scanCitations("v9.14 build9.14.1.5x path/9.14/", idx)).toEqual([]);
	});

	it("ignores codes that are not in the index (no version-string false positives)", () => {
		expect(scanCitations("pkg 1.0.0 released 2026.05.18", idx)).toEqual([]);
	});

	it("returns nothing for an empty buffer or empty index", () => {
		expect(scanCitations("", idx)).toEqual([]);
		expect(scanCitations("9.14", new Map())).toEqual([]);
	});
});

describe("collectReferences", () => {
	it("dedupes by entity, counts occurrences, orders by first appearance", () => {
		const idx = index([["SH-14"], ["9.14.1.5"]]);
		const text = "first 9.14.1.5\nthen SH-14\nagain 9.14.1.5 and SH-14";
		const refs = collectReferences(text, idx);
		expect(refs.map((r) => r.entry.code)).toEqual(["9.14.1.5", "SH-14"]);
		expect(refs[0]).toMatchObject({ count: 2, firstLine: 1 });
		expect(refs[1]).toMatchObject({ count: 2, firstLine: 2 });
	});

	it("is empty when nothing resolves", () => {
		expect(collectReferences("nothing here", index([["9.1"]]))).toEqual([]);
	});
});

describe("lineAtOffset", () => {
	it("is 1-based and counts newlines before the offset", () => {
		const text = "a\nbb\nccc";
		expect(lineAtOffset(text, 0)).toBe(1);
		expect(lineAtOffset(text, 2)).toBe(2);
		expect(lineAtOffset(text, 5)).toBe(3);
	});

	it("clamps an out-of-range offset", () => {
		expect(lineAtOffset("a\nb", 999)).toBe(2);
		expect(lineAtOffset("", 999)).toBe(1);
	});
});

describe("compiled-pattern cache", () => {
	it("repeated scans of the same index agree with a scan through a fresh index", () => {
		const codes: Array<[string]> = [["SH-14"], ["9.14.1.5"], ["OQ-GR-1"]];
		const cached = index(codes);
		const text = "SH-14 then 9.14.1.5 then OQ-GR-1 then SH-14";
		const first = scanCitations(text, cached).map((s) => [s.start, s.code]);
		// A second (and third) pass reuses the compiled alternation — the shared
		// regexp's `lastIndex` must not have advanced past the first match.
		expect(scanCitations(text, cached).map((s) => [s.start, s.code])).toEqual(first);
		expect(scanCitations(text, cached).map((s) => [s.start, s.code])).toEqual(first);
		expect(scanCitations(text, index(codes)).map((s) => [s.start, s.code])).toEqual(first);
	});

	it("a rebuilt index compiles its own pattern", () => {
		const before = index([["SH-14"]]);
		const after = index([["SH-14"], ["9.7.2"]]);
		expect(scanCitations("SH-14 and 9.7.2", before).map((s) => s.code)).toEqual(["SH-14"]);
		expect(scanCitations("SH-14 and 9.7.2", after).map((s) => s.code)).toEqual(["SH-14", "9.7.2"]);
	});
});
