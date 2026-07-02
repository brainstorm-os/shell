/**
 * PixiJS renderer — the high-performance path that replaces the SVG
 * renderer at iteration 9.13.5. Mirrors `svg-renderer.ts`'s public
 * `Snapshot` shape and `mount/paint/resize` surface so the rest of the
 * app is renderer-agnostic.
 *
 * **Why Pixi:** SVG's per-node DOM cost caps the renderer at ~500
 * connected nodes before paint latency blows past one frame (16 ms). Pixi
 * batches every same-textured sprite into a single GL draw call, so
 * `N nodes × 1 texture = 1 draw call` regardless of `N`. The same goes
 * for edges — a single `Graphics` is one buffer, drawn once. Headroom
 * jumps from ~500 to 10k+ on commodity hardware.
 *
 * **Architectural decisions** (OQ-GR-4 partial resolution — (a) pixi+d3
 * on main thread as the first cut, (b) move to worker once main-thread
 * latency on 10k nodes is measurable):
 *
 *   - **Single sprite-atlas texture for nodes.** One white 64×64 circle
 *     is rendered into a GPU texture at mount time; every node sprite
 *     reuses it and applies a per-instance `tint` for colour. Memory is
 *     O(1) in node count.
 *   - **One Graphics for edges.** Cheaper than per-edge `Graphics` objects
 *     (one buffer upload instead of N). Rebuilt only when the world-space
 *     geometry actually changes (`geometryDirty`); a pure zoom/pan reuses
 *     the cached buffer and lets the camera transform move it for free.
 *   - **HTML labels overlay (Pixi `Text` deferred).** Text is the
 *     least-batchable Pixi primitive and we already gate it at
 *     `MAX_LABELED_NODES = 150`. The overlay sits above the canvas in
 *     world-to-screen coords driven by the same `CameraTransform`. This
 *     also keeps font selection inheriting from the shell theme tokens —
 *     no Pixi-side font registration needed.
 *   - **Camera lives on the stage container.** Pixi's `stage.scale` +
 *     `stage.position` ARE the viewport transform — no per-sprite math.
 *
 * The async `mountPixi` (Pixi 8 requires `await app.init`) is the only
 * shape change from the SVG renderer. `app.ts` awaits the mount before
 * starting the animation loop.
 */

// Pixi 8 generates per-shader uniform sync code through `new Function(...)`
// at runtime. Electron's sandboxed app renderers run with the default CSP
// (`script-src 'self'`) that forbids `unsafe-eval`, so the default path
// throws "Current environment does not allow unsafe-eval" the moment a
// WebGL renderer is constructed. Pixi ships a drop-in adapter that swaps
// the codegen for an interpreted walker — slightly slower per-uniform but
// the only viable path inside a sandboxed renderer. This import has
// side-effects only and MUST run before `new Application()`.
import "pixi.js/unsafe-eval";
import {
	Application,
	Container,
	Graphics,
	type Renderer as PixiRenderer,
	Sprite,
	Text,
	Texture,
} from "pixi.js";

import {
	type ViewBounds,
	computeViewBounds,
	nodeInView,
	viewportUsable,
} from "@brainstorm/sdk/frustum-cull";
import { IconKind } from "../types/icon";
import { type EdgeGeometryInput, buildEdgeBatches } from "./edge-batch";
import type { LayoutNode } from "./force-layout";
import { loadIconImage } from "./icon-source";
import { type LabelBox, declutterLabels, estimateLabelWidth } from "./label-declutter";
import { NodeFront, chooseNodeFront } from "./node-front";
import { nodeLabel } from "./node-label";
import {
	ARROW_HIDE_BELOW_K,
	type CameraTransform,
	DETAIL_THRESHOLD_K,
	HOVER_DIM_ALPHA,
	HUB_LABEL_COUNT,
	MAX_LABELED_NODES,
	type RenderEdge,
	type RenderNode,
	type Snapshot,
} from "./svg-renderer";

/** Re-export the constants the app layer reads so callers can choose
 *  either renderer without separate imports. */
export { ARROW_HIDE_BELOW_K, DETAIL_THRESHOLD_K, HOVER_DIM_ALPHA, MAX_LABELED_NODES };

/** Real icon textures appear at half-zoom and up — the same threshold
 *  arrowheads use. A crisp icon reads at small screen size where the
 *  rasterised emoji-text glyph (gated at `DETAIL_THRESHOLD_K`) wouldn't,
 *  so icons reveal earlier than the glyph fallback. */
export const ICON_THRESHOLD_K = 0.5;

/** Width/height in pixels of the shared circle texture. Higher = smoother
 *  edges when a node is zoomed in; lower = less GPU memory per atlas
 *  slot. 64 balances both. */
const CIRCLE_TEX_SIZE = 64;

/** Font size the per-glyph texture is rasterised at. Each unique glyph
 *  string (a handful of emoji + ~8 monochrome type fallbacks) is rendered
 *  once at this size and every node carrying that glyph reuses the texture
 *  scaled to its node radius — so glyph memory is O(distinct glyphs), not
 *  O(nodes). 96 keeps it crisp when a hub node is zoomed in. */
const GLYPH_TEX_FONT_SIZE = 96;

