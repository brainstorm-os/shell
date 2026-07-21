/**
 * Persistence codec for `Whiteboard/v1` + `WhiteboardEdge/v1`.
 *
 * Long-term keystone — the on-disk JSON protocol the Stage 9.3 entities
 * service will read without rename. Reads + writes go through these
 * helpers; **all** runtime shape validation lives here so a malformed
 * row from a future migration / sync conflict drops to `null` rather
 * than crashing the renderer.
 *
 * Storage keys:
 *   - `whiteboard:<id>` — one row per board (nodes are inlined per OQ-WB-1)
 *   - `whiteboard-edge:<id>` — one row per `WhiteboardEdge/v1`
 *
 * The `<kind>:` prefix lets the shell-side `vaultEntities` aggregator
 * pick whiteboards up by prefix when its scope grows beyond
 * notes/tasks/self-hosting.
 *
 * **Frame title migration (decided here):** legacy frames stored their
 * title in `text`. `parseNode` reads `title ?? text ?? ""`. On write we
 * emit only `title` (no `text` mirror) — the read-side fallback covers
 * any unmigrated row and a one-way write keeps the on-disk shape clean
 * for the Stage 9.3 entities service. New `node.ts` per-kind required
 * keys flow through the `{...n}` spread unchanged.
 */

import { coerceEnum, nullableString } from "@brainstorm-os/sdk/codec-helpers";
import { coerceInkPoints } from "../logic/ink";
import { richToPlain } from "../logic/rich-text";
import {
	ARROW_HEADS,
	ArrowHead,
	EDGE_PATH_KINDS,
	type EdgePathKind,
	HANDLE_SIDES,
	type HandleSide,
	type WhiteboardEdge,
} from "../types/edge";
import {
	type BaseNode,
	FontFamily,
	IMAGE_FITS,
	ImageFit,
	NodeKind,
	STICKY_COLORS,
	ShapeKind,
	StickyColor,
	TEXT_BLOCK_FORMATS,
	TextBlockFormat,
	TextColor,
	type TextSize,
	type WhiteboardNode,
	coerceFontFamily,
	coerceNodeKind,
	coerceShapeKind,
	coerceTextColor,
	coerceTextSize,
} from "../types/node";
import { type RichRun, coerceRichRuns, isPlainRuns } from "../types/rich-text";
import type { Whiteboard } from "../types/whiteboard";

export const WHITEBOARD_KEY_PREFIX = "whiteboard:";
export const EDGE_KEY_PREFIX = "whiteboard-edge:";

export function whiteboardKey(id: string): string {
	return WHITEBOARD_KEY_PREFIX + id;
}

export function edgeKey(id: string): string {
	return EDGE_KEY_PREFIX + id;
}

export function serializeWhiteboard(whiteboard: Whiteboard): Whiteboard {
	return { ...whiteboard, nodes: whiteboard.nodes.map((n) => ({ ...n })) };
}

export function serializeEdge(edge: WhiteboardEdge): WhiteboardEdge {
	return { ...edge };
}

export function parseStoredWhiteboard(raw: unknown): Whiteboard | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || r.id === "") return null;
	if (typeof r.name !== "string") return null;
	if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
	if (typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt)) return null;

	const rawNodes = Array.isArray(r.nodes) ? r.nodes : [];
	const nodes: WhiteboardNode[] = [];
	for (const rawNode of rawNodes) {
		const parsed = parseNode(rawNode);
		if (parsed) nodes.push(parsed);
	}

	const wb: Whiteboard = {
		id: r.id,
		name: r.name,
		nodes,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	};
	if (typeof r.description === "string") wb.description = r.description;
	return wb;
}

