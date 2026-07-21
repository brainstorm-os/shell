import { describe, expect, it } from "vitest";
import {
	EXPORT_EXTENSIONS,
	EXPORT_MIMES,
	GraphExportFormat,
	entityLabel,
	exportGraph,
	toDOT,
	toGraphML,
	toJSON,
	toMermaid,
	toSVG,
} from "./graph-export";
import type { EntityRow, InMemoryGraph, LinkRow } from "./in-memory-graph";

const ent = (id: string, props: Record<string, unknown> = {}, createdAt = 1000): EntityRow => ({
	id,
	type: "io.brainstorm.notes/Note/v1",
	properties: props,
	createdAt,
	updatedAt: createdAt,
	deletedAt: null,
});

const link = (
	id: string,
	sourceEntityId: string,
	destEntityId: string,
	linkType = "mention",
	deletedAt: number | null = null,
): LinkRow => ({ id, sourceEntityId, destEntityId, linkType, createdAt: 2000, deletedAt });

const G: InMemoryGraph = {
	entities: [ent("a", { title: "Alpha" }), ent("b", { name: "Bravo" }), ent("c", {})],
	links: [link("l1", "a", "b"), link("l2", "b", "c"), link("ldead", "a", "c", "mention", 9)],
};

describe("entityLabel", () => {
	it("prefers title, then name, then the id; trims; never empty", () => {
		expect(entityLabel(ent("x", { title: "  T  " }))).toBe("T");
		expect(entityLabel(ent("x", { name: "N" }))).toBe("N");
		expect(entityLabel(ent("the-id", {}))).toBe("the-id");
		expect(entityLabel(ent("the-id", { title: "   " }))).toBe("the-id");
	});
});

describe("toJSON", () => {
	it("emits the versioned shape with source/target links, excluding deleted", () => {
		const doc = JSON.parse(toJSON(G));
		expect(doc.format).toBe("brainstorm/graph-export/v1");
		expect(doc.entities.map((e: { id: string; label: string }) => [e.id, e.label])).toEqual([
			["a", "Alpha"],
			["b", "Bravo"],
			["c", "c"],
		]);
		expect(doc.links.map((l: { id: string }) => l.id)).toEqual(["l1", "l2"]); // ldead excluded
		expect(doc.links[0]).toMatchObject({ source: "a", target: "b", linkType: "mention" });
	});
});

describe("toDOT", () => {
	it("is a digraph with quoted nodes + labelled edges; deleted excluded", () => {
		const dot = toDOT(G);
		expect(dot.startsWith("digraph G {")).toBe(true);
		expect(dot).toContain('"a" [label="Alpha"];');
		expect(dot).toContain('"a" -> "b" [label="mention"];');
		expect(dot).not.toContain("ldead");
		expect(dot.trimEnd().endsWith("}")).toBe(true);
	});

	it("escapes quotes, backslashes and newlines in labels/ids", () => {
		const g: InMemoryGraph = {
			entities: [ent('weird"id', { title: 'a "quote"\nand \\slash' })],
			links: [],
		};
		const dot = toDOT(g);
		expect(dot).toContain('"weird\\"id" [label="a \\"quote\\" and \\\\slash"];');
		// No raw newline leaked into the quoted string.
		expect(dot.split("\n").some((ln) => ln.includes("and \\\\slash"))).toBe(true);
	});
});

describe("toGraphML", () => {
	it("is well-formed and XML-escapes attribute + data content", () => {
		const g: InMemoryGraph = {
			entities: [ent("n<1>", { title: 'A & B "C"' })],
			links: [link("e&1", "n<1>", "n<1>", "rel<>")],
		};
		const xml = toGraphML(g);
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(xml).toContain('<node id="n&lt;1&gt;">');
		expect(xml).toContain('<data key="label">A &amp; B &quot;C&quot;</data>');
		expect(xml).toContain('<edge id="e&amp;1" source="n&lt;1&gt;" target="n&lt;1&gt;">');
		expect(xml).toContain('<data key="linkType">rel&lt;&gt;</data>');
		expect(xml.trimEnd().endsWith("</graphml>")).toBe(true);
		// `&` escaped exactly once (no `&amp;amp;`).
		expect(xml).not.toContain("&amp;amp;");
	});

	it("excludes deleted links", () => {
		expect(toGraphML(G)).not.toContain("ldead");
	});
});