/** Convert a CSS color string to a 24-bit RGB number Pixi's `.tint`
 *  accepts. Handles hex (`#a78bfa`, `#fff`) and `rgb(r,g,b)`. `rgba(...)`
 *  alpha is dropped — the sprite's own `.alpha` carries opacity. Unknown
 *  shapes return white (no tint), which keeps the underlying texture's
 *  colour from disappearing — better than a missing or transparent node. */
// A given colour string always resolves to the same tint/alpha, and the
// distinct-colour set is tiny (≈one per entity type + theme). Parsing it via
// regex/`parseInt` for every node + every edge on every painted frame was the
// dominant per-frame allocation during drag/pan/zoom — memoise instead.
const tintCache = new Map<string, number>();
const alphaCache = new Map<string, number>();

function colorToTint(color: string): number {
	const cached = tintCache.get(color);
	if (cached !== undefined) return cached;
	const value = computeColorToTint(color);
	tintCache.set(color, value);
	return value;
}

function computeColorToTint(color: string): number {
	const trimmed = color.trim();
	if (trimmed.startsWith("#")) {
		const hex = trimmed.slice(1);
		if (hex.length === 3) {
			const r = Number.parseInt(hex[0] ?? "0", 16);
			const g = Number.parseInt(hex[1] ?? "0", 16);
			const b = Number.parseInt(hex[2] ?? "0", 16);
			return r * 17 * 0x10000 + g * 17 * 0x100 + b * 17;
		}
		if (hex.length === 6) {
			return Number.parseInt(hex, 16);
		}
	}
	const rgb = trimmed.match(/rgba?\(([^)]+)\)/);
	if (rgb) {
		const parts = (rgb[1] ?? "").split(",").map((p) => Number(p.trim()));
		const r = Math.max(0, Math.min(255, parts[0] ?? 0));
		const g = Math.max(0, Math.min(255, parts[1] ?? 0));
		const b = Math.max(0, Math.min(255, parts[2] ?? 0));
		return (r << 16) | (g << 8) | b;
	}
	return 0xffffff;
}

/** Extract a 0..1 alpha out of an `rgba()` color, falling back to 1
 *  when the colour has no alpha channel. Used so the per-node "fade"
 *  reads correctly even for unmatched-grey colours that ship their
 *  desaturation as alpha (e.g. `rgba(180, 190, 210, 0.45)`). */
function colorAlpha(color: string): number {
	const cached = alphaCache.get(color);
	if (cached !== undefined) return cached;
	const value = computeColorAlpha(color);
	alphaCache.set(color, value);
	return value;
}

function computeColorAlpha(color: string): number {
	const m = color.match(/rgba?\(([^)]+)\)/);
	if (!m) return 1;
	const parts = (m[1] ?? "").split(",").map((p) => Number(p.trim()));
	return parts.length >= 4 ? Math.max(0, Math.min(1, parts[3] ?? 1)) : 1;
}

export type PixiHandles = {
	/** Public `mountPixi` returns this so the rest of the app keeps a
	 *  renderer-agnostic handle. The `canvas` is the same DOM element
	 *  Pixi paints to; pointer event listeners go on it. */
	canvas: HTMLCanvasElement;
	/** Container the user passed in — kept so resize can re-measure. */
	container: HTMLElement;
	/** Labels live as plain DOM nodes layered over the canvas. One
	 *  `<div>` per visible label, positioned in screen-space. Cheap to
	 *  hide / show via `display: none`; far easier to style consistently
	 *  with the shell theme than Pixi `Text`. */
	labelsLayer: HTMLDivElement;
	app: Application;
	/** Stage-level container that holds nodes + edges. The camera
	 *  transform lives on this — `stage.scale.set(k)` + `stage.position.set(tx, ty)`. */
	worldContainer: Container;
	edgesGraphics: Graphics;
	nodesContainer: Container;
	/** Glyph sprites live in their own container layered above the discs
	 *  so a glyph node reads on top of any overlapping disc. In practice a
	 *  node draws disc XOR glyph (the disc is hidden when its glyph shows),
	 *  mirroring the SVG renderer. */
	glyphsContainer: Container;
	/** One reusable circle texture, tinted per-node. The texture's owner
	 *  is the Pixi app — destroying the app destroys it. */
	circleTexture: Texture;
	/** Glyph string → rasterised texture, built lazily on first use and
	 *  shared by every node carrying that glyph. Bounded by the small
	 *  distinct-glyph alphabet (emoji + type fallbacks). */
	glyphTextures: Map<string, Texture>;
	/** Per-node glyph sprite, kept in step with `nodeSprites`. */
	glyphSprites: Map<string, Sprite>;
	/** Per-node sprite map. The sprite carries `data.nodeId` so pointer
	 *  hit-testing can identify the picked node without an O(N) scan. */
	nodeSprites: Map<string, Sprite>;
	/** Resolved icon textures, keyed by `iconSrc` (Emoji/Image) or
	 *  `iconSrc|colour` (Pack — the recolour is baked into the bitmap).
	 *  O(distinct icons), shared by every node carrying that icon. */
	iconTextures: Map<string, Texture>;
	/** Icon cache keys whose async load is in flight, so a node painted
	 *  every frame kicks the fetch once, not once per frame. */
	iconLoading: Set<string>;
	/** Called when an icon texture finishes loading. The render loop is
	 *  change-gated (it doesn't repaint an idle graph), so a late texture
	 *  would never appear without an explicit nudge. Defaults to no-op. */
	onInvalidate: () => void;
	/** Per-node label element so `paintPixi` can update text in place
	 *  rather than rebuilding the layer every frame. */
	labelDivs: Map<string, HTMLDivElement>;
	/** Cached width/height for hit-test math. Refreshed on resize. */
	viewWidth: number;
	viewHeight: number;
	/** Last-frame frustum-cull tally — how many of `renderNodes` fell
	 *  inside vs. outside the visible world rect. Mirrored onto the
	 *  canvas dataset for debug/CSS and read by the perf bench. */
	lastCull: { visible: number; culled: number };
	/** Count of edge-`Graphics` rebuilds. A rebuild only happens when the
	 *  world-space edge geometry actually changes — never on a pure zoom/pan
	 *  (see `geometryDirty` on `paintPixi`). Stamped onto the canvas dataset
	 *  so the zoom-paint perf guard can assert it stays flat while zooming. */
	edgeRebuilds: number;
	/** Distinct GL draws the last edge-batch plan collapsed to (one per
	 *  stroke batch + one per arrowhead-fill batch). Batching keeps this
	 *  `O(distinct styles)` — flat in edge count. Stamped onto the canvas
	 *  dataset (`data-edge-draw-calls`) for the perf guard. */
	lastEdgeDrawCalls: number;
};

