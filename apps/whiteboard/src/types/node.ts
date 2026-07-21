/**
 * `WhiteboardNode` — inlined into `Whiteboard.nodes[]` (per OQ-WB-1
 * resolution: nodes are per-board scenery, edges are separate entities).
 *
 * Modelled as a **discriminated union on `kind`**. The on-disk JSON is
 * still a flat object (every per-kind field is a top-level key); only the
 * TS type tightens so the renderer / codec slices can `switch (n.kind)`
 * exhaustively. The codec (`storage/codec.ts`) owns the
 * unknown→variant migration; this file owns the shape + guards + the
 * sticky-colour CSS palette (single source for the renderer's tint).
 *
 * Node kinds:
 *   - **Sticky** — small text card with a discrete colour swatch
 *   - **Text** — text block with a format (plain / heading / quote)
 *   - **Image** — image with an object-fit mode, retains its frame box
 *   - **Embedded** — a Block Protocol embedding of any vault entity
 *     (rendered through the same block-frame infra as Notes' embeds;
 *     shape only here — behaviour lands in 9.17.4)
 *   - **Frame** — grouping rectangle with a title bar. **Resolved
 *     (OQ-WB-4): a Frame translates the nodes spatially contained in it
 *     when dragged (FigJam behaviour).**
 *   - **Group** — silent grouping; dragging the group moves every member
 *     in `memberIds` together (membership, not spatial containment).
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import type { RichRun } from "./rich-text";

export enum NodeKind {
	Sticky = "sticky",
	Text = "text",
	Image = "image",
	Embedded = "embedded",
	Frame = "frame",
	Group = "group",
	/** Primitive geometric shape (9.17.10) — see `ShapeKind`. */
	Shape = "shape",
	/** Freehand ink stroke (9.17.9) — a normalised polyline path. */
	Ink = "ink",
}

/** All kinds in display order — frozen, safe to iterate. */
export const NODE_KINDS: readonly NodeKind[] = Object.freeze([
	NodeKind.Sticky,
	NodeKind.Text,
	NodeKind.Image,
	NodeKind.Embedded,
	NodeKind.Frame,
	NodeKind.Group,
	NodeKind.Shape,
	NodeKind.Ink,
]);

export function coerceNodeKind(v: unknown): NodeKind | null {
	return typeof v === "string" && NODE_KINDS.includes(v as NodeKind) ? (v as NodeKind) : null;
}

/** Primitive shape geometries (9.17.10). Rectangle / Ellipse are box-filled
 *  (a tinted div); Line / Arrow / Triangle / Diamond are stroked or filled SVG
 *  drawn to the node box (a separate render path — they aren't box shapes). */
export enum ShapeKind {
	Rectangle = "rectangle",
	Ellipse = "ellipse",
	Triangle = "triangle",
	Diamond = "diamond",
	Line = "line",
	Arrow = "arrow",
}

export const SHAPE_KINDS: readonly ShapeKind[] = Object.freeze([
	ShapeKind.Rectangle,
	ShapeKind.Ellipse,
	ShapeKind.Triangle,
	ShapeKind.Diamond,
	ShapeKind.Line,
	ShapeKind.Arrow,
]);

/** Shapes drawn as SVG geometry rather than a filled box (9.17.10). */
export const SVG_SHAPES: readonly ShapeKind[] = Object.freeze([
	ShapeKind.Triangle,
	ShapeKind.Diamond,
	ShapeKind.Line,
	ShapeKind.Arrow,
]);

export function isSvgShape(shape: ShapeKind): boolean {
	return SVG_SHAPES.includes(shape);
}

export function coerceShapeKind(v: unknown): ShapeKind | null {
	return typeof v === "string" && SHAPE_KINDS.includes(v as ShapeKind) ? (v as ShapeKind) : null;
}

export enum StickyColor {
	Yellow = "yellow",
	Green = "green",
	Blue = "blue",
	Pink = "pink",
	Purple = "purple",
	Gray = "gray",
}

/** Sticky swatch colours in palette display order — frozen. */
export const STICKY_COLORS: readonly StickyColor[] = Object.freeze([
	StickyColor.Yellow,
	StickyColor.Green,
	StickyColor.Blue,
	StickyColor.Pink,
	StickyColor.Purple,
	StickyColor.Gray,
]);

/** Text size for the text-bearing nodes (Sticky / Text) — 9.17.12. A small
 *  controlled set rather than free px so the palette stays consistent and the
 *  wire value is an enum, not a raw number. Absent = `Medium`. */
export enum TextSize {
	Small = "small",
	Medium = "medium",
	Large = "large",
}