describe("toMermaid", () => {
	it("emits a flowchart with aliased nodes + labelled edges, excluding deleted links", () => {
		const mmd = toMermaid(G);
		const lines = mmd.split("\n");
		expect(lines[0]).toBe("flowchart LR");
		// Synthetic aliases n0/n1/n2 carry the resolved labels (title, name, id).
		expect(mmd).toContain('n0["Alpha"]');
		expect(mmd).toContain('n1["Bravo"]');
		expect(mmd).toContain('n2["c"]');
		// Edges reference aliases, with the link type as the edge label.
		expect(mmd).toContain('n0 -->|"mention"| n1');
		expect(mmd).toContain('n1 -->|"mention"| n2');
		// The deleted link (ldead) is excluded.
		expect(mmd).not.toContain("ldead");
	});

	it("escapes quotes/newlines in labels and skips an edge to a non-exported node", () => {
		const g: InMemoryGraph = {
			entities: [ent("a", { title: 'a "quote"\nline' })],
			links: [link("e1", "a", "ghost")],
		};
		const mmd = toMermaid(g);
		expect(mmd).toContain('n0["a &quot;quote&quot; line"]');
		// `ghost` has no exported node → the edge is dropped (no dangling alias).
		expect(mmd).not.toContain("-->");
	});

	it("an empty graph is just the flowchart header", () => {
		expect(toMermaid({ entities: [], links: [] })).toBe("flowchart LR");
	});
});

describe("exportGraph dispatch + empty graph", () => {
	it("routes each format and never throws on an empty graph", () => {
		const empty: InMemoryGraph = { entities: [], links: [] };
		expect(exportGraph(empty, GraphExportFormat.Json)).toContain('"entities": []');
		expect(exportGraph(empty, GraphExportFormat.Dot)).toBe("digraph G {\n  rankdir=LR;\n}");
		expect(exportGraph(empty, GraphExportFormat.GraphML)).toContain('<graph edgedefault="directed">');
		expect(exportGraph(empty, GraphExportFormat.Mermaid)).toBe("flowchart LR");
		expect(exportGraph(G, GraphExportFormat.Json)).toBe(toJSON(G));
		expect(exportGraph(G, GraphExportFormat.Dot)).toBe(toDOT(G));
		expect(exportGraph(G, GraphExportFormat.GraphML)).toBe(toGraphML(G));
		expect(exportGraph(G, GraphExportFormat.Mermaid)).toBe(toMermaid(G));
	});

	it("Mermaid has registered extension + MIME", () => {
		expect(EXPORT_EXTENSIONS[GraphExportFormat.Mermaid]).toBe("mmd");
		expect(EXPORT_MIMES[GraphExportFormat.Mermaid]).toBe("text/vnd.mermaid");
	});
});