/** Initialize a Pixi app and mount it under `container`. Async because
 *  Pixi 8's `Application.init` returns a promise (under the hood it
 *  picks a renderer — WebGL or WebGPU — and primes GPU resources). */
export async function mountPixi(
	container: HTMLElement,
	width: number,
	height: number,
	onInvalidate: () => void = () => {},
): Promise<PixiHandles> {
	container.innerHTML = "";
	const app = new Application();
	await app.init({
		width,
		height,
		backgroundAlpha: 0,
		// Antialias smooths circle edges so a sprite-atlas disc doesn't
		// look jagged at non-1x zoom. Costs a small amount of GPU fill;
		// negligible for our node counts.
		antialias: true,
		// WebGL is the most-supported renderer. WebGPU would be a small
		// win on supporting browsers but at the cost of fallback complexity.
		preference: "webgl",
		// `powerPreference` hints to the OS to use the discrete GPU on
		// laptops; harmless on desktops.
		powerPreference: "high-performance",
		// HiDPI: lock to device pixel ratio so retina renders crisp.
		resolution: Math.max(1, window.devicePixelRatio || 1),
		autoDensity: true,
	});
	app.canvas.className = "graph-canvas graph-canvas--pixi";
	app.canvas.style.touchAction = "none";
	app.canvas.style.display = "block";
	app.canvas.style.width = "100%";
	app.canvas.style.height = "100%";
	container.style.position = container.style.position || "relative";
	container.appendChild(app.canvas);

	const labelsLayer = document.createElement("div");
	labelsLayer.className = "graph-canvas__labels-overlay";
	labelsLayer.style.position = "absolute";
	labelsLayer.style.inset = "0";
	labelsLayer.style.pointerEvents = "none";
	labelsLayer.style.overflow = "hidden";
	container.appendChild(labelsLayer);

	const worldContainer = new Container();
	app.stage.addChild(worldContainer);
	const edgesGraphics = new Graphics();
	worldContainer.addChild(edgesGraphics);
	const nodesContainer = new Container();
	// Pixi batches same-texture sprites in this container into one draw
	// call. Frustum culling is ours (see `frustum.ts`): an off-screen
	// node never gets a sprite created, so Pixi's per-object `cullable`
	// pass would be redundant work on top.
	worldContainer.addChild(nodesContainer);
	const glyphsContainer = new Container();
	worldContainer.addChild(glyphsContainer);

	const circleTexture = createCircleTexture(app.renderer);

	return {
		canvas: app.canvas as HTMLCanvasElement,
		container,
		labelsLayer,
		app,
		worldContainer,
		edgesGraphics,
		nodesContainer,
		glyphsContainer,
		circleTexture,
		glyphTextures: new Map(),
		glyphSprites: new Map(),
		nodeSprites: new Map(),
		iconTextures: new Map(),
		iconLoading: new Set(),
		onInvalidate,
		labelDivs: new Map(),
		viewWidth: width,
		viewHeight: height,
		lastCull: { visible: 0, culled: 0 },
		edgeRebuilds: 0,
		lastEdgeDrawCalls: 0,
	};
}

/** Generate a white circle texture once at mount time; every node
 *  sprite reuses it and tints per-node. White fill means the tint
 *  multiplier produces the exact colour requested — a coloured-fill
 *  texture would multiply on top of the existing colour and shift hues. */
function createCircleTexture(renderer: PixiRenderer): Texture {
	const radius = CIRCLE_TEX_SIZE / 2;
	const g = new Graphics();
	g.circle(radius, radius, radius - 1).fill(0xffffff);
	const texture = renderer.generateTexture({
		target: g,
		// Square texture lets pixi clamp easily; resolution at 2 keeps
		// the disc crisp on retina.
		resolution: 2,
		// Antialiased fill — pairs with `app.init({antialias: true})`.
		antialias: true,
	});
	g.destroy();
	return texture;
}

