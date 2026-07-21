/**
 * 9.13.13 (text-format half) — pure serialisers for the graph the user
 * is looking at; 9.13.13b extension adds the file-save side (PNG raster
 * + `Uint8Array` byte encoders for each format) so the menu can route a
 * choice through `services.files.requestSave` → `services.files.write`
 * instead of the clipboard.
 *
 * Correctness surface = escaping: a node title with a `"`, a newline, an
 * `&`, or a `<` must not corrupt DOT / GraphML. Deleted links are
 * excluded (they aren't on the canvas); entities are kept as-is (a node
 * with no edges is still part of the graph the user sees).
 *
 * **File-save side (9.13.13b).** Generic helpers (`textToBytes`,
 * `svgToPng`, `suggestedFilename`, `requestSaveBytes`) live in
 * `@brainstorm-os/sdk/export-file` — extracted at copy two when Whiteboard
 * 9.17.8b adopted the same flow (per [[extract-to-sdk-at-copy-two]]).
 * This module retains the Graph-specific format tables (extension +
 * MIME, keyed off the `GraphExportFormat` enum) so the menu wiring
 * stays a one-table lookup.
 */

import type { EntityRow, InMemoryGraph, LinkRow } from "./in-memory-graph";

export enum GraphExportFormat {
	Json = "json",
	Dot = "dot",
	GraphML = "graphml",
	Mermaid = "mermaid",
}

/** Human label for a node — title/name property, else the raw id. Never
 *  empty (an untitled node still needs something on the canvas/in DOT). */
export function entityLabel(e: EntityRow): string {
	const p = e.properties as Record<string, unknown>;
	const title = typeof p.title === "string" ? p.title.trim() : "";
	if (title) return title;
	const name = typeof p.name === "string" ? p.name.trim() : "";
	if (name) return name;
	return e.id;
}

function liveLinks(graph: InMemoryGraph): LinkRow[] {
	return graph.links.filter((l) => l.deletedAt === null);
}

/** Stable, re-import-friendly JSON. Entities carry their resolved label
 *  + type; links are `source`/`target` (graph-tool / cytoscape idiom)
 *  not the internal `sourceEntityId`. */
export function toJSON(graph: InMemoryGraph): string {
	const doc = {
		format: "brainstorm/graph-export/v1",
		entities: graph.entities.map((e) => ({
			id: e.id,
			type: e.type,
			label: entityLabel(e),
			createdAt: e.createdAt,
		})),
		links: liveLinks(graph).map((l) => ({
			id: l.id,
			source: l.sourceEntityId,
			target: l.destEntityId,
			linkType: l.linkType,
			createdAt: l.createdAt,
		})),
	};
	return JSON.stringify(doc, null, 2);
}

/** Graphviz DOT. Every id/label is wrapped in a double-quoted string
 *  with `"` and `\` backslash-escaped and newlines collapsed — the only
 *  metacharacters that can break a quoted DOT id. */
function dotQuote(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

export function toDOT(graph: InMemoryGraph): string {
	const lines: string[] = ["digraph G {", "  rankdir=LR;"];
	for (const e of graph.entities) {
		lines.push(`  ${dotQuote(e.id)} [label=${dotQuote(entityLabel(e))}];`);
	}
	for (const l of liveLinks(graph)) {
		lines.push(
			`  ${dotQuote(l.sourceEntityId)} -> ${dotQuote(l.destEntityId)} [label=${dotQuote(
				l.linkType,
			)}];`,
		);
	}
	lines.push("}");
	return lines.join("\n");
}

/** XML 1.0 attribute/text escaping — `&` first so it can't double-escape
 *  the entities introduced by the later replacements. */
function xmlEscape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function toGraphML(graph: InMemoryGraph): string {
	const out: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
		'  <key id="label" for="node" attr.name="label" attr.type="string"/>',
		'  <key id="type" for="node" attr.name="type" attr.type="string"/>',
		'  <key id="linkType" for="edge" attr.name="linkType" attr.type="string"/>',
		'  <graph edgedefault="directed">',
	];
	for (const e of graph.entities) {
		out.push(
			`    <node id="${xmlEscape(e.id)}">`,
			`      <data key="label">${xmlEscape(entityLabel(e))}</data>`,
			`      <data key="type">${xmlEscape(e.type)}</data>`,
			"    </node>",
		);
	}
	for (const l of liveLinks(graph)) {
		out.push(
			`    <edge id="${xmlEscape(l.id)}" source="${xmlEscape(l.sourceEntityId)}" target="${xmlEscape(
				l.destEntityId,
			)}">`,
			`      <data key="linkType">${xmlEscape(l.linkType)}</data>`,
			"    </edge>",
		);
	}
	out.push("  </graph>", "</graphml>");
	return out.join("\n");
}

/** Mermaid `flowchart` (LR) — paste-able into a Markdown / Lexical doc.
 *  Mermaid node ids can't hold arbitrary characters, so each entity gets a
 *  synthetic `n<i>` alias and the real label lives in the quoted node text;
 *  `"` → `&quot;` (Mermaid renders HTML entities in quoted labels) and
 *  newlines collapse, so a title can't break the node. An edge whose endpoint
 *  has no exported node is skipped (no alias to reference) — same stance as
 *  the SVG export; in a consistent snapshot every endpoint is an entity. */