export function parseStoredEdge(raw: unknown): WhiteboardEdge | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || r.id === "") return null;
	if (typeof r.whiteboardId !== "string" || r.whiteboardId === "") return null;
	if (typeof r.sourceNodeId !== "string" || r.sourceNodeId === "") return null;
	if (typeof r.destNodeId !== "string" || r.destNodeId === "") return null;
	if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
	if (typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt)) return null;

	const sourceHandle = coerceHandleSide(r.sourceHandle);
	const destHandle = coerceHandleSide(r.destHandle);
	const pathKind = coerceEdgePathKind(r.pathKind);
	const arrowHead = coerceArrowHead(r.arrowHead);
	if (!sourceHandle || !destHandle || !pathKind || !arrowHead) return null;

	// A source arrowhead of `None` is the unmarked default — drop it so the
	// on-disk shape stays minimal (mirrors how `dashed:false` is omitted).
	const sourceArrowHead = coerceArrowHead(r.sourceArrowHead);
	const edge: WhiteboardEdge = {
		id: r.id,
		whiteboardId: r.whiteboardId,
		sourceNodeId: r.sourceNodeId,
		sourceHandle,
		destNodeId: r.destNodeId,
		destHandle,
		pathKind,
		arrowHead,
		label: nullableString(r.label),
		colorHint: nullableString(r.colorHint),
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	};
	if (sourceArrowHead && sourceArrowHead !== ArrowHead.None) edge.sourceArrowHead = sourceArrowHead;
	if (r.dashed === true) edge.dashed = true;
	return edge;
}

function parseNode(raw: unknown): WhiteboardNode | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || r.id === "") return null;
	const kind = coerceNodeKind(r.kind);
	if (!kind) return null;
	if (!Number.isFinite(r.x as number)) return null;
	if (!Number.isFinite(r.y as number)) return null;
	if (!Number.isFinite(r.width as number) || (r.width as number) <= 0) return null;
	if (!Number.isFinite(r.height as number) || (r.height as number) <= 0) return null;

	const base: BaseNode = {
		id: r.id,
		kind,
		x: r.x as number,
		y: r.y as number,
		width: r.width as number,
		height: r.height as number,
	};
	if (typeof r.zIndex === "number" && Number.isFinite(r.zIndex)) base.zIndex = r.zIndex;
	if (r.locked === true) base.locked = true;
	if (r.hidden === true) base.hidden = true;
	if (r.icon === null || (r.icon !== undefined && typeof r.icon === "object")) {
		base.icon = (r.icon as BaseNode["icon"]) ?? null;
	}

	switch (kind) {
		case NodeKind.Sticky: {
			return {
				...base,
				kind: NodeKind.Sticky,
				...textBodyFields(r),
				color: coerceStickyColor(r.color) ?? mapLegacyColorHint(r.colorHint) ?? StickyColor.Yellow,
				...textStyleFields(r),
			};
		}
		case NodeKind.Text: {
			return {
				...base,
				kind: NodeKind.Text,
				...textBodyFields(r),
				format: coerceTextFormat(r.format) ?? TextBlockFormat.Plain,
				...textStyleFields(r),
			};
		}
		case NodeKind.Image: {
			if (typeof r.imageUrl !== "string" || r.imageUrl === "") return null;
			const node: WhiteboardNode = {
				...base,
				kind: NodeKind.Image,
				imageUrl: r.imageUrl,
				fit: coerceImageFit(r.fit) ?? ImageFit.Contain,
			};
			if (typeof r.alt === "string") node.alt = r.alt;
			return node;
		}
		case NodeKind.Frame:
			return {
				...base,
				kind: NodeKind.Frame,
				title: typeof r.title === "string" ? r.title : typeof r.text === "string" ? r.text : "",
				colorHint: nullableString(r.colorHint),
			};
		case NodeKind.Group:
			return {
				...base,
				kind: NodeKind.Group,
				memberIds: Array.isArray(r.memberIds)
					? r.memberIds.filter((m): m is string => typeof m === "string")
					: [],
				colorHint: nullableString(r.colorHint),
			};
		case NodeKind.Embedded: {
			if (typeof r.entityRef !== "string" || r.entityRef === "") return null;
			return { ...base, kind: NodeKind.Embedded, entityRef: r.entityRef };
		}
		case NodeKind.Shape:
			return {
				...base,
				kind: NodeKind.Shape,
				shape: coerceShapeKind(r.shape) ?? ShapeKind.Rectangle,
				color: coerceStickyColor(r.color) ?? StickyColor.Blue,
			};
		case NodeKind.Ink: {
			// A stroke with too few valid points can't render — drop the node
			// (mirrors Image's missing-url drop) rather than keep an empty box.
			const points = coerceInkPoints(r.points);
			if (!points) return null;
			return {
				...base,
				kind: NodeKind.Ink,
				points,
				color: coerceStickyColor(r.color) ?? StickyColor.Gray,
			};
		}
	}
}