/** Rasterise a single glyph string to a texture once and cache it. Fill
 *  is white so monochrome type-fallback glyphs (`●` / `◉`) read on dark
 *  surfaces; colour-emoji fonts ignore `fill` and keep their native
 *  colours — matching the SVG renderer, which also left emoji untinted.
 *  No per-node `tint` is applied to glyph sprites for the same reason
 *  (tinting would distort colour emoji). */
function getGlyphTexture(handles: PixiHandles, glyph: string): Texture {
	const cached = handles.glyphTextures.get(glyph);
	if (cached) return cached;
	const text = new Text({
		text: glyph,
		style: {
			fontSize: GLYPH_TEX_FONT_SIZE,
			fill: 0xffffff,
			// Pixi `Text` rasterises through canvas 2D, where a CSS custom
			// property wouldn't resolve — a concrete system stack keeps the
			// monochrome fallback glyphs predictable; colour emoji resolve
			// through the platform emoji font regardless.
			fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
			align: "center",
		},
	});
	const texture = handles.app.renderer.generateTexture({
		target: text,
		resolution: 2,
		antialias: true,
	});
	text.destroy();
	handles.glyphTextures.set(glyph, texture);
	return texture;
}

/** Resize the canvas + Pixi renderer in step with the container.
 *  Refreshes the cached width/height so label-overlay math reads the
 *  current canvas size. */
export function resizePixi(handles: PixiHandles, width: number, height: number): void {
	handles.app.renderer.resize(width, height);
	handles.viewWidth = width;
	handles.viewHeight = height;
}

/** Tear down the renderer's GPU + DOM resources on window close — an
 *  un-destroyed app leaves a live WebGL context + thousands of resident
 *  sprites while the renderer process tears down (the close stall).
 *
 *  Crucially this does NOT pass `{ texture: true }` to `app.destroy`: every
 *  node sprite shares the single `circleTexture`, so a per-sprite texture
 *  destroy would free that one texture thousands of times — a double-free
 *  that hard-crashes the renderer process on close. Instead we destroy the
 *  app (which tears down the WebGL context + sprites and frees their GPU
 *  memory), then destroy the handful of generated/shared textures exactly
 *  once each. Idempotent + fully guarded: close must never throw. */
export function destroyPixi(handles: PixiHandles): void {
	try {
		handles.app.destroy({ removeView: true }, { children: true, texture: false });
	} catch {
		/* already gone */
	}
	const destroyOnce = (tex: Texture): void => {
		try {
			tex.destroy(true);
		} catch {
			/* already destroyed by the app teardown */
		}
	};
	destroyOnce(handles.circleTexture);
	for (const tex of handles.glyphTextures.values()) destroyOnce(tex);
	for (const tex of handles.iconTextures.values()) destroyOnce(tex);
	handles.glyphTextures.clear();
	handles.iconTextures.clear();
	handles.iconLoading.clear();
	handles.nodeSprites.clear();
	handles.glyphSprites.clear();
	try {
		handles.labelsLayer.remove();
	} catch {
		/* not mounted */
	}
}

/** Update positions + tints + camera. O(nodes + edges) DOM-equivalent
 *  ops per call, but every node sprite update is just a property write —
 *  Pixi batches the draw at end-of-tick.
 *
 *  `geometryDirty` (default true) says whether anything that changes
 *  WORLD-SPACE geometry happened since the last paint — node positions
 *  (sim/drag), the edge set or its colours/dim (scene/hover/focus), or the
 *  arrowhead LOD flag. On a pure zoom/pan it is FALSE: the node + edge
 *  geometry is identical in world space and the camera transform on
 *  `worldContainer` already moves it on the GPU, so rebuilding the edge
 *  `Graphics` (a full re-tessellation + buffer re-upload every frame) is
 *  pure waste — the dominant per-frame cost during zoom/pan. We skip it. */
export function paintPixi(handles: PixiHandles, snapshot: Snapshot, geometryDirty = true): void {
	applyCameraTransform(handles, snapshot.transform);
	// Cull against the LIVE canvas size, never the cached `viewWidth`
	// (that lags — it's seeded from layout defaults and only corrected on
	// a ResizeObserver *change*, so the first frames after mount/fit cull
	// against the wrong viewport and drop visible nodes → the recurring
	// "icons disappeared" bug). When the live size isn't trustworthy yet
	// (0 pre-layout / detached), `bounds` is null and every pass fails
	// open: draw everything. The perf cull only engages once the
	// viewport is real. One rect per frame, shared by all three passes.
	const vw = handles.canvas.clientWidth;
	const vh = handles.canvas.clientHeight;
	const bounds = viewportUsable(vw, vh) ? computeViewBounds(snapshot.transform, vw, vh) : null;
	syncNodeSprites(handles, snapshot, bounds);
	if (geometryDirty) drawEdges(handles, snapshot);
	syncLabelOverlay(handles, snapshot, bounds);
}

function applyCameraTransform(handles: PixiHandles, t: CameraTransform): void {
	handles.worldContainer.scale.set(t.k);
	handles.worldContainer.position.set(t.tx, t.ty);
	// Mirror the LOD breakpoints onto the canvas so anything reading
	// `data-zoom-level` / `data-lod-*` (debug, CSS) still works.
	const canvas = handles.canvas;
	canvas.dataset.zoomLevel = t.k.toFixed(3);
	canvas.dataset.lodArrows = t.k >= ARROW_HIDE_BELOW_K ? "true" : "false";
	canvas.dataset.lodLabels = t.k >= DETAIL_THRESHOLD_K ? "true" : "false";
	canvas.dataset.lodIcons = t.k >= DETAIL_THRESHOLD_K ? "true" : "false";
}