describe("toSVG", () => {
	const node = (
		id: string,
		x: number,
		y: number,
		over: Partial<{ radius: number; color: string; alpha: number; label: string }> = {},
	) => ({
		id,
		x,
		y,
		radius: over.radius ?? 6,
		color: over.color ?? "#3366cc",
		alpha: over.alpha ?? 1,
		label: over.label ?? id,
	});

	it("is a well-formed <svg> with a viewBox enclosing every node + radius + pad", () => {
		const svg = toSVG({
			nodes: [node("a", 0, 0, { radius: 5 }), node("b", 100, 40, { radius: 5 })],
			edges: [{ sourceId: "a", destId: "b", color: "#999", alpha: 0.5 }],
		});
		expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		// minX = -5, minY = -5, maxX = 105, maxY = 45; pad 32 →
		// viewBox="-37 -37 174 114".
		expect(svg).toContain('viewBox="-37 -37 174 114"');
		expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
		expect(svg).toContain(
			'<line x1="0" y1="0" x2="100" y2="40" stroke="#999" stroke-opacity="0.5" stroke-width="1.5"/>',
		);
		expect(svg).toContain('<circle cx="0" cy="0" r="5" fill="#3366cc" fill-opacity="1"/>');
	});

	it("draws edges before nodes (nodes paint on top)", () => {
		const svg = toSVG({
			nodes: [node("a", 0, 0), node("b", 10, 0)],
			edges: [{ sourceId: "a", destId: "b", color: "#000", alpha: 1 }],
		});
		expect(svg.indexOf("<line")).toBeLessThan(svg.indexOf("<circle"));
	});

	it("XML-escapes labels and skips an edge with a missing endpoint", () => {
		const svg = toSVG({
			nodes: [node("a", 0, 0, { label: 'A & <B> "C"' })],
			edges: [{ sourceId: "a", destId: "ghost", color: "#000", alpha: 1 }],
		});
		expect(svg).toContain(">A &amp; &lt;B&gt; &quot;C&quot;</text>");
		expect(svg).not.toContain("<line");
	});

	it("omits the <text> for a blank label", () => {
		const svg = toSVG({ nodes: [node("a", 0, 0, { label: "   " })], edges: [] });
		expect(svg).not.toContain("<text");
		expect(svg).toContain("<circle");
	});

	it("empty input → a minimal valid svg (1×1 viewBox, no shapes)", () => {
		const svg = toSVG({ nodes: [], edges: [] });
		expect(svg).toContain('viewBox="0 0 1 1"');
		expect(svg).not.toContain("<circle");
		expect(svg).not.toContain("<line");
		expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
	});

	it("rounds coordinates to 2dp", () => {
		const svg = toSVG({ nodes: [node("a", 1.23456, 7.89123, { radius: 3.001 })], edges: [] });
		expect(svg).toContain('cx="1.23" cy="7.89" r="3"');
	});
});

describe("file-save format tables (9.13.13b)", () => {
	// Generic helpers moved to `@brainstorm-os/sdk/export-file` and are tested
	// in `packages/sdk/src/export-file/export-file.test.ts` (per
	// [[extract-to-sdk-at-copy-two]]). Graph-specific tables stay here.

	it("EXPORT_EXTENSIONS covers every format the menu exposes", () => {
		// The menu enumerates the file-save rows; the table must carry an
		// extension for each one — drift = a `Save as PNG…` click would
		// land in the dialog with no default extension and the wrong
		// filter list.
		const keys = Object.keys(EXPORT_EXTENSIONS).sort();
		expect(keys).toEqual(["dot", "graphml", "json", "mermaid", "png", "svg"]);
	});

	it("EXPORT_MIMES covers every format the menu exposes", () => {
		const keys = Object.keys(EXPORT_MIMES).sort();
		expect(keys).toEqual(["dot", "graphml", "json", "mermaid", "png", "svg"]);
	});

	it("extension lookups round-trip the GraphExportFormat enum", () => {
		// The string-enum values are themselves the lookup keys — a
		// rename of the enum would silently desync the table without this
		// fence.
		expect(EXPORT_EXTENSIONS[GraphExportFormat.Json]).toBe("json");
		expect(EXPORT_EXTENSIONS[GraphExportFormat.Dot]).toBe("dot");
		expect(EXPORT_EXTENSIONS[GraphExportFormat.GraphML]).toBe("graphml");
		expect(EXPORT_EXTENSIONS.svg).toBe("svg");
		expect(EXPORT_EXTENSIONS.png).toBe("png");
	});
});
