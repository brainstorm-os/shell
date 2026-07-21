/**
 * Inline-SVG icon family for the Whiteboard app — same pattern as
 * `apps/files/src/ui/icons.ts` / `apps/graph/src/ui/icons.ts`. Stroke-only,
 * `currentColor`, 16×16 viewBox. Used by the zoom in / zoom out toolbar
 * buttons; unicode glyphs like `+` / `−` render inconsistently across
 * platforms and don't honour the theme accent.
 */

import { createGlyphElement, glyphIconParam } from "@brainstorm-os/sdk/icon";
import type { IconParam } from "@brainstorm-os/sdk/menus";

export enum WhiteboardIcon {
	Plus = "plus",
	Minus = "minus",
	Board = "board",
	Sticky = "sticky",
	Text = "text",
	Image = "image",
	Frame = "frame",
	Group = "group",
	Reset = "reset",
	Pointer = "pointer",
	Connector = "connector",
	Rectangle = "rectangle",
	Ellipse = "ellipse",
	Triangle = "triangle",
	Diamond = "diamond",
	Line = "line",
	Arrow = "arrow",
	Pen = "pen",
	Shapes = "shapes",
	Style = "style",
	Arrange = "arrange",
	Layers = "layers",
	Export = "export",
	Check = "check",
	Embed = "embed",
	Close = "close",
	Bold = "bold",
	Italic = "italic",
	Underline = "underline",
	Strike = "strike",
}