/** Pixi 8 sprite sizing trick — the underlying texture is 64×64 (radius
 *  32 visible), so to render a node at world-radius `r`, the sprite
 *  width/height = `r * 2 * (CIRCLE_TEX_SIZE / (CIRCLE_TEX_SIZE - 2))` to
 *  account for the 1-px AA inset. Close enough at 64 to use `r * 2`. */
function nodeSpriteSize(r: number): number {
	return r * 2;
}

function syncNodeSprites(
	handles: PixiHandles,
	snapshot: Snapshot,
	bounds: ViewBounds | null,
): void {
	const wanted = new Set<string>();
	for (const node of snapshot.renderNodes) wanted.add(node.id);

	// Drop sprites for nodes no longer in the scene.
	for (const [id, sprite] of handles.nodeSprites) {
		if (!wanted.has(id)) {
			handles.nodesContainer.removeChild(sprite);
			sprite.destroy();
			handles.nodeSprites.delete(id);
		}
	}
	for (const [id, glyph] of handles.glyphSprites) {
		if (!wanted.has(id)) {
			handles.glyphsContainer.removeChild(glyph);
			glyph.destroy();
			handles.glyphSprites.delete(id);
		}
	}

	// A node draws ONE front visual instead of its disc (front XOR disc,
	// never stacked — mirrors the SVG renderer): own icon, else the
	// type-glyph fallback, else the plain tinted disc. Icon and glyph
	// fallback share `iconZoom` (see `node-front.ts`); below it colour
	// alone carries identity.
	const iconZoom = snapshot.transform.k >= ICON_THRESHOLD_K;
	const hovered = snapshot.hoveredId;
	let visibleCount = 0;
	let culledCount = 0;
	for (const node of snapshot.renderNodes) {
		const layout = snapshot.nodes.get(node.id);
		if (!layout) continue;
		// Frustum cull: a node outside the visible world rect skips every
		// expensive per-node op (tint/size write, icon-cache probe, glyph
		// texture). The hovered node is always kept so its popover anchor
		// and ring stay correct even mid-pan. An off-screen node that
		// already has a sprite is parked invisible+non-renderable (Pixi
		// skips it in the batch) but not destroyed — re-entering the
		// viewport on a pan is then a single `visible = true`, no realloc.
		if (
			bounds !== null &&
			node.id !== hovered &&
			!nodeInView(layout.x, layout.y, node.radius, bounds)
		) {
			culledCount += 1;
			const parked = handles.nodeSprites.get(node.id);
			if (parked) {
				parked.visible = false;
				parked.renderable = false;
			}
			const parkedGlyph = handles.glyphSprites.get(node.id);
			if (parkedGlyph) {
				parkedGlyph.visible = false;
				parkedGlyph.renderable = false;
			}
			continue;
		}
		visibleCount += 1;
		const iconTexture = iconZoom && node.iconSrc !== "" ? ensureIconTexture(handles, node) : null;
		// Front visual: own icon wins; else the type-glyph fallback — at
		// the SAME zoom as the icon (`iconZoom`), NOT the higher detail
		// zoom. Gating the fallback higher made every icon-less entity a
		// bare disc at fit-zoom (the recurring "icons missing" report).
		// Pure + tested in `node-front.ts`.
		const front = chooseNodeFront({
			iconZoom,
			hasIcon: iconTexture !== null,
			hasGlyph: node.glyph !== "",
		});
		const frontTexture =
			front === NodeFront.Icon
				? iconTexture
				: front === NodeFront.Glyph
					? getGlyphTexture(handles, node.glyph)
					: null;
		const showFront = frontTexture !== null;
		const focusAlpha = snapshot.focusAlphaByNode.get(node.id) ?? 1;

		let sprite = handles.nodeSprites.get(node.id);
		if (!sprite) {
			sprite = new Sprite(handles.circleTexture);
			// Anchor at sprite centre so `position` reads as the node
			// centre, matching every other renderer in the app.
			sprite.anchor.set(0.5);
			sprite.eventMode = "static";
			(sprite as { __nodeId?: string }).__nodeId = node.id;
			handles.nodesContainer.addChild(sprite);
			handles.nodeSprites.set(node.id, sprite);
		}
		const size = nodeSpriteSize(node.radius);
		sprite.width = size;
		sprite.height = size;
		sprite.position.set(layout.x, layout.y);
		sprite.tint = colorToTint(node.color);
		const baseAlpha = node.alpha * focusAlpha;
		// Multiply the colour-channel alpha into the sprite alpha so
		// `rgba(180,190,210,0.45)`-style unmatched colours stay desaturated.
		sprite.alpha = baseAlpha * colorAlpha(node.color);
		// Hovered ring — toggled per-frame via a child sprite (cheaper
		// than re-rendering the texture). For the first cut we skip the
		// ring; the SVG renderer's ring was a polish touch, not critical
		// for the pixi swap.
		sprite.zIndex = node.id === hovered ? 1 : 0;
		// Clear any parked state from a frame where this node was culled.
		sprite.renderable = true;
		sprite.visible = !showFront;

		let glyphSprite = handles.glyphSprites.get(node.id);
		if (showFront && frontTexture) {
			if (!glyphSprite) {
				glyphSprite = new Sprite();
				glyphSprite.anchor.set(0.5);
				glyphSprite.eventMode = "none";
				handles.glyphsContainer.addChild(glyphSprite);
				handles.glyphSprites.set(node.id, glyphSprite);
			}
			glyphSprite.texture = frontTexture;
			// Drawn at the disc diameter (`r * 2`) so it occupies the same
			// screen real-estate the disc did. Aspect preserved from the
			// texture (emoji + arbitrary images aren't perfectly square;
			// Phosphor icons are).
			const frontHeight = node.radius * 2;
			glyphSprite.height = frontHeight;
			glyphSprite.width = frontHeight * (frontTexture.width / frontTexture.height);
			// +1px optical nudge only for the emoji/type glyph (emoji sit
			// slightly below their geometric centre). Real icons are
			// centred art and need no correction.
			const cy = iconTexture ? layout.y : layout.y + 1;
			glyphSprite.position.set(layout.x, cy);
			// Front fade tracks the node fade without the disc's
			// colour-alpha desaturation — the SVG glyph layer behaved
			// identically.
			glyphSprite.alpha = baseAlpha;
			glyphSprite.renderable = true;
			glyphSprite.visible = true;
		} else if (glyphSprite) {
			glyphSprite.visible = false;
		}
	}

	handles.lastCull = { visible: visibleCount, culled: culledCount };
	handles.canvas.dataset.visibleNodes = String(visibleCount);
	handles.canvas.dataset.culledNodes = String(culledCount);
}

