/**
 * PixiJS edge renderer — iteration 9.17.5. Replaces the per-frame SVG
 * `<svg>` edge layer (`document.createElementNS` paths + markers +
 * `<text>` labels) with a single GPU `Graphics`/`Container` pass.
 *
 * **Why Pixi:** SVG-in-canvas is a documented Brainstorm perf trap
 * ([[svg-is-a-perf-trap]] / Graph 9.13.5). Every connector was a fresh
 * `<g>` with a hit path, a stroke path, an arrowhead `<marker>` and
 * (when labelled) a `<rect>`+`<text>` — rebuilt on **every** pan/zoom/
 * drag frame. Pixi batches every same-styled stroke into one buffer
 * upload, so the connector layer is O(1) draw calls regardless of edge
 * count, and the camera is a single container transform (no per-edge
 * matrix math).
 *
 * The path math is unchanged: this module consumes the existing pure
 * `logic/edge-path` keystones (`bezierControlPoints`, `stepPolyline­
 * Avoiding`, `polylineMidpoint`, `edgePathMidpoint`) — only the *paint*
 * moved from SVG to the GPU. Edge picking + label editing stay in a thin
 * DOM overlay (`app.ts`), so select/connect/double-click-to-label all
 * keep working against the same geometry.
 *
 * Mirrors the Graph app's `pixi-renderer` shape (`mount` → handles,
 * `paint`, `resize`, frustum cull, fail-open viewport) without importing
 * cross-app — the equivalent is re-implemented here for the rect-board.
 */

// Pixi 8 generates per-shader uniform-sync code through `new Function(...)`
// at runtime. Sandboxed app renderers run under `script-src 'self'` (see
// src/index.html CSP) which forbids `unsafe-eval`, so the default path
// throws "Current environment does not allow unsafe-eval" the instant a
// WebGL renderer is constructed. Pixi ships a drop-in interpreted adapter;
// this import is side-effects only and MUST run before `new Application()`.
import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Text } from "pixi.js";

import {
	DEFAULT_CULL_MARGIN_PX,
	type ViewBounds,
	computeViewBounds,
	segmentInView,
	viewportUsable,
} from "@brainstorm-os/sdk/frustum-cull";
import { polylineMidpoint } from "../logic/edge-path";
import type { Point } from "../logic/handle-positions";
import { ArrowHead } from "../types/edge";
import { type EdgeRenderInput, cssColorToNumber, edgePolyline } from "./edge-geometry";

export type { EdgeRenderInput } from "./edge-geometry";
export { cssColorToNumber } from "./edge-geometry";

/** The board camera — identical inversion to `app.ts`'s
 *  `screenToCanvas` (`world = (screen - pan) / zoom`). */
export type BoardCamera = {
	zoom: number;
	pan: { x: number; y: number };
};

/** The in-progress connector-authoring drag (9.17.6) — drawn dashed from
 *  the source handle to the live pointer. */
export type GhostEdgeInput = {
	from: Point;
	to: Point;
};

export type EdgeSnapshot = {
	camera: BoardCamera;
	edges: readonly EdgeRenderInput[];
	ghost: GhostEdgeInput | null;
	/** The currently-selected connector (9.17.16) — drawn thicker in the
	 *  accent colour so the styling target is unambiguous. */
	selectedEdgeId?: string | null;
	/** In-progress freehand pen stroke (9.17.9), canvas-space points — drawn
	 *  as a live preview polyline on the ghost layer. */
	inkGhost?: readonly Point[] | null;
};

export type PixiEdgeHandles = {
	app: Application;
	canvas: HTMLCanvasElement;
	container: HTMLElement;
	/** Camera transform lives on this — `scale.set(zoom)` +
	 *  `position.set(pan.x, pan.y)`. */
	world: Container;
	/** Every connector stroke + arrowhead, cleared/redrawn per frame
	 *  (one buffer upload, cheaper than N `Graphics`). */
	edges: Graphics;
	/** The dashed authoring ghost — its own `Graphics` so it can be
	 *  cleared independently of the committed edges. */
	ghost: Graphics;
	/** Edge-label pills live as Pixi `Text` + a backing `Graphics`. Text
	 *  is the least-batchable primitive but label counts are tiny
	 *  (≪ node counts); kept in a map so they're updated in place, not
	 *  rebuilt every frame. */
	labels: Container;
	labelText: Map<string, Text>;
	labelBg: Graphics;
	/** Resolved theme colours, refreshed on `resize` (theme can change
	 *  under the app via the shell stylesheet). */
	colors: { edge: number; text: number; bg: number; accent: number };
	viewWidth: number;
	viewHeight: number;
	lastCull: { visible: number; culled: number };
};

