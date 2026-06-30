/**
 * PDF renderer — 9.20.5.
 *
 * Quick-look PDF viewer over the shared `@brainstorm/sdk/pdf-engine` (the
 * one pdf.js stack, shared with Books since 9.21.5). pdf.js (+ its worker)
 * is the heavy bit (OQ-PV-2, ~3 MB), so this whole module is reached only
 * through the registry's dynamic `import()` — Preview's cold start never
 * pays the tax unless a PDF is actually opened.
 *
 * The host owns chrome; this module renders the current page to a `<canvas>`
 * and adds a compact HUD (prev / next page · page counter · zoom). All paging
 * + fit math is pure in `logic/pdf-view.ts`. `dispose()` cancels any in-flight
 * render, destroys the pdf.js document + worker, and revokes any owned URL.
 */

import { Orientation, SelectionAttribute, attachCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { IconName, createIconElement } from "@brainstorm/sdk/icon";
import {
	type PdfEngineDocument,
	type PdfLink,
	openPdfDocument,
	pdfPageLinks,
	renderPdfPage,
	terminatePdfWorker,
} from "@brainstorm/sdk/pdf-engine";
import { t } from "../i18n";
import {
	PDF_ZOOM_STEP,
	type PdfNavState,
	clampZoom,
	fitScale,
	isFirstPage,
	isLastPage,
	nextPage,
	pageLabel,
	prevPage,
} from "../logic/pdf-view";
import { ActionId, bindShortcut } from "../shortcuts";
import { PreviewKind } from "../types/preview-kind";
import type {
	PreviewInstance,
	PreviewModule,
	PreviewMountContext,
	PreviewSource,
} from "../types/preview-module";
import { sourceBytes } from "./media-source";

/** The HUD's roving toolbar controls: prev, next, zoom −, zoom +, fit. */
const PDF_HUD_CONTROL_COUNT = 5;

export const pdfRenderer: PreviewModule = {
	kind: PreviewKind.Pdf,
	async mount(context: PreviewMountContext): Promise<PreviewInstance> {
		return await mount(context);
	},
	async extractMetadata(source) {
		return await extractPdfMetadata(source);
	},
};

async function mount(context: PreviewMountContext): Promise<PreviewInstance> {
	const { host, source, openExternalUrl } = context;
	host.replaceChildren();

	const stage = document.createElement("div");
	stage.className = "preview-stage preview-stage--pdf";
	const viewport = document.createElement("div");
	viewport.className = "preview-pdf-viewport";
	viewport.tabIndex = 0;
	// The canvas + its link overlay share a relative host so the absolutely
	// positioned link hotspots sit exactly over the rendered page.
	const page = document.createElement("div");
	page.className = "preview-pdf-page";
	const canvas = document.createElement("canvas");
	canvas.className = "preview-pdf-canvas";
	const linkLayer = document.createElement("div");
	linkLayer.className = "preview-pdf-links";
	page.append(canvas, linkLayer);
	viewport.appendChild(page);

	const hud = buildHud();
	stage.append(viewport, hud.root);
	host.appendChild(stage);

	const bytes = await sourceBytes(source);
	const doc: PdfEngineDocument = await openPdfDocument(bytes);

	let nav: PdfNavState = { page: 1, total: doc.numPages };
	let zoom = 1;
	let fitZoom = 1;
	// Until the user picks an explicit zoom, the page stays fit to the viewport
	// — opens fit-to-width (never clipped at 100%) AND re-fits on pane resize.
	// Manual zoom in/out opts out; "fit" opts back in.
	let userZoomed = false;
	let renderTask: { cancel(): void } | null = null;
	let disposed = false;
	// Bumped per render; a stale async link fetch (page flip / zoom mid-fetch)
	// is dropped when its sequence no longer matches.
	let renderSeq = 0;

	function applyLinks(links: readonly PdfLink[]): void {
		linkLayer.replaceChildren();
		linkLayer.style.width = canvas.style.width;
		linkLayer.style.height = canvas.style.height;
		for (const link of links) {
			const anchor = document.createElement("a");
			anchor.className = "preview-pdf-link";
			anchor.href = link.url;
			anchor.rel = "noopener noreferrer";
			anchor.title = link.url;
			anchor.setAttribute("aria-label", link.url);
			anchor.style.left = `${link.rect.left}px`;
			anchor.style.top = `${link.rect.top}px`;
			anchor.style.width = `${link.rect.width}px`;
			anchor.style.height = `${link.rect.height}px`;
			anchor.addEventListener("click", (event) => {
				event.preventDefault();
				openExternalUrl?.(link.url);
			});
			linkLayer.append(anchor);
		}
	}

	function viewportSize(): { w: number; h: number } {
		const r = viewport.getBoundingClientRect();
		// Leave a little breathing room so the page isn't flush to the edges.
		return { w: Math.max(0, r.width - 24), h: Math.max(0, r.height - 24) };
	}

	async function renderCurrent(): Promise<void> {
		if (disposed) return;
		const seq = ++renderSeq;
		const pdfPage = await doc.getPage(nav.page);
		if (disposed) return;
		const base = pdfPage.getViewport({ scale: 1 });
		const vp = viewportSize();
		fitZoom = fitScale(base.width, base.height, vp.w, vp.h);
		if (!userZoomed) zoom = fitZoom;
		const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
		renderTask?.cancel();
		linkLayer.replaceChildren();
		const task = renderPdfPage(pdfPage, canvas, zoom, dpr);
		if (!task) return;
		renderTask = task;
		try {
			await task.promise;
		} catch {
			// A cancelled render (page flip mid-paint) rejects — not an error.
		}
		if (disposed || seq !== renderSeq) return;
		// Link rects are computed at the un-dpr'd render scale (`zoom`) so they
		// line up with the canvas's CSS box.
		const links = await pdfPageLinks(pdfPage, zoom).catch(() => [] as PdfLink[]);
		if (!disposed && seq === renderSeq) applyLinks(links);
		syncHud();
	}

	function syncHud(): void {
		hud.counter.textContent = pageLabel(nav);
		hud.prev.disabled = isFirstPage(nav);
		hud.next.disabled = isLastPage(nav);
		// The animated tooltip chip is suppressed on disabled buttons, so fall
		// back to the native `title` when prev/next can't be used.
		hud.prev.title = hud.prev.disabled ? t("pdf.prevPageTitle") : "";
		hud.next.title = hud.next.disabled ? t("pdf.nextPageTitle") : "";
	}

	function go(next: PdfNavState): void {
		if (next === nav) return;
		nav = next;
		// New page renders at the current zoom (or fit if still unset).
		void renderCurrent();
	}

	function setZoom(factor: number): void {
		userZoomed = true;
		zoom = clampZoom(zoom * factor);
		void renderCurrent();
	}

	function resetZoom(): void {
		userZoomed = false;
		zoom = fitZoom;
		void renderCurrent();
	}

	hud.prev.addEventListener("click", () => go(prevPage(nav)));
	hud.next.addEventListener("click", () => go(nextPage(nav)));
	hud.zoomOut.addEventListener("click", () => setZoom(1 / PDF_ZOOM_STEP));
	hud.zoomIn.addEventListener("click", () => setZoom(PDF_ZOOM_STEP));
	hud.fit.addEventListener("click", resetZoom);

	// Page nav on the capture phase so it beats the host's file-nav arrows
	// when the document has more than one page; single-page PDFs let the
	// arrows fall through to walk the gallery.
	function pageKey(e: KeyboardEvent, step: 1 | -1): void {
		if (nav.total <= 1) return;
		e.preventDefault();
		e.stopPropagation();
		go(step === 1 ? nextPage(nav) : prevPage(nav));
	}
	const unbind = [
		bindShortcut(ActionId.PdfPrevPage, (e) => pageKey(e, -1), { capture: true }),
		bindShortcut(ActionId.PdfNextPage, (e) => pageKey(e, 1), { capture: true }),
		bindShortcut(ActionId.ZoomIn, () => setZoom(PDF_ZOOM_STEP)),
		bindShortcut(ActionId.ZoomOut, () => setZoom(1 / PDF_ZOOM_STEP)),
		bindShortcut(ActionId.ZoomReset, resetZoom),
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
		count: () => PDF_HUD_CONTROL_COUNT,
		activeIndex: () => hudCursor,
		onActiveIndexChange: (i) => {
			hudCursor = i;
		},
	});

	const ro =
		typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => void renderCurrent()) : null;
	ro?.observe(viewport);

	await renderCurrent();

	return {
		dispose(): void {
			disposed = true;
			for (const u of unbind) u();
			hudKeyboard.destroy();
			ro?.disconnect();
			renderTask?.cancel();
			void doc.destroy().catch(() => {});
			terminatePdfWorker();
			host.replaceChildren();
		},
	};
}