/** Texture-cache key. Pack folds in the colour because the recolour is
 *  baked into the bitmap; Emoji/Image are colour-independent so the bare
 *  `iconSrc` keeps one shared texture across every node carrying it. */
function iconCacheKey(node: RenderNode): string {
	return node.icon && node.icon.kind === IconKind.Pack
		? `${node.iconSrc}|${node.color}`
		: node.iconSrc;
}

/** Return the node's icon texture if it's already resolved, else kick a
 *  one-shot async load (deduped by `iconLoading`) and return null so the
 *  caller falls back to the glyph/disc this frame. On completion the
 *  texture is cached and `onInvalidate` nudges the change-gated render
 *  loop so the icon actually appears. */
function ensureIconTexture(handles: PixiHandles, node: RenderNode): Texture | null {
	if (!node.icon) return null;
	const key = iconCacheKey(node);
	const cached = handles.iconTextures.get(key);
	if (cached) return cached;
	if (handles.iconLoading.has(key)) return null;
	handles.iconLoading.add(key);
	loadIconImage(node.icon, node.color)
		.then((img) => {
			handles.iconTextures.set(key, Texture.from(img));
			handles.iconLoading.delete(key);
			handles.onInvalidate();
		})
		.catch(() => {
			handles.iconLoading.delete(key);
		});
	return null;
}

/** Stroke width in world units; the camera scale handles screen-space
 *  constancy automatically because `worldContainer.scale` carries `k`. */
const EDGE_STROKE_WIDTH = 0.9;

/** Rebuild the single edge `Graphics`. Called only when the world-space
 *  edge geometry actually changed (see `geometryDirty` on `paintPixi`) —
 *  NOT on camera-only moves, where the existing buffer persists and the
 *  camera transform moves it for free. Because the geometry must survive
 *  across camera moves it is NOT frustum-culled: all edges live in one
 *  buffer drawn in a single GL call (off-screen segments are clipped by the
 *  GPU viewport at zero fragment cost), so per-edge culling would only add
 *  CPU work while making the cached buffer camera-dependent.
 *
 *  **Batched (9.13.15).** The first cut stroked once per edge and filled
 *  once per arrowhead — `O(N)` style transitions that fragment the GL
 *  batch. We now group edges by `(tint, alpha)` in `buildEdgeBatches` and
 *  issue ONE `stroke()` per stroke batch + ONE `fill()` per arrow batch,
 *  so the geometry instruction stream is `O(distinct styles)` (low tens in
 *  a real vault) regardless of edge count. The pure batching math lives in
 *  `edge-batch.ts` so it's testable + benchable without a GPU. */