/** Text sizes in display order — frozen. */
export const TEXT_SIZES: readonly TextSize[] = Object.freeze([
	TextSize.Small,
	TextSize.Medium,
	TextSize.Large,
]);

export function coerceTextSize(v: unknown): TextSize | null {
	return typeof v === "string" && TEXT_SIZES.includes(v as TextSize) ? (v as TextSize) : null;
}

const TEXT_SIZE_CSS: Readonly<Record<TextSize, string>> = Object.freeze({
	[TextSize.Small]: "13px",
	[TextSize.Medium]: "16px",
	[TextSize.Large]: "22px",
});

export function textSizeToCss(s: TextSize): string {
	return TEXT_SIZE_CSS[s];
}

/** Controlled body-text colour palette (9.17.12). Absent = the theme default
 *  ink. Wire value is the enum; the CSS hex is centralised here. */
export enum TextColor {
	Default = "default",
	Red = "red",
	Amber = "amber",
	Green = "green",
	Blue = "blue",
	Purple = "purple",
}

export const TEXT_COLORS: readonly TextColor[] = Object.freeze([
	TextColor.Default,
	TextColor.Red,
	TextColor.Amber,
	TextColor.Green,
	TextColor.Blue,
	TextColor.Purple,
]);

export function coerceTextColor(v: unknown): TextColor | null {
	return typeof v === "string" && TEXT_COLORS.includes(v as TextColor) ? (v as TextColor) : null;
}

const TEXT_COLOR_CSS: Readonly<Record<TextColor, string | null>> = Object.freeze({
	[TextColor.Default]: null,
	[TextColor.Red]: "#dc2626",
	[TextColor.Amber]: "#d97706",
	[TextColor.Green]: "#16a34a",
	[TextColor.Blue]: "#2563eb",
	[TextColor.Purple]: "#7c3aed",
});

/** The CSS colour for a palette entry, or `null` for `Default` (theme ink). */
export function textColorToCss(c: TextColor): string | null {
	return TEXT_COLOR_CSS[c];
}

/** Controlled body font family (9.17.12). Absent = `Sans` (the inherited UI
 *  font). */
export enum FontFamily {
	Sans = "sans",
	Serif = "serif",
	Mono = "mono",
}

export const FONT_FAMILIES: readonly FontFamily[] = Object.freeze([
	FontFamily.Sans,
	FontFamily.Serif,
	FontFamily.Mono,
]);

export function coerceFontFamily(v: unknown): FontFamily | null {
	return typeof v === "string" && FONT_FAMILIES.includes(v as FontFamily) ? (v as FontFamily) : null;
}

const FONT_FAMILY_CSS: Readonly<Record<FontFamily, string>> = Object.freeze({
	[FontFamily.Sans]: "var(--font-ui, system-ui, sans-serif)",
	[FontFamily.Serif]: "Georgia, 'Times New Roman', serif",
	[FontFamily.Mono]: "var(--font-mono, ui-monospace, monospace)",
});

export function fontFamilyToCss(f: FontFamily): string {
	return FONT_FAMILY_CSS[f];
}

export enum TextBlockFormat {
	Plain = "plain",
	Heading = "heading",
	Quote = "quote",
}

/** Text-block formats in display order — frozen. */
export const TEXT_BLOCK_FORMATS: readonly TextBlockFormat[] = Object.freeze([
	TextBlockFormat.Plain,
	TextBlockFormat.Heading,
	TextBlockFormat.Quote,
]);

export enum ImageFit {
	Contain = "contain",
	Cover = "cover",
	Fill = "fill",
}

/** Image object-fit modes in display order — frozen. */
export const IMAGE_FITS: readonly ImageFit[] = Object.freeze([
	ImageFit.Contain,
	ImageFit.Cover,
	ImageFit.Fill,
]);

export type BaseNode = {
	id: string;
	kind: NodeKind;
	/** Top-left x in canvas-pixel coordinates. */
	x: number;
	/** Top-left y in canvas-pixel coordinates. */
	y: number;
	width: number;
	height: number;
	/** z-order. Higher = on top. Ties broken by document order. */
	zIndex?: number;
	/** Locked (9.17.15) — selectable but not movable/resizable; absent = unlocked. */
	locked?: boolean;
	/** Hidden (9.17.13) — not painted on the canvas; only reachable via the
	 *  layers panel (which is where it's un-hidden). Absent = visible. */
	hidden?: boolean;
	icon?: Icon | null;
};