const LABEL_FONT_SIZE = 12;
const ARROW_LEN = 10;
const ARROW_HALF = 5;

/** Read the live theme tokens off the document so the GPU paint tracks
 *  the shell's injected stylesheet (light/dark, accent). Falls back to a
 *  neutral set when computed style is unavailable (jsdom / detached). */
function resolveThemeColors(host: HTMLElement): PixiEdgeHandles["colors"] {
	const fallback = { edge: 0x8a93a6, text: 0x1e293b, bg: 0xffffff, accent: 0x6b73f0 };
	if (typeof getComputedStyle !== "function") return fallback;
	try {
		const cs = getComputedStyle(host);
		const read = (name: string, fb: number): number => {
			const raw = cs.getPropertyValue(name).trim();
			return raw ? cssColorToNumber(raw, fb) : fb;
		};
		return {
			edge: read("--edge", fallback.edge),
			text: read("--text", fallback.text),
			bg: read("--bg", fallback.bg),
			accent: read("--accent", fallback.accent),
		};
	} catch {
		return fallback;
	}
}

/** Initialise a Pixi app under `container`. Async because Pixi 8's
 *  `Application.init` returns a promise (it picks WebGL/WebGPU + primes
 *  GPU resources). The caller awaits this once before the first paint. */
export async function mountPixiEdges(
	container: HTMLElement,
	width: number,
	height: number,
): Promise<PixiEdgeHandles> {
	const app = new Application();
	await app.init({
		width: Math.max(1, width),
		height: Math.max(1, height),
		backgroundAlpha: 0,
		antialias: true,
		preference: "webgl",
		powerPreference: "high-performance",
		resolution: Math.max(1, (typeof window !== "undefined" && window.devicePixelRatio) || 1),
		autoDensity: true,
	});
	const canvas = app.canvas as HTMLCanvasElement;
	canvas.className = "whiteboard__edges whiteboard__edges--pixi";
	canvas.style.position = "absolute";
	canvas.style.inset = "0";
	canvas.style.width = "100%";
	canvas.style.height = "100%";
	canvas.style.pointerEvents = "none";
	canvas.style.display = "block";
	// The HTML node layer (`.whiteboard__canvas`, z-index:1) takes a
	// runtime `transform`, which makes it its own stacking context. A
	// WebGL canvas is composited on its own layer; left at `z-index:auto`
	// it paints in the "positioned, z-index:auto" group and the cleared
	// (opaque) GL surface can composite ON TOP of the transformed node
	// layer — nodes read as blank black boxes and connectors vanish (the
	// 9.17.5 regression). Pin the connector canvas strictly below the node
	// layer so the order is unconditional, never inferred from the
	// transform-induced context. `backgroundAlpha:0` keeps it transparent;
	// the explicit negative z-index keeps it under the nodes regardless.
	canvas.style.zIndex = "-1";
	canvas.style.background = "transparent";
	container.appendChild(canvas);

	const world = new Container();
	app.stage.addChild(world);
	const edges = new Graphics();
	const ghost = new Graphics();
	const labelBg = new Graphics();
	const labels = new Container();
	world.addChild(edges, ghost, labelBg, labels);

	return {
		app,
		canvas,
		container,
		world,
		edges,
		ghost,
		labels,
		labelText: new Map(),
		labelBg,
		colors: resolveThemeColors(container),
		viewWidth: width,
		viewHeight: height,
		lastCull: { visible: 0, culled: 0 },
	};
}

/** Resize the renderer in step with the container + re-read the theme
 *  (the shell can swap the stylesheet under us). */
export function resizePixiEdges(h: PixiEdgeHandles, width: number, height: number): void {
	h.app.renderer.resize(Math.max(1, width), Math.max(1, height));
	h.viewWidth = width;
	h.viewHeight = height;
	h.colors = resolveThemeColors(h.container);
}

/** The stroked polyline + the label anchor (its arc-length midpoint).
 *  Geometry comes from the shared pure `edgePolyline` so the GPU paint,
 *  the geometric edge-picker and the label all walk the same line. */
function edgeGeometry(input: EdgeRenderInput): { poly: Point[]; mid: Point } {
	const poly = edgePolyline(input);
	return { poly, mid: polylineMidpoint(poly) };
}

/** Draw an arrowhead at `tip`, pointing along the incoming direction
 *  `(dx, dy)`. Shapes mirror the old SVG markers (arrow / dot / box /
 *  diamond) so the visual is unchanged. */