function drawEdges(handles: PixiHandles, snapshot: Snapshot): void {
	handles.edgeRebuilds += 1;
	handles.canvas.dataset.edgeRebuilds = String(handles.edgeRebuilds);
	const g = handles.edgesGraphics;
	g.clear();

	const inputs: EdgeGeometryInput[] = [];
	for (const edge of snapshot.renderEdges) {
		const source = snapshot.nodes.get(edge.link.sourceEntityId);
		const dest = snapshot.nodes.get(edge.link.destEntityId);
		if (!source || !dest) continue;
		const focusAlpha = snapshot.focusAlphaByEdge.get(edge.id) ?? 1;
		inputs.push({
			sx: source.x,
			sy: source.y,
			dx: dest.x,
			dy: dest.y,
			sourceRadius: source.radius,
			destRadius: dest.radius,
			tint: colorToTint(edge.color),
			alpha: edge.alpha * focusAlpha * colorAlpha(edge.color),
		});
	}

	const plan = buildEdgeBatches(inputs, {
		zoom: snapshot.transform.k,
		showArrows: snapshot.showArrows,
	});

	for (const batch of plan.strokes) {
		const seg = batch.segments;
		for (let i = 0; i < seg.length; i += 4) {
			g.moveTo(seg[i] ?? 0, seg[i + 1] ?? 0).lineTo(seg[i + 2] ?? 0, seg[i + 3] ?? 0);
		}
		g.stroke({ width: EDGE_STROKE_WIDTH, color: batch.tint, alpha: batch.alpha });
	}
	for (const batch of plan.fills) {
		const tri = batch.triangles;
		for (let i = 0; i < tri.length; i += 6) {
			g.moveTo(tri[i] ?? 0, tri[i + 1] ?? 0)
				.lineTo(tri[i + 2] ?? 0, tri[i + 3] ?? 0)
				.lineTo(tri[i + 4] ?? 0, tri[i + 5] ?? 0)
				.closePath();
		}
		g.fill({ color: batch.tint, alpha: batch.alpha });
	}

	handles.lastEdgeDrawCalls = plan.drawCalls;
	handles.canvas.dataset.edgeDrawCalls = String(plan.drawCalls);
}

/** The `n` visible nodes with the largest radius (radius is degree-derived in
 *  `scene.ts`, so this is the top-`n` hubs). Single linear pass with a bounded
 *  insertion into an `n`-sized array — O(node·n), n a small constant — so it's
 *  cheap to call per frame and never allocates a full sorted copy. Off-screen
 *  filtering happens at the call site. Exported for unit testing. */
export function topNByRadius(nodes: readonly RenderNode[], n: number): RenderNode[] {
	if (n <= 0) return [];
	const top: RenderNode[] = [];
	for (const node of nodes) {
		if (node.alpha <= 0.05) continue;
		const smallest = top[0]; // ascending order → smallest at [0]
		if (top.length < n) {
			top.push(node);
			top.sort((a, b) => a.radius - b.radius);
		} else if (smallest && node.radius > smallest.radius) {
			top[0] = node;
			top.sort((a, b) => a.radius - b.radius);
		}
	}
	return top.reverse(); // largest first
}

/** Maintain a screen-space `<div>` per visible label. Pixi `Text` is
 *  expensive (one texture per unique string + font); HTML labels reuse
 *  the shell's font stack and CSS for free. The overlay is positioned
 *  with `translate(px, px)` so the GPU compositor moves them — no
 *  per-frame reflow. */