export type StickyNode = BaseNode & {
	kind: NodeKind.Sticky;
	text: string;
	/** Rich-text runs (9.17.12); present only when some run is styled.
	 *  `text` stays the plain mirror (`richToPlain(rich)`). */
	rich?: RichRun[];
	color: StickyColor;
	/** Body text size (9.17.12); absent = `TextSize.Medium`. */
	textSize?: TextSize;
	/** Body text colour (9.17.12); absent = `TextColor.Default`. */
	textColor?: TextColor;
	/** Body font family (9.17.12); absent = `FontFamily.Sans`. */
	fontFamily?: FontFamily;
	/** Whole-node bold (9.17.12); absent = normal weight. */
	bold?: boolean;
	/** Whole-node italic (9.17.12); absent = upright. */
	italic?: boolean;
};

export type TextNode = BaseNode & {
	kind: NodeKind.Text;
	text: string;
	/** Rich-text runs (9.17.12); present only when some run is styled.
	 *  `text` stays the plain mirror (`richToPlain(rich)`). */
	rich?: RichRun[];
	format: TextBlockFormat;
	/** Body text size (9.17.12); absent = `TextSize.Medium`. */
	textSize?: TextSize;
	/** Body text colour (9.17.12); absent = `TextColor.Default`. */
	textColor?: TextColor;
	/** Body font family (9.17.12); absent = `FontFamily.Sans`. */
	fontFamily?: FontFamily;
	/** Whole-node bold (9.17.12); absent = normal weight. */
	bold?: boolean;
	/** Whole-node italic (9.17.12); absent = upright. */
	italic?: boolean;
};

export type ImageNode = BaseNode & {
	kind: NodeKind.Image;
	imageUrl: string;
	fit: ImageFit;
	alt?: string;
};

export type FrameNode = BaseNode & {
	kind: NodeKind.Frame;
	title: string;
	colorHint?: string | null;
};

export type GroupNode = BaseNode & {
	kind: NodeKind.Group;
	memberIds: string[];
	colorHint?: string | null;
};

export type EmbeddedNode = BaseNode & {
	kind: NodeKind.Embedded;
	/** The `brainstorm://entity/<id>` URL the BP block resolves (9.17.4). The
	 *  block bundle is resolved from this entity's type via
	 *  `services.blocks.forType` (or an explicit `#block-<id>` fragment). */
	entityRef: string;
	/** The embedded entity's type id, captured at insert so the host can
	 *  resolve the providing app's block without a round-trip. Absent on
	 *  legacy nodes — the mount falls back to resolving from the live entity. */
	entityType?: string;
};

export type ShapeNode = BaseNode & {
	kind: NodeKind.Shape;
	shape: ShapeKind;
	/** Fill colour, reusing the sticky palette so shapes theme consistently. */
	color: StickyColor;
};

/** Freehand ink stroke (9.17.9). `points` are normalised to a `0..100`
 *  square (see `logic/ink`), so the SVG renders in a fixed viewBox and the
 *  stroke stretches with the node box. */
export type InkNode = BaseNode & {
	kind: NodeKind.Ink;
	points: { x: number; y: number }[];
	color: StickyColor;
};

export type WhiteboardNode =
	| StickyNode
	| TextNode
	| ImageNode
	| FrameNode
	| GroupNode
	| EmbeddedNode
	| ShapeNode
	| InkNode;

export function isSticky(n: WhiteboardNode): n is StickyNode {
	return n.kind === NodeKind.Sticky;
}

export function isText(n: WhiteboardNode): n is TextNode {
	return n.kind === NodeKind.Text;
}

export function isImage(n: WhiteboardNode): n is ImageNode {
	return n.kind === NodeKind.Image;
}

export function isFrame(n: WhiteboardNode): n is FrameNode {
	return n.kind === NodeKind.Frame;
}

export function isGroup(n: WhiteboardNode): n is GroupNode {
	return n.kind === NodeKind.Group;
}

export function isEmbedded(n: WhiteboardNode): n is EmbeddedNode {
	return n.kind === NodeKind.Embedded;
}

export function isShape(n: WhiteboardNode): n is ShapeNode {
	return n.kind === NodeKind.Shape;
}

export function isInk(n: WhiteboardNode): n is InkNode {
	return n.kind === NodeKind.Ink;
}

/**
 * Controlled sticky palette — the renderer slice calls this for the card
 * background tint so raw hex never lands in CSS. Light, low-saturation
 * fills sit under dark canvas text; kept total over `STICKY_COLORS`.
 */
const STICKY_CSS: Readonly<Record<StickyColor, string>> = Object.freeze({
	[StickyColor.Yellow]: "#fde68a",
	[StickyColor.Green]: "#bbf7d0",
	[StickyColor.Blue]: "#bfdbfe",
	[StickyColor.Pink]: "#fbcfe8",
	[StickyColor.Purple]: "#ddd6fe",
	[StickyColor.Gray]: "#e5e7eb",
});

export function stickyColorToCss(c: StickyColor): string {
	return STICKY_CSS[c];
}