/** The text body shared by Sticky / Text (9.17.12 rest): rich runs win when
 *  valid + actually styled (the plain `text` mirror is recomputed from them
 *  so a desynced mirror from a sync conflict self-heals); otherwise the
 *  plain `text` alone, with the unstyled/absent/bad `rich` omitted. */
function textBodyFields(r: Record<string, unknown>): { text: string; rich?: RichRun[] } {
	const rich = coerceRichRuns(r.rich);
	if (rich && !isPlainRuns(rich)) return { text: richToPlain(rich), rich };
	return { text: typeof r.text === "string" ? r.text : "" };
}

/** The optional text-style fields shared by Sticky / Text (9.17.12). Each is
 *  included only when valid + present, so absent/bad values stay omitted on
 *  read (and the renderer falls back to the theme default). */
function textStyleFields(r: Record<string, unknown>): {
	textSize?: TextSize;
	textColor?: TextColor;
	fontFamily?: FontFamily;
	bold?: boolean;
	italic?: boolean;
} {
	const size = coerceTextSize(r.textSize);
	const color = coerceTextColor(r.textColor);
	const font = coerceFontFamily(r.fontFamily);
	return {
		...(size ? { textSize: size } : {}),
		...(color && color !== TextColor.Default ? { textColor: color } : {}),
		...(font && font !== FontFamily.Sans ? { fontFamily: font } : {}),
		...(r.bold === true ? { bold: true } : {}),
		...(r.italic === true ? { italic: true } : {}),
	};
}

function coerceStickyColor(v: unknown): StickyColor | null {
	return coerceEnum(v, STICKY_COLORS);
}

function coerceTextFormat(v: unknown): TextBlockFormat | null {
	return coerceEnum(v, TEXT_BLOCK_FORMATS);
}

function coerceImageFit(v: unknown): ImageFit | null {
	return coerceEnum(v, IMAGE_FITS);
}

/**
 * Legacy stickies stored an ad-hoc CSS hex in `colorHint`. Map the demo
 * palette's hexes back onto the discrete swatch; anything unrecognised
 * falls through so the caller defaults to Yellow rather than nulling.
 */
function mapLegacyColorHint(v: unknown): StickyColor | null {
	if (typeof v !== "string") return null;
	switch (v.toLowerCase()) {
		case "#f6cd6b":
		case "#fde68a":
			return StickyColor.Yellow;
		case "#a3d9a5":
		case "#bbf7d0":
			return StickyColor.Green;
		case "#9ec5fe":
		case "#bfdbfe":
			return StickyColor.Blue;
		case "#f5b5b5":
		case "#fbcfe8":
			return StickyColor.Pink;
		case "#9374c8":
		case "#ddd6fe":
			return StickyColor.Purple;
		case "#e5e7eb":
			return StickyColor.Gray;
		default:
			return null;
	}
}

function coerceHandleSide(v: unknown): HandleSide | null {
	return coerceEnum(v, HANDLE_SIDES);
}

function coerceEdgePathKind(v: unknown): EdgePathKind | null {
	return coerceEnum(v, EDGE_PATH_KINDS);
}

function coerceArrowHead(v: unknown): ArrowHead | null {
	return coerceEnum(v, ARROW_HEADS);
}