function syncLabelOverlay(
	handles: PixiHandles,
	snapshot: Snapshot,
	bounds: ViewBounds | null,
): void {
	if (!snapshot.showLabels) {
		// User toggled labels off — drop any existing label divs and bail.
		for (const [, div] of handles.labelDivs) div.remove();
		handles.labelDivs.clear();
		return;
	}
	const detailZoom = snapshot.transform.k >= DETAIL_THRESHOLD_K;
	const visibleNodeCount = snapshot.renderNodes.filter((n) => n.alpha > 0.05).length;
	const underDensityCap = visibleNodeCount <= MAX_LABELED_NODES;
	const showAllLabels = detailZoom && underDensityCap;

	// Wanted set: every visible node when LOD permits, plus the hovered
	// node as a forceLabel exception.
	const wanted = new Set<string>();
	if (showAllLabels) {
		// Only label nodes whose disc is on screen — an off-screen label
		// div is layout/compositor cost for a glyph nobody sees. When
		// bounds is null (untrustworthy viewport) fail open: label all.
		for (const node of snapshot.renderNodes) {
			// Filtered-out (dimmed) nodes never auto-label — a full-strength
			// caption on a 15%-alpha disc reads as a glitch and buries the
			// matched set the filter is trying to surface. Hover still labels.
			if (node.subjectName === null) continue;
			const layout = snapshot.nodes.get(node.id);
			if (!layout) continue;
			if (bounds === null || nodeInView(layout.x, layout.y, node.radius, bounds)) {
				wanted.add(node.id);
			}
		}
	} else {
		// Survey zoom (or over the density cap): keep labels on the few
		// highest-degree hubs so the graph still reads as a named map, not
		// anonymous dots (F-048). Bounded to HUB_LABEL_COUNT — a single-pass
		// top-N by radius (radius is degree-derived), no per-frame sort.
		for (const hub of topNByRadius(snapshot.renderNodes, HUB_LABEL_COUNT)) {
			if (hub.subjectName === null) continue;
			const layout = snapshot.nodes.get(hub.id);
			if (!layout) continue;
			if (bounds === null || nodeInView(layout.x, layout.y, hub.radius, bounds)) {
				wanted.add(hub.id);
			}
		}
	}
	// The hovered node always keeps its label even off-screen so the
	// popover/hover affordance stays anchored mid-pan.
	if (snapshot.hoveredId) wanted.add(snapshot.hoveredId);

	const t = snapshot.transform;
	const fontSizePx = 10; // screen-space constant; world-to-screen handled by transform
	const labelLineHeightPx = Math.round(fontSizePx * 1.3);

	// De-clutter (F-230): the wanted set says which nodes *deserve* a label;
	// at survey zoom or in a tight hub cluster their screen rectangles overlap
	// into an unreadable smear. Compute each wanted label's screen box and keep
	// only the ones that clear the higher-priority labels already placed. The
	// hovered node gets the top priority so it never drops; the rest rank by
	// radius (degree), so the named hubs win the space.
	const candidates: LabelBox[] = [];
	// Labels resolved once here feed both the width estimate and the paint
	// loop below — visible ⊆ wanted, so every painted node already has its
	// text and nodeLabel never runs twice per node per frame.
	const labelTextById = new Map<string, string>();
	for (const node of snapshot.renderNodes) {
		if (!wanted.has(node.id)) continue;
		const layout = snapshot.nodes.get(node.id);
		if (!layout) continue;
		const centerX = layout.x * t.k + t.tx;
		const top = (layout.y + node.radius + 4) * t.k + t.ty;
		const priority = node.id === snapshot.hoveredId ? Number.POSITIVE_INFINITY : node.radius;
		const label = nodeLabel(node.entity);
		labelTextById.set(node.id, label);
		candidates.push({
			id: node.id,
			centerX,
			top,
			width: estimateLabelWidth(label),
			height: labelLineHeightPx,
			priority,
		});
	}
	const visible = declutterLabels(candidates);

	for (const [id, div] of handles.labelDivs) {
		if (!visible.has(id)) {
			div.remove();
			handles.labelDivs.delete(id);
		}
	}

	if (visible.size === 0) return;
	for (const node of snapshot.renderNodes) {
		if (!visible.has(node.id)) continue;
		const layout = snapshot.nodes.get(node.id);
		if (!layout) continue;
		let div = handles.labelDivs.get(node.id);
		if (!div) {
			div = document.createElement("div");
			div.className = "graph-canvas__label";
			div.style.position = "absolute";
			// Pin to the layer origin; per-frame position rides entirely on
			// `transform` (a compositor-only move — no layout/reflow). Writing
			// `left`/`top` each frame instead would force a synchronous layout
			// per label per frame, which is the zoom/pan jank labels add.
			div.style.left = "0";
			div.style.top = "0";
			div.style.whiteSpace = "nowrap";
			div.style.pointerEvents = "none";
			div.style.color = "currentColor";
			div.style.fontFamily = "var(--text-family-ui)";
			div.style.fontSize = `${fontSizePx}px`;
			handles.labelsLayer.appendChild(div);
			handles.labelDivs.set(node.id, div);
		}
		// world → screen, applied via transform so the GPU compositor moves
		// the label (no reflow). The -50% centres it horizontally on the node.
		const screenX = layout.x * t.k + t.tx;
		const screenY = (layout.y + node.radius + 4) * t.k + t.ty;
		div.style.transform = `translate(${screenX}px, ${screenY}px) translate(-50%, 0)`;
		div.style.fontWeight = node.id === snapshot.hoveredId ? "700" : "500";
		const focusAlpha = snapshot.focusAlphaByNode.get(node.id) ?? 1;
		div.style.opacity = String(Math.min(1, node.alpha + 0.1) * focusAlpha);
		const text = labelTextById.get(node.id) ?? nodeLabel(node.entity);
		if (div.textContent !== text) div.textContent = text;
	}
}

/** Resolve a screen-space `(clientX, clientY)` to the node currently
 *  under it. The hits live in Pixi's stage at world coords; we transform
 *  client → world and pick the closest sprite within its radius. Linear
 *  scan is fine for our node counts; a spatial-hash grid can swap in at
 *  10k+ without changing this signature. */
export function pickNodeAt(
	handles: PixiHandles,
	transform: CameraTransform,
	snapshot: Snapshot,
	clientX: number,
	clientY: number,
): string | null {
	const rect = handles.canvas.getBoundingClientRect();
	const sx = clientX - rect.left;
	const sy = clientY - rect.top;
	const worldX = (sx - transform.tx) / transform.k;
	const worldY = (sy - transform.ty) / transform.k;
	// Larger hit radius than the visible disc (matches the SVG renderer's
	// `MIN_HIT_RADIUS`) so tiny leaves are grabbable.
	const minHitWorld = 12 / Math.max(0.0001, transform.k);
	let pickId: string | null = null;
	let pickDistSq = Number.POSITIVE_INFINITY;
	for (const node of snapshot.renderNodes) {
		const layout = snapshot.nodes.get(node.id);
		if (!layout) continue;
		const dx = layout.x - worldX;
		const dy = layout.y - worldY;
		const r = Math.max(minHitWorld, node.radius + 6);
		const distSq = dx * dx + dy * dy;
		if (distSq < r * r && distSq < pickDistSq) {
			pickId = node.id;
			pickDistSq = distSq;
		}
	}
	return pickId;
}

/** Convert a node's world position to a client (screen) point. Symmetric
 *  with `pickNodeAt`'s inverse; used by the hover popover positioning
 *  so it tracks correctly across pan/zoom. */
export function nodeWorldToClient(
	handles: PixiHandles,
	transform: CameraTransform,
	worldX: number,
	worldY: number,
): { x: number; y: number } {
	const rect = handles.canvas.getBoundingClientRect();
	return {
		x: rect.left + worldX * transform.k + transform.tx,
		y: rect.top + worldY * transform.k + transform.ty,
	};
}