export function toMermaid(graph: InMemoryGraph): string {
	const alias = new Map<string, string>();
	graph.entities.forEach((e, i) => alias.set(e.id, `n${i}`));
	const esc = (s: string): string => s.replace(/"/g, "&quot;").replace(/\r?\n/g, " ");
	const lines: string[] = ["flowchart LR"];
	for (const e of graph.entities) {
		lines.push(`  ${alias.get(e.id)}["${esc(entityLabel(e))}"]`);
	}
	for (const l of liveLinks(graph)) {
		const a = alias.get(l.sourceEntityId);
		const b = alias.get(l.destEntityId);
		if (!a || !b) continue;
		const label = esc(l.linkType);
		lines.push(label ? `  ${a} -->|"${label}"| ${b}` : `  ${a} --> ${b}`);
	}
	return lines.join("\n");
}

/** Serialise `graph` to `format`. The single dispatch the UI calls. */
export function exportGraph(graph: InMemoryGraph, format: GraphExportFormat): string {
	switch (format) {
		case GraphExportFormat.Json:
			return toJSON(graph);
		case GraphExportFormat.Dot:
			return toDOT(graph);
		case GraphExportFormat.GraphML:
			return toGraphML(graph);
		case GraphExportFormat.Mermaid:
			return toMermaid(graph);
	}
}

// ─── SVG (positioned vector export — needs layout, not just topology) ───────

/** One drawable node: laid-out centre + visual attributes already
 *  resolved by the scene (so this stays a pure string builder, free of
 *  the app's scene/layout types). */
export type SvgExportNode = {
	id: string;
	x: number;
	y: number;
	radius: number;
	color: string;
	alpha: number;
	label: string;
};

export type SvgExportEdge = {
	sourceId: string;
	destId: string;
	color: string;
	alpha: number;
};

export type SvgExportInput = {
	nodes: readonly SvgExportNode[];
	edges: readonly SvgExportEdge[];
};

/** Padding (px) around the node bounding box so labels/strokes aren't
 *  clipped at the viewBox edge. */
const SVG_PAD = 32;

function r2(n: number): number {
	return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Standalone SVG of the graph **as laid out** (unlike JSON/DOT/GraphML
 * which are topology-only). Pure: the caller resolves positions + colours
 * from the live scene and hands them in, so this is a deterministic
 * string builder with no app/render-layer dependency — paste-able into
 * Figma / Inkscape / a browser. Edges draw under nodes; an edge whose
 * endpoint has no laid-out node is skipped (can't place a line without
 * both ends). Empty input → a minimal valid empty `<svg>`.
 */
export function toSVG(input: SvgExportInput): string {
	const pos = new Map(input.nodes.map((n) => [n.id, n] as const));

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const n of input.nodes) {
		minX = Math.min(minX, n.x - n.radius);
		minY = Math.min(minY, n.y - n.radius);
		maxX = Math.max(maxX, n.x + n.radius);
		maxY = Math.max(maxY, n.y + n.radius);
	}
	const hasNodes = input.nodes.length > 0 && Number.isFinite(minX);
	const vbX = hasNodes ? r2(minX - SVG_PAD) : 0;
	const vbY = hasNodes ? r2(minY - SVG_PAD) : 0;
	const vbW = hasNodes ? r2(maxX - minX + SVG_PAD * 2) : 1;
	const vbH = hasNodes ? r2(maxY - minY + SVG_PAD * 2) : 1;

	const lines: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" font-family="sans-serif">`,
	];

	for (const e of input.edges) {
		const a = pos.get(e.sourceId);
		const b = pos.get(e.destId);
		if (!a || !b) continue;
		lines.push(
			`  <line x1="${r2(a.x)}" y1="${r2(a.y)}" x2="${r2(b.x)}" y2="${r2(
				b.y,
			)}" stroke="${xmlEscape(e.color)}" stroke-opacity="${r2(e.alpha)}" stroke-width="1.5"/>`,
		);
	}
	for (const n of input.nodes) {
		lines.push(
			`  <circle cx="${r2(n.x)}" cy="${r2(n.y)}" r="${r2(n.radius)}" fill="${xmlEscape(
				n.color,
			)}" fill-opacity="${r2(n.alpha)}"/>`,
		);
		const label = n.label.trim();
		if (label) {
			lines.push(
				`  <text x="${r2(n.x)}" y="${r2(
					n.y + n.radius + 11,
				)}" text-anchor="middle" font-size="10" fill="#888" fill-opacity="${r2(
					n.alpha,
				)}">${xmlEscape(label)}</text>`,
			);
		}
	}
	lines.push("</svg>");
	return lines.join("\n");
}

// ─── File-save plumbing (9.13.13b) ───────────────────────────────────────────
//
// Generic helpers (`textToBytes`, `svgToPng`, `suggestedFilename`,
// `requestSaveBytes`) live in `@brainstorm-os/sdk/export-file` — shared
// with Whiteboard at 9.17.8b (per [[extract-to-sdk-at-copy-two]]). This
// module keeps the Graph-specific format-tables that key off the
// `GraphExportFormat` enum.

/** Canonical extension a saved Graph export carries. The Save dialog
 *  suggests `<graphName>.<ext>` and the filter list pins the
 *  format-specific extension. */
export const EXPORT_EXTENSIONS: Readonly<Record<GraphExportFormat | "svg" | "png", string>> = {
	json: "json",
	dot: "dot",
	graphml: "graphml",
	mermaid: "mmd",
	svg: "svg",
	png: "png",
};

/** MIME used to label saved bytes. Not load-bearing for the file write
 *  itself (the OS keys on extension) but Files-host UIs that surface a
 *  type column read this. */
export const EXPORT_MIMES: Readonly<Record<GraphExportFormat | "svg" | "png", string>> = {
	json: "application/json",
	dot: "text/vnd.graphviz",
	graphml: "application/graphml+xml",
	mermaid: "text/vnd.mermaid",
	svg: "image/svg+xml",
	png: "image/png",
};
