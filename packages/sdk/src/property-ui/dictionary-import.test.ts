import type { DictionaryItem } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	ImportFormat,
	MAX_IMPORT_ROWS,
	detectFormat,
	exportJson,
	parseImport,
} from "./dictionary-import";

describe("detectFormat", () => {
	it("recognises JSON, TSV, CSV", () => {
		expect(detectFormat('[{"label":"A"}]')).toBe(ImportFormat.Json);
		expect(detectFormat('{"items":[]}')).toBe(ImportFormat.Json);
		expect(detectFormat("a\tb\tc")).toBe(ImportFormat.Tsv);
		expect(detectFormat("a,b,c")).toBe(ImportFormat.Csv);
	});
});

describe("parseImport — delimited", () => {
	it("parses CSV with a header row skipped", () => {
		const r = parseImport("label,icon,description\nTo do,,The backlog\nDone,star,Finished");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.rows).toEqual([
			{ label: "To do", icon: null, description: "The backlog" },
			{ label: "Done", icon: "star", description: "Finished" },
		]);
	});

	it("parses TSV and strips quotes", () => {
		const r = parseImport('"In Progress"\tflag\t"Active work"', ImportFormat.Tsv);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.rows[0]).toEqual({ label: "In Progress", icon: "flag", description: "Active work" });
	});

	it("picks up a valid hex colour column", () => {
		const r = parseImport("label,icon,description,colour\nUrgent,,,#ff0066");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.rows[0]?.colour).toBe("#ff0066");
	});

	it("rejects empty + label-less input", () => {
		expect(parseImport("   ").ok).toBe(false);
		const blank = parseImport("label,icon\n,star");
		expect(blank.ok).toBe(false);
	});
});

describe("parseImport — JSON", () => {
	it("accepts a bare array and an { items } envelope", () => {
		const a = parseImport('[{"label":"A","colour":"#112233"},{"label":"B"}]');
		expect(a.ok && a.rows.length).toBe(2);
		const b = parseImport('{"items":[{"label":"C"}]}');
		expect(b.ok && b.rows[0]?.label).toBe("C");
	});

	it("drops entries without a label and rejects invalid JSON", () => {
		const r = parseImport('[{"label":"A"},{"icon":"x"},{}]');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.rows.map((x) => x.label)).toEqual(["A"]);
		expect(parseImport("{not json").ok).toBe(false);
		// A JSON scalar isn't an array/{items}; explicitly-JSON parse rejects.
		expect(parseImport("42", ImportFormat.Json).ok).toBe(false);
	});
});

describe("parseImport — row cap", () => {
	it("does not truncate at or below MAX_IMPORT_ROWS", () => {
		const csv = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `v${i}`).join("\n");
		const r = parseImport(csv);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.rows.length).toBe(MAX_IMPORT_ROWS);
		expect(r.truncated).toBe(false);
	});

	it("caps and signals truncation when over the limit (CSV)", () => {
		const csv = Array.from({ length: MAX_IMPORT_ROWS + 250 }, (_, i) => `v${i}`).join("\n");
		const r = parseImport(csv);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.rows.length).toBe(MAX_IMPORT_ROWS);
		expect(r.truncated).toBe(true);
	});

	it("caps and signals truncation when over the limit (JSON)", () => {
		const arr = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({ label: `v${i}` }));
		const r = parseImport(JSON.stringify(arr));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.rows.length).toBe(MAX_IMPORT_ROWS);
		expect(r.truncated).toBe(true);
	});
});

describe("exportJson", () => {
	it("serialises label/icon/description/colour, dropping archived", () => {
		const items: DictionaryItem[] = [
			{ id: "a", label: "A", icon: null, sortIndex: 0, colour: "#ff0000", archivedAt: 1 },
			{ id: "b", label: "B", icon: null, sortIndex: 1, description: "second" },
		];
		const parsed = JSON.parse(exportJson(items));
		expect(parsed).toEqual([
			{ label: "A", icon: null, colour: "#ff0000" },
			{ label: "B", icon: null, description: "second" },
		]);
	});
});
