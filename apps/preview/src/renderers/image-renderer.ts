/**
 * Image renderer — 9.20.2.
 *
 * Quick-Look-grade still-image viewer: fit / actual / fill modes, wheel
 * zoom anchored at the cursor, drag-to-pan, double-click toggle, a
 * keyboard chord set (via the app shortcut registry — no raw `e.key`),
 * an unobtrusive zoom HUD, and EXIF — both surfaced in the inspector and
 * baked into the display transform so a phone photo isn't shown sideways.
 *
 * All zoom/pan geometry lives in pure `logic/image-view.ts`; this file is
 * the DOM + event glue. `dispose()` revokes any owned object URL, detaches
 * every listener, unbinds shortcuts, and disconnects the ResizeObserver —
 * the host calls it on every navigation.
 */

import { Orientation, SelectionAttribute, attachCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { t } from "../i18n";
import { formatExifPairs, parseExif } from "../logic/exif";
import {
	FitMode,
	type Size,
	type ViewState,
	ZOOM_STEP,
	cycleFitMode,
	panBy,
	percentLabel,
	toggleActual,
	viewForMode,
	zoomAt,
} from "../logic/image-view";
import {
	type Angle,
	FlipAxis,
	RotationDirection,
	effectiveSize,
	flipScaleFactors,
	rotateBy,
} from "../logic/rotation-view";
import { ActionId, bindShortcut } from "../shortcuts";
import { PreviewKind } from "../types/preview-kind";
import type {
	PreviewInstance,
	PreviewModule,
	PreviewMountContext,
	PreviewSource,
} from "../types/preview-module";
import { sourceBytesOrNull } from "./media-source";

/** The HUD's roving toolbar controls: zoom −, zoom +, fit, rotate L/R, flip H/V. */
const HUD_CONTROL_COUNT = 7;

export const imageRenderer: PreviewModule = {
	kind: PreviewKind.Image,
	mount(context: PreviewMountContext): PreviewInstance {
		return mount(context);
	},
	async extractMetadata(source) {
		return await extractImageMetadata(source);
	},
};

function mount(context: PreviewMountContext): PreviewInstance {
	const { host, source } = context;
	host.replaceChildren();

	const viewport = document.createElement("div");
	viewport.className = "preview-image-viewport";
	viewport.tabIndex = 0;
	viewport.setAttribute("role", "img");
	viewport.setAttribute("aria-label", context.file.name);

	const img = document.createElement("img");
	img.className = "preview-image";
	img.setAttribute("alt", context.file.name);
	img.setAttribute("draggable", "false");
	img.decoding = "async";

	const ownedObjectUrl = applySourceToImage(img, source);
	viewport.appendChild(img);

	const hud = buildHud();
	const stage = document.createElement("div");
	stage.className = "preview-stage preview-stage--image";
	stage.append(viewport, hud.root);
	host.appendChild(stage);

	// --- view state -----------------------------------------------------
	// Chromium honours `image-orientation: from-image` by default, so the
	// `<img>` is already EXIF-rotated and `naturalWidth/Height` report the
	// corrected size — the renderer never rotates it itself.
	let natural: Size = { w: 0, h: 0 };
	let view: ViewState = { scale: 1, tx: 0, ty: 0, mode: FitMode.Fit };
	// User rotation (9.20.8), 90° steps, on top of the browser's EXIF
	// correction. Per-device view chrome; resets to 0 each mount (per file).
	let rotation: Angle = 0;
	// User flip (9.20.8) — mirror about an axis in image space. Doesn't change
	// the bounding box, so it never re-fits. Per-device; resets each mount.
	let flipH = false;
	let flipV = false;
	let ready = false;

	function viewportSize(): Size {
		const r = viewport.getBoundingClientRect();
		return { w: r.width, h: r.height };
	}

	/** The fit/pan math works against the displayed bounding box, which swaps
	 *  W/H at a quarter turn — so every geometry call takes this, not `natural`. */
	function naturalForView(): Size {
		return effectiveSize(natural, rotation);
	}

	function applyView(): void {
		// CSS applies the chain right-to-left: rotate about centre first, then
		// scale, then translate — so the rotated box is what `scale`/`tx`/`ty`
		// (computed against `naturalForView`) act on.
		// Right-to-left: mirror first (image space), then rotate, then zoom, then
		// translate. Flip keeps the bounding box, so it doesn't disturb fit/pan.
		const { sx, sy } = flipScaleFactors(flipH, flipV);
		img.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale}) rotate(${rotation}deg) scale(${sx}, ${sy})`;
		const interactive = view.scale > fitScale() + 0.001;
		viewport.classList.toggle("preview-image-viewport--pannable", interactive);
		hud.percent.textContent = percentLabel(view.scale);
		hud.fit.textContent = fitLabel(view.mode);
		hud.fit.setAttribute("aria-label", t("image.fitModeAria", { mode: fitLabel(view.mode) }));
	}

	function fitScale(): number {
		return viewForMode(naturalForView(), viewportSize(), FitMode.Fit).scale;
	}

	function setMode(mode: FitMode): void {
		view = viewForMode(naturalForView(), viewportSize(), mode);
		applyView();
	}

	function rotate(dir: RotationDirection): void {
		if (!ready) return;
		rotation = rotateBy(rotation, dir);
		// Re-fit so the whole rotated image shows (a Custom zoom snaps back to
		// Fit; a named mode is re-resolved against the swapped box).
		setMode(view.mode === FitMode.Custom ? FitMode.Fit : view.mode);
	}

	function flip(axis: FlipAxis): void {
		if (!ready) return;
		if (axis === FlipAxis.Horizontal) flipH = !flipH;
		else flipV = !flipV;
		// Flip preserves the bounding box — just repaint the transform.
		applyView();
	}

	function reflowForViewport(): void {
		if (!ready) return;
		if (view.mode === FitMode.Custom) {
			// Keep the user's zoom but re-clamp the pan to the new box.
			view = panBy(view, 0, 0, naturalForView(), viewportSize());
		} else {
			view = viewForMode(naturalForView(), viewportSize(), view.mode);
		}
		applyView();
	}

	// --- image load -----------------------------------------------------
	function onLoad(): void {
		// Already orientation-corrected by the browser (image-orientation:
		// from-image), so the natural box is the displayed box.
		natural = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
		ready = true;
		setMode(FitMode.Fit);
	}
	img.addEventListener("load", onLoad);

	// --- interactions ---------------------------------------------------
	function anchorFor(clientX: number, clientY: number): { x: number; y: number } {
		const r = viewport.getBoundingClientRect();
		return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
	}

	function onWheel(e: WheelEvent): void {
		if (!ready) return;
		e.preventDefault();
		const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
		view = zoomAt(view, factor, anchorFor(e.clientX, e.clientY), naturalForView(), viewportSize());
		applyView();
	}
	viewport.addEventListener("wheel", onWheel, { passive: false });

	let dragging = false;
	let lastX = 0;
	let lastY = 0;
	function onPointerDown(e: PointerEvent): void {
		if (e.button !== 0 || !ready) return;
		dragging = true;
		lastX = e.clientX;
		lastY = e.clientY;
		viewport.setPointerCapture(e.pointerId);
		viewport.classList.add("preview-image-viewport--grabbing");
	}
	function onPointerMove(e: PointerEvent): void {
		if (!dragging) return;
		const dx = e.clientX - lastX;
		const dy = e.clientY - lastY;
		lastX = e.clientX;
		lastY = e.clientY;
		view = panBy(view, dx, dy, naturalForView(), viewportSize());
		applyView();
	}
	function endDrag(e: PointerEvent): void {
		if (!dragging) return;
		dragging = false;
		try {
			viewport.releasePointerCapture(e.pointerId);
		} catch {
			// Capture may already be gone if the pointer left the window.
		}
		viewport.classList.remove("preview-image-viewport--grabbing");
	}
	viewport.addEventListener("pointerdown", onPointerDown);
	viewport.addEventListener("pointermove", onPointerMove);
	viewport.addEventListener("pointerup", endDrag);
	viewport.addEventListener("pointercancel", endDrag);

	function onDblClick(e: MouseEvent): void {
		if (!ready) return;
		e.preventDefault();
		view = toggleActual(view, anchorFor(e.clientX, e.clientY), naturalForView(), viewportSize());
		applyView();
	}
	viewport.addEventListener("dblclick", onDblClick);

	function zoomFromCenter(factor: number): void {
		if (!ready) return;
		view = zoomAt(view, factor, { x: 0, y: 0 }, naturalForView(), viewportSize());
		applyView();
	}

	function isPannable(): boolean {
		return ready && view.scale > fitScale() + 0.001;
	}

	// Keyboard pan. Bound on the capture phase so it runs *before* the
	// host's bubble-phase ArrowLeft/Right file-nav: when the image is
	// zoomed in we consume the arrow (preventDefault + stopPropagation) to
	// move the image; at fit-size we do nothing and let the event fall
	// through so the arrows still page between files.
	const KEY_PAN_STEP = 64;
	function keyboardPan(e: KeyboardEvent, dx: number, dy: number): void {
		if (!isPannable()) return;
		e.preventDefault();
		e.stopPropagation();
		view = panBy(view, dx, dy, naturalForView(), viewportSize());
		applyView();
	}

	hud.minus.addEventListener("click", () => zoomFromCenter(1 / ZOOM_STEP));
	hud.plus.addEventListener("click", () => zoomFromCenter(ZOOM_STEP));
	hud.fit.addEventListener("click", () => setMode(cycleFitMode(view.mode)));
	hud.rotateLeft.addEventListener("click", () => rotate(RotationDirection.Left));
	hud.rotateRight.addEventListener("click", () => rotate(RotationDirection.Right));
	hud.flipHorizontal.addEventListener("click", () => flip(FlipAxis.Horizontal));
	hud.flipVertical.addEventListener("click", () => flip(FlipAxis.Vertical));

	const unbind = [
		bindShortcut(ActionId.ZoomIn, () => zoomFromCenter(ZOOM_STEP)),
		bindShortcut(ActionId.ZoomOut, () => zoomFromCenter(1 / ZOOM_STEP)),
		bindShortcut(ActionId.ZoomReset, () => setMode(FitMode.Fit)),
		bindShortcut(ActionId.ZoomActual, () => setMode(FitMode.Actual)),
		bindShortcut(ActionId.CycleFit, () => setMode(cycleFitMode(view.mode))),
		bindShortcut(ActionId.PanLeft, (e) => keyboardPan(e, KEY_PAN_STEP, 0), { capture: true }),
		bindShortcut(ActionId.PanRight, (e) => keyboardPan(e, -KEY_PAN_STEP, 0), { capture: true }),
		bindShortcut(ActionId.PanUp, (e) => keyboardPan(e, 0, KEY_PAN_STEP), { capture: true }),
		bindShortcut(ActionId.PanDown, (e) => keyboardPan(e, 0, -KEY_PAN_STEP), { capture: true }),
		bindShortcut(ActionId.RotateLeft, () => rotate(RotationDirection.Left)),
		bindShortcut(ActionId.RotateRight, () => rotate(RotationDirection.Right)),
		bindShortcut(ActionId.FlipHorizontal, () => flip(FlipAxis.Horizontal)),
		bindShortcut(ActionId.FlipVertical, () => flip(FlipAxis.Vertical)),
	];

	// Rove between the HUD controls with Left/Right. Toolbar items are native
	// buttons (their click handlers act), so the binding just moves focus —
	// `selectionAttribute: None` keeps them free of aria-selected/checked and
	// the binding auto-omits an itemRole for a toolbar.
	let hudCursor = 0;
	const hudKeyboard = attachCompositeKeyboard(hud.root, {
		orientation: Orientation.Horizontal,
		role: "toolbar",
		selectionAttribute: SelectionAttribute.None,
		count: () => HUD_CONTROL_COUNT,
		activeIndex: () => hudCursor,
		onActiveIndexChange: (i) => {
			hudCursor = i;
		},
	});

	const ro =
		typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => reflowForViewport()) : null;
	ro?.observe(viewport);

	return {
		dispose(): void {
			for (const u of unbind) u();
			hudKeyboard.destroy();
			ro?.disconnect();
			img.removeEventListener("load", onLoad);
			viewport.removeEventListener("wheel", onWheel);
			viewport.removeEventListener("pointerdown", onPointerDown);
			viewport.removeEventListener("pointermove", onPointerMove);
			viewport.removeEventListener("pointerup", endDrag);
			viewport.removeEventListener("pointercancel", endDrag);
			viewport.removeEventListener("dblclick", onDblClick);
			if (ownedObjectUrl) URL.revokeObjectURL(ownedObjectUrl);
			host.replaceChildren();
		},
	};
}

function buildHud(): {
	root: HTMLElement;
	minus: HTMLButtonElement;
	plus: HTMLButtonElement;
	percent: HTMLElement;
	fit: HTMLButtonElement;
	rotateLeft: HTMLButtonElement;
	rotateRight: HTMLButtonElement;
	flipHorizontal: HTMLButtonElement;
	flipVertical: HTMLButtonElement;
} {
	// KBN-A-preview (image toolbar): role + roving tabindex are stamped by the
	// shared composite-keyboard binding in `mount` (ArrowLeft/Right rove between
	// controls); the buttons keep their own click handlers, so the binding only
	// roves. The `percent` readout sits outside the roving set (no index).
	const root = document.createElement("div");
	root.className = "preview-image-hud";
	root.setAttribute("aria-label", t("image.zoom"));

	const minus = hudButton(t("image.zoomOut"), t("image.zoomOutTitle"), "−");
	const percent = document.createElement("span");
	percent.className = "preview-image-hud__pct";
	percent.textContent = "100%";
	const plus = hudButton(t("image.zoomIn"), t("image.zoomInTitle"), "+");
	const fit = hudButton(t("image.fitMode"), t("image.fitModeTitle"), t("image.fit"));
	fit.classList.add("preview-image-hud__fit");

	// Rotate controls (9.20.8). ↺ / ↻ glyphs match the HUD's text-glyph style.
	const rotateLeft = hudButton(t("image.rotateLeft"), t("image.rotateLeftTitle"), "↺");
	const rotateRight = hudButton(t("image.rotateRight"), t("image.rotateRightTitle"), "↻");

	// Flip controls (9.20.8). ⇄ mirrors horizontally, ⇅ vertically.
	const flipHorizontal = hudButton(t("image.flipHorizontal"), t("image.flipHorizontalTitle"), "⇄");
	const flipVertical = hudButton(t("image.flipVertical"), t("image.flipVerticalTitle"), "⇅");

	root.append(minus, percent, plus, fit, rotateLeft, rotateRight, flipHorizontal, flipVertical);
	[minus, plus, fit, rotateLeft, rotateRight, flipHorizontal, flipVertical].forEach((btn, i) => {
		btn.dataset.compositeIndex = String(i);
	});
	return {
		root,
		minus,
		plus,
		percent,
		fit,
		rotateLeft,
		rotateRight,
		flipHorizontal,
		flipVertical,
	};
}

function hudButton(ariaLabel: string, title: string, glyph: string): HTMLButtonElement {
	const b = document.createElement("button");
	b.type = "button";
	b.className = "preview-image-hud__btn";
	b.setAttribute("aria-label", ariaLabel);
	b.dataset.bsTooltip = title;
	b.textContent = glyph;
	return b;
}

function fitLabel(mode: FitMode): string {
	switch (mode) {
		case FitMode.Actual:
			return "100%";
		case FitMode.Fill:
			return t("image.fill");
		case FitMode.Custom:
			return t("image.fit");
		default:
			return t("image.fit");
	}
}

function applySourceToImage(img: HTMLImageElement, source: PreviewSource): string | null {
	if (source.kind === "url") {
		img.src = source.url;
		return null;
	}
	const blob = new Blob([source.bytes as BlobPart], { type: source.mime });
	const url = URL.createObjectURL(blob);
	img.src = url;
	return url;
}

async function extractImageMetadata(source: PreviewSource): Promise<Record<string, string>> {
	const out: Record<string, string> = { Format: humaniseMime(source.mime) };
	try {
		const bytes = await sourceBytesOrNull(source);
		const dims = await decodeDimensions(source, bytes);
		if (dims) out.Dimensions = `${dims.w} × ${dims.h}`;
		if (bytes && isJpegMime(source.mime)) {
			for (const [label, value] of formatExifPairs(parseExif(bytes))) {
				out[label] = value;
			}
		}
	} catch {
		// Metadata is decorative — never let a decode failure blank the pane.
	}
	return out;
}

async function decodeDimensions(
	source: PreviewSource,
	bytes: Uint8Array | null,
): Promise<{ w: number; h: number } | null> {
	if (typeof createImageBitmap !== "function" || !bytes) return null;
	try {
		const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: source.mime }));
		const dims = { w: bmp.width, h: bmp.height };
		bmp.close();
		return dims;
	} catch {
		return null;
	}
}

function isJpegMime(mime: string): boolean {
	const t = mime.split(";")[0]?.trim().toLowerCase() ?? "";
	return t === "image/jpeg" || t === "image/jpg" || t === "image/tiff";
}

function humaniseMime(mime: string): string {
	const trimmed = mime.split(";")[0]?.trim().toLowerCase() ?? "";
	if (trimmed.startsWith("image/")) {
		const sub = trimmed.slice("image/".length);
		return sub === "svg+xml" ? "SVG" : sub.toUpperCase();
	}
	return mime;
}