function drawArrowHead(
	g: Graphics,
	tip: Point,
	dx: number,
	dy: number,
	head: ArrowHead,
	color: number,
): void {
	const len = Math.hypot(dx, dy) || 1;
	const ux = dx / len;
	const uy = dy / len;
	// Perpendicular unit.
	const px = -uy;
	const py = ux;
	const back = { x: tip.x - ux * ARROW_LEN, y: tip.y - uy * ARROW_LEN };

	switch (head) {
		case ArrowHead.Arrow: {
			g.moveTo(tip.x, tip.y)
				.lineTo(back.x + px * ARROW_HALF, back.y + py * ARROW_HALF)
				.lineTo(back.x - px * ARROW_HALF, back.y - py * ARROW_HALF)
				.lineTo(tip.x, tip.y)
				.fill(color);
			break;
		}
		case ArrowHead.Dot: {
			g.circle(back.x, back.y, ARROW_HALF).fill(color);
			break;
		}
		case ArrowHead.Box: {
			const c = { x: back.x, y: back.y };
			g.poly([
				c.x + (px - ux) * ARROW_HALF,
				c.y + (py - uy) * ARROW_HALF,
				c.x + (px + ux) * ARROW_HALF,
				c.y + (py + uy) * ARROW_HALF,
				c.x + (-px + ux) * ARROW_HALF,
				c.y + (-py + uy) * ARROW_HALF,
				c.x + (-px - ux) * ARROW_HALF,
				c.y + (-py - uy) * ARROW_HALF,
			]).fill(color);
			break;
		}
		case ArrowHead.Diamond: {
			const c = { x: back.x, y: back.y };
			g.poly([
				tip.x,
				tip.y,
				c.x + px * ARROW_HALF,
				c.y + py * ARROW_HALF,
				c.x - ux * ARROW_LEN,
				c.y - uy * ARROW_LEN,
				c.x - px * ARROW_HALF,
				c.y - py * ARROW_HALF,
			]).fill(color);
			break;
		}
		case ArrowHead.None:
			break;
	}
}

function strokePoly(g: Graphics, poly: readonly Point[], color: number, width: number): void {
	if (poly.length < 2) return;
	const first = poly[0] as Point;
	g.moveTo(first.x, first.y);
	for (let i = 1; i < poly.length; i++) {
		const p = poly[i] as Point;
		g.lineTo(p.x, p.y);
	}
	g.stroke({ color, width, cap: "round", join: "round" });
}

const DASH_ON = 9;
const DASH_OFF = 6;

/** Stroke a dashed polyline (9.17.16). Pixi has no native dash array, so we
 *  emit each dash as its own `moveTo`/`lineTo` sub-path and stroke them all
 *  in one call. The on/off phase carries **across** segment joints so the
 *  pattern stays continuous around the polyline's corners (a per-segment
 *  reset would clump dashes at every bend). */
function strokeDashedPoly(g: Graphics, poly: readonly Point[], color: number, width: number): void {
	if (poly.length < 2) return;
	let drawing = true;
	let remaining = DASH_ON;
	for (let i = 1; i < poly.length; i++) {
		const a = poly[i - 1] as Point;
		const b = poly[i] as Point;
		const segLen = Math.hypot(b.x - a.x, b.y - a.y);
		if (segLen === 0) continue;
		const ux = (b.x - a.x) / segLen;
		const uy = (b.y - a.y) / segLen;
		let pos = 0;
		while (pos < segLen) {
			const step = Math.min(remaining, segLen - pos);
			if (drawing) {
				g.moveTo(a.x + ux * pos, a.y + uy * pos);
				g.lineTo(a.x + ux * (pos + step), a.y + uy * (pos + step));
			}
			pos += step;
			remaining -= step;
			if (remaining <= 0) {
				drawing = !drawing;
				remaining = drawing ? DASH_ON : DASH_OFF;
			}
		}
	}
	g.stroke({ color, width, cap: "butt", join: "round" });
}

/** Approximate label-pill width — matches the old SVG heuristic
 *  (`len * 7 + 12`) so layout doesn't shift across the renderer swap. */
function labelPillWidth(label: string): number {
	return label.length * 7 + 12;
}

/** Repaint every connector + the authoring ghost + labels. O(edges)
 *  property writes; Pixi batches the actual GL draw at end-of-tick.
 *  Frustum-culls against the LIVE canvas size (never a stale cached
 *  value — that is the recurring "things disappeared" bug); when the
 *  viewport isn't trustworthy yet it fails open and draws everything. */
