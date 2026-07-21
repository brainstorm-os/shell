/**
 * Graph chrome glyphs.
 *
 * The shared `@brainstorm-os/sdk/icon` registry is the source of truth — any
 * glyph it exposes renders via `createIconElement` / `<Icon>` so Graph's
 * chrome looks identical to the rest of the product. The only glyphs Graph
 * needs that the shared registry does NOT expose are the graph-specific
 * controls: the filter funnel, play / pause transport, the two panel-toggle
 * arrows, the layout reset arc, and the A→B path marker. Those live here as a
 * minimal local set (stroke-only, `currentColor`, 16×16 viewBox matching the
 * earlier Graph metrics). Everything else (Close, Plus, Minus, ArrowRight,
 * Settings, History, Export) routes through the SDK registry.
 *
 * Per the [[no-plus-text-with-icon]] memory, buttons consuming these icons
 * must not duplicate the glyph in the label text.
 */

import { type IconName, createGlyphElement, createIconElement } from "@brainstorm-os/sdk/icon";

/** Graph glyphs that exist in the shared SDK registry — delegated so they
 *  render identically to every other app. */
export enum GraphSharedIcon {
	Settings = "settings",
	History = "history",
	ArrowRight = "arrow-right",
	Close = "close",
	Plus = "plus",
	Minus = "minus",
	/** Down-arrow-into-tray — the SDK `Download` glyph reads as "export / save
	 *  out" and matches the export item in the header ⋯ menu. (The earlier
	 *  `open-external` box-arrow read as "open in another app / go to URL".) */
	Export = "download",
}

/** Graph glyphs the shared registry does NOT yet expose. */
export enum GraphLocalIcon {
	Filters = "filters",
	Play = "play",
	Pause = "pause",
	PanelCollapse = "panel-collapse",
	PanelExpand = "panel-expand",
	Reset = "reset",
	/** Path view (9.13) — two endpoint nodes joined by a route. */
	Path = "path",
}

export type GraphIconName = GraphSharedIcon | GraphLocalIcon;

/** Unified glyph reference for call sites — merges the shared-registry and
 *  local glyph sets so `GraphIcon.Close` (shared) and `GraphIcon.Path`
 *  (local) read identically at use. */
export const GraphIcon = {
	...GraphSharedIcon,
	...GraphLocalIcon,
} as const;

/** Stroke-only inner paths for the glyphs the SDK registry lacks. */
const LOCAL_SPECS: Record<GraphLocalIcon, string> = {
	// Classic filter funnel — Phosphor / Lucide shape. The earlier
	// three-stacked-lines glyph was confusable with a range slider, which
	// led to the "what does this empty button do" feedback. A clear funnel
	// outline reads unambiguously as "filter / refine".
	[GraphLocalIcon.Filters]: "M2.5 3.5h11l-4 5v4l-3 1.5v-5.5l-4-5Z",
	[GraphLocalIcon.Play]: "M4.5 3 12 8l-7.5 5V3Z",
	[GraphLocalIcon.Pause]: "M5.5 3v10M10.5 3v10",
	// Panel-collapse / expand — a rectangle with an arrow indicating which
	// way the panel moves. Collapse pushes content right (panel goes away);
	// expand pulls it back from the right.
	[GraphLocalIcon.PanelCollapse]: "M2.5 3h11v10h-11zM9.5 3v10M6 6l1.5 2L6 10",
	[GraphLocalIcon.PanelExpand]: "M2.5 3h11v10h-11zM9.5 3v10M7.5 6 6 8l1.5 2",
	[GraphLocalIcon.Reset]: "M13.5 5.5a5.5 5.5 0 1 0-.9 4.6M13.5 2v3.5H10",
	// Two endpoint nodes joined by a bent route — reads as "path between A & B".
	[GraphLocalIcon.Path]:
		"M3.5 12.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM12.5 7.1a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM4.6 9.2 7 6.5h3.7",
};

/** The local glyph paths, exposed as the `string[]` shape the React twin
 *  (`icons-react.tsx`) consumes. */
export const GRAPH_LOCAL_ICON_PATHS: Record<GraphLocalIcon, string[]> = Object.fromEntries(
	Object.entries(LOCAL_SPECS).map(([glyph, path]) => [glyph, [path]]),
) as Record<GraphLocalIcon, string[]>;

const SHARED_VALUES = new Set<string>(Object.values(GraphSharedIcon));

export function isSharedGraphIcon(glyph: GraphIconName): glyph is GraphSharedIcon {
	return SHARED_VALUES.has(glyph);
}

export type CreateIconOptions = {
	size?: number;
	className?: string;
};

/** Render a shared SDK glyph by `IconName`. */
export function createSharedIcon(
	name: IconName | `${IconName}`,
	options: CreateIconOptions = {},
): SVGSVGElement | HTMLSpanElement {
	return createIconElement(name, {
		...(options.size !== undefined ? { size: options.size } : {}),
		...(options.className !== undefined ? { className: options.className } : {}),
	});
}

/** Render a local stroke-only glyph (same metrics as the earlier Graph set). */
export function createLocalIcon(
	glyph: GraphLocalIcon,
	options: CreateIconOptions = {},
): SVGSVGElement {
	return createGlyphElement(
		{ viewBox: "0 0 16 16", paths: GRAPH_LOCAL_ICON_PATHS[glyph], strokeWidth: 1.25 },
		options,
	);
}