export const WHITEBOARD_ICON_PATHS: Record<WhiteboardIcon, string[]> = {
	[WhiteboardIcon.Plus]: ["M8 3.5v9", "M3.5 8h9"],
	[WhiteboardIcon.Minus]: ["M3.5 8h9"],
	[WhiteboardIcon.Board]: ["M2.5 3.5h11v9h-11z", "M2.5 6.5h11", "M6 6.5v6"],
	[WhiteboardIcon.Sticky]: ["M3 3h10v7l-3 3H3z", "M13 10h-3v3"],
	[WhiteboardIcon.Text]: ["M3.5 4h9", "M8 4v8.5", "M6 12.5h4"],
	[WhiteboardIcon.Image]: ["M2.5 3.5h11v9h-11z", "M5.5 7a1 1 0 1 0 0-.01", "M3 11l3-3 3 3 2-2 3 3"],
	[WhiteboardIcon.Frame]: ["M3 5.5h10", "M3 5.5v7h10v-7", "M5 3v2.5", "M11 3v2.5"],
	[WhiteboardIcon.Group]: ["M3 3h6v6H3z", "M9 9h4v4H9z", "M9 7h2v2"],
	// Recenter / fit: four corner brackets — resets zoom + pan.
	[WhiteboardIcon.Reset]: ["M3 6V3h3", "M13 6V3h-3", "M3 10v3h3", "M13 10v3h-3"],
	// Arrow cursor — the default Select tool glyph.
	[WhiteboardIcon.Pointer]: ["M3 2.5l9 4.5-4 1.5L7 13z"],
	// Connector / line tool — diagonal stroke with endpoint dots.
	[WhiteboardIcon.Connector]: ["M4 12l8-8", "M4 12.5a1 1 0 1 0 0-.01", "M12.5 4a1 1 0 1 0 0-.01"],
	// Primitive shapes (9.17.10) — a plain rect + an ellipse (rx 5, ry 4).
	[WhiteboardIcon.Rectangle]: ["M2.5 4h11v8h-11z"],
	[WhiteboardIcon.Ellipse]: ["M13 8a5 4 0 1 1 -10 0a5 4 0 1 1 10 0"],
	// Line / arrow / triangle / diamond (9.17.10 SVG primitives).
	[WhiteboardIcon.Triangle]: ["M8 3l5 9H3z"],
	[WhiteboardIcon.Diamond]: ["M8 2.5l5.5 5.5L8 13.5L2.5 8z"],
	[WhiteboardIcon.Line]: ["M3 13L13 3"],
	[WhiteboardIcon.Arrow]: ["M3 13L13 3", "M9 3h4v4"],
	// Pen / freehand tool (9.17.9) — a nib over a stroke.
	[WhiteboardIcon.Pen]: ["M11 2.5l2.5 2.5L6 12.5L3 13l.5-3z", "M10 3.5l2.5 2.5"],
	// Shapes — overlapping square + circle; the header Add-content menu
	// (sticky / text / shapes / image), distinct from the new-board Plus.
	[WhiteboardIcon.Shapes]: ["M3 3h7v7H3z", "M13 10.5a2.8 2.8 0 1 1 -5.6 0a2.8 2.8 0 1 1 5.6 0"],
	// Style — a paint droplet (fill / colour / text styling).
	[WhiteboardIcon.Style]: ["M8 2.5C5.5 6 4 8 4 9.5a4 4 0 0 0 8 0C12 8 10.5 6 8 2.5z"],
	// Arrange — a left rail with three align bars (align / distribute / order).
	[WhiteboardIcon.Arrange]: ["M3 3v10", "M5.5 5h7.5", "M5.5 8h4.5", "M5.5 11h6.5"],
	// Layers — two stacked sheets.
	[WhiteboardIcon.Layers]: ["M8 2.5l5.5 3-5.5 3-5.5-3z", "M2.5 8.5l5.5 3 5.5-3"],
	// Export — a tray with an arrow leaving the top (share / save out).
	[WhiteboardIcon.Export]: ["M8 2.5v6.5", "M5.5 5L8 2.5L10.5 5", "M3.5 9.5v3h9v-3"],
	// Check — transient success confirmation on the export trigger.
	[WhiteboardIcon.Check]: ["M3.5 8.5l3 3 6-7"],
	// Embed (9.17.4) — an outer card framing an inner block (a hosted entity).
	[WhiteboardIcon.Embed]: ["M2.5 3.5h11v9h-11z", "M5 6.5h6v3.5H5z"],
	// Close — the layers-panel dismiss affordance.
	[WhiteboardIcon.Close]: ["M4 4l8 8", "M12 4l-8 8"],
	// Inline-format toolbar glyphs (9.17.12 rest).
	[WhiteboardIcon.Bold]: ["M5 3h4a2.5 2.5 0 0 1 0 5H5z", "M5 8h4.5a2.5 2.5 0 0 1 0 5H5z"],
	[WhiteboardIcon.Italic]: ["M7 3h5", "M4 13h5", "M9.5 3l-3 10"],
	[WhiteboardIcon.Underline]: ["M4.5 3v4.5a3.5 3.5 0 0 0 7 0V3", "M4 13.5h8"],
	[WhiteboardIcon.Strike]: [
		"M3 8h10",
		"M11.5 5c0-1.2-1.5-2-3.5-2s-3.5.8-3.5 2",
		"M4.5 11c0 1.2 1.5 2 3.5 2s3.5-.8 3.5-2",
	],
};

export type CreateIconOptions = {
	size?: number;
	className?: string;
	title?: string;
};

export function createIcon(glyph: WhiteboardIcon, options: CreateIconOptions = {}): SVGSVGElement {
	return createGlyphElement(
		{ viewBox: "0 0 16 16", paths: WHITEBOARD_ICON_PATHS[glyph], strokeWidth: 1.5 },
		options,
	);
}

export function setIcon(host: Element, glyph: WhiteboardIcon, options?: CreateIconOptions): void {
	host.replaceChildren(createIcon(glyph, options));
}

/** The fancy-menu twin of `createIcon` — the same glyph as an `IconParam` for
 *  a menu row. Built once per glyph so the component identity is stable. */
const ICON_PARAMS = new Map<WhiteboardIcon, IconParam>();
export function iconParam(glyph: WhiteboardIcon): IconParam {
	let param = ICON_PARAMS.get(glyph);
	if (!param) {
		param = glyphIconParam({
			viewBox: "0 0 16 16",
			paths: WHITEBOARD_ICON_PATHS[glyph],
			strokeWidth: 1.5,
		});
		ICON_PARAMS.set(glyph, param);
	}
	return param;
}