function buildHud(): {
	root: HTMLElement;
	prev: HTMLButtonElement;
	next: HTMLButtonElement;
	counter: HTMLElement;
	zoomOut: HTMLButtonElement;
	zoomIn: HTMLButtonElement;
	fit: HTMLButtonElement;
} {
	// KBN-A-preview (pdf toolbar): role + roving tabindex are stamped by the
	// shared composite-keyboard binding in `mount` (ArrowLeft/Right rove between
	// controls); the buttons keep their own click handlers. The page counter sits
	// outside the roving set (no index).
	const root = document.createElement("div");
	root.className = "preview-image-hud preview-pdf-hud";
	root.setAttribute("aria-label", t("pdf.toolbar"));

	const prev = hudButton(t("pdf.prevPage"), t("pdf.prevPageTitle"), IconName.CaretLeft);
	const counter = document.createElement("span");
	counter.className = "preview-image-hud__pct preview-pdf-hud__counter";
	counter.textContent = "1 / 1";
	const next = hudButton(t("pdf.nextPage"), t("pdf.nextPageTitle"), IconName.CaretRight);
	const zoomOut = hudButton(t("pdf.zoomOut"), t("pdf.zoomOut"), "−");
	const zoomIn = hudButton(t("pdf.zoomIn"), t("pdf.zoomIn"), IconName.Plus);
	const fit = hudButton(t("pdf.fit"), t("pdf.fit"), "⤢");

	root.append(prev, counter, next, zoomOut, zoomIn, fit);
	[prev, next, zoomOut, zoomIn, fit].forEach((btn, i) => {
		btn.dataset.compositeIndex = String(i);
	});
	return { root, prev, next, counter, zoomOut, zoomIn, fit };
}

function hudButton(ariaLabel: string, title: string, glyph: IconName | string): HTMLButtonElement {
	const b = document.createElement("button");
	b.type = "button";
	b.className = "preview-image-hud__btn";
	b.setAttribute("aria-label", ariaLabel);
	b.dataset.bsTooltip = title;
	if (Object.values(IconName).includes(glyph as IconName)) {
		b.append(createIconElement(glyph as IconName, { size: 16 }));
	} else {
		b.textContent = glyph;
	}
	return b;
}

async function extractPdfMetadata(source: PreviewSource): Promise<Record<string, string>> {
	const out: Record<string, string> = { Format: "PDF" };
	try {
		const bytes = await sourceBytes(source);
		const doc = await openPdfDocument(bytes);
		out.Pages = String(doc.numPages);
		const meta = await doc.getMetadata();
		const info = meta.info ?? {};
		const title = str(info.Title);
		const author = str(info.Author);
		if (title) out.Title = title;
		if (author) out.Author = author;
		await doc.destroy().catch(() => {});
	} catch {
		// Metadata is decorative — a decode failure leaves just the Format row.
	}
	return out;
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