export function paintPixiEdges(h: PixiEdgeHandles, snap: EdgeSnapshot): void {
	const { zoom, pan } = snap.camera;
	h.world.scale.set(zoom);
	h.world.position.set(pan.x, pan.y);

	const vw = h.canvas.clientWidth;
	const vh = h.canvas.clientHeight;
	const bounds: ViewBounds | null = viewportUsable(vw, vh)
		? computeViewBounds({ k: zoom, tx: pan.x, ty: pan.y }, vw, vh, DEFAULT_CULL_MARGIN_PX)
		: null;

	h.edges.clear();
	h.labelBg.clear();
	let visible = 0;
	let culled = 0;
	const liveLabelIds = new Set<string>();

	for (const input of snap.edges) {
		const { poly, mid } = edgeGeometry(input);
		if (poly.length < 2) continue;

		// Cull: keep the edge if ANY segment's bounding box clips the view
		// (cheap superset — never drops an edge that crosses the screen).
		let onScreen = bounds === null;
		if (!onScreen) {
			for (let i = 1; i < poly.length && !onScreen; i++) {
				const a = poly[i - 1] as Point;
				const b = poly[i] as Point;
				if (segmentInView(a.x, a.y, b.x, b.y, bounds as ViewBounds)) onScreen = true;
			}
		}
		if (!onScreen) {
			culled++;
			continue;
		}
		visible++;

		const selected = snap.selectedEdgeId != null && snap.selectedEdgeId === input.edge.id;
		const color = selected
			? h.colors.accent
			: input.edge.colorHint != null
				? cssColorToNumber(input.edge.colorHint, h.colors.edge)
				: h.colors.edge;
		const width = selected ? 3 : 2;
		if (input.edge.dashed) strokeDashedPoly(h.edges, poly, color, width);
		else strokePoly(h.edges, poly, color, width);

		if (input.edge.arrowHead !== ArrowHead.None && poly.length >= 2) {
			const tip = poly[poly.length - 1] as Point;
			const prev = poly[poly.length - 2] as Point;
			drawArrowHead(h.edges, tip, tip.x - prev.x, tip.y - prev.y, input.edge.arrowHead, color);
		}

		// Source-end arrowhead (9.17.16 bidirectional) — points back along the
		// first segment, away from the second point.
		const srcHead = input.edge.sourceArrowHead;
		if (srcHead && srcHead !== ArrowHead.None && poly.length >= 2) {
			const tip = poly[0] as Point;
			const next = poly[1] as Point;
			drawArrowHead(h.edges, tip, tip.x - next.x, tip.y - next.y, srcHead, color);
		}

		const label = input.edge.label;
		if (label) {
			liveLabelIds.add(input.edge.id);
			const w = labelPillWidth(label);
			const ht = 18;
			h.labelBg
				.roundRect(mid.x - w / 2, mid.y - ht / 2, w, ht, 4)
				.fill({ color: h.colors.bg })
				.stroke({ color: h.colors.edge, width: 1 });
			let text = h.labelText.get(input.edge.id);
			if (!text) {
				text = new Text({
					text: label,
					style: {
						fontSize: LABEL_FONT_SIZE,
						fill: h.colors.text,
						fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
						align: "center",
					},
				});
				text.anchor.set(0.5);
				h.labels.addChild(text);
				h.labelText.set(input.edge.id, text);
			}
			if (text.text !== label) text.text = label;
			text.style.fill = h.colors.text;
			text.position.set(mid.x, mid.y);
			text.visible = true;
		}
	}

	// Hide (don't destroy — reused next frame) label texts whose edge is
	// gone or no longer labelled.
	for (const [id, text] of h.labelText) {
		if (!liveLabelIds.has(id)) text.visible = false;
	}

	h.ghost.clear();
	if (snap.ghost) {
		strokePoly(h.ghost, [snap.ghost.from, snap.ghost.to], h.colors.edge, 2);
		h.ghost.stroke({ color: h.colors.edge, width: 2, alpha: 0.55 });
	}
	// Live freehand pen stroke (9.17.9) — the accent polyline the user is
	// drawing, before it's committed to an ink node.
	if (snap.inkGhost && snap.inkGhost.length >= 2) {
		strokePoly(h.ghost, snap.inkGhost, h.colors.accent, 2);
	}

	h.lastCull = { visible, culled };
	h.canvas.dataset.edgesVisible = String(visible);
	h.canvas.dataset.edgesCulled = String(culled);
}

/** Tear down the Pixi app + GPU resources. Idempotent. */
export function destroyPixiEdges(h: PixiEdgeHandles): void {
	for (const text of h.labelText.values()) text.destroy();
	h.labelText.clear();
	h.app.destroy(true, { children: true, texture: true });
	h.canvas.remove();
}
