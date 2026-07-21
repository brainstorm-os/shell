/**
 * PDF reading mode (9.21.5) — the paginated reading surface for a
 * fixed-layout book. Shares the reflow reader's chrome (header title,
 * footer nav, page chords) but paints each page onto a canvas through an
 * injected `PdfPagePort` instead of slicing reflow fragments — the port is
 * the seam that keeps this surface unit-testable: the app wires it to the
 * shared `@brainstorm-os/sdk/pdf-engine` (Preview's pdf.js stack — no second
 * one), tests inject a fake.
 *
 * Font-size reflow + highlights are reflow-only features and deliberately
 * absent: a PDF owns its own layout, and the highlight anchor model (char
 * offsets over reflow text) has no meaning on a rasterized page. What a PDF
 * reader CAN still offer — and what the header View control exposes — is render
 * scale (zoom, the fixed-layout analog of font size) and a page tint
 * (light / sepia / dark) applied as a canvas filter. A future text-layer pass
 * could bring highlights back — not this iteration.
 */

import { IconName, createIconElement } from "@brainstorm-os/sdk/icon";
import type { PdfLink } from "@brainstorm-os/sdk/pdf-engine";
import { PopoverBodyPadding, PopoverSize, createPopoverElement } from "@brainstorm-os/sdk/popover";
import { type ShortcutDisposer, attachShortcut } from "@brainstorm-os/sdk/shortcut";
import { type BooksI18nKey, t } from "../i18n";
import {
	type PdfReaderState,
	canGoNextPdf,
	canGoPrevPdf,
	createPdfReaderState,
	goToPdfPage,
	pdfLocator,
	pdfProgress,
} from "../logic/pdf-reader-state";
import {
	DEFAULT_PDF_VIEW,
	PDF_TINT_ORDER,
	type PdfTint,
	type PdfViewSettings,
	formatZoom,
	stepZoom,
	withTint,
	zoomFactor,
} from "../logic/pdf-view";
import type { Locator } from "../types/locator";
import { ReaderChord, buildReaderFooter, controlButton, labelledRow, stepperRow } from "./chrome";

export type PdfPageRenderHandle = {
	promise: Promise<void>;
	cancel(): void;
};

/** The render seam between this surface and the pdf.js engine. `renderPage`
 *  paints the 0-based page fitted inside `maxWidth × maxHeight` CSS pixels
 *  (sizing the canvas itself); `null` means "nothing to paint" (no 2d
 *  context). A cancelled handle's promise rejects — the surface swallows
 *  that as a page flip mid-paint. */
export type PdfPagePort = {
	pageCount: number;
	renderPage(
		pageIndex: number,
		canvas: HTMLCanvasElement,
		maxWidth: number,
		maxHeight: number,
	): PdfPageRenderHandle | null;
	/** External links on the 0-based page, positioned in the CSS-pixel box the
	 *  same `maxWidth × maxHeight` produces in `renderPage` (so the overlay lines
	 *  up with the canvas). Optional — a port without it renders no link layer. */
	getPageLinks?(pageIndex: number, maxWidth: number, maxHeight: number): Promise<readonly PdfLink[]>;
	dispose(): void;
};

export type PdfReaderOptions = {
	/** Where the book was last parked; restores to that page on mount. */
	initialPosition?: Locator | null;
	/** Per-book reading-position persistence seam — fired on every page turn
	 *  with the stable locator + progress (0..1), mirroring the reflow
	 *  reader's contract so the host persists both modes identically. */
	onPositionChange?: (locator: Locator, progress: number) => void;
	/** Fired when a link in the page is clicked — the host opens it (web links
	 *  go to the browser via the `open` intent). Absent = links render but do
	 *  nothing on click. */
	onOpenLink?: (url: string) => void;
	/** Where the zoom + tint start; defaults to fit-to-stage / light. */
	initialView?: PdfViewSettings;
	/** Fired whenever the reader's zoom or tint changes — the host may persist
	 *  it. In-memory (session-local) if absent, mirroring the reflow reader. */
	onViewChange?: (view: PdfViewSettings) => void;
};

export type PdfReaderHandle = {
	dispose: () => void;
	/** The current parked locator — `null` only for an empty document. */
	position: () => Locator | null;
	/** Jump to a 0-based page — the TOC navigation seam. */
	goToPage: (pageIndex: number) => void;
};

/** Gap (px) between the two pages of a spread. */
const SPREAD_GAP = 24;

export function mountPdfReader(
	root: HTMLElement,
	controlsHost: HTMLElement,
	title: string,
	port: PdfPagePort,
	options: PdfReaderOptions = {},
): PdfReaderHandle {
	root.replaceChildren();
	controlsHost.replaceChildren();

	let view: PdfViewSettings = options.initialView ?? DEFAULT_PDF_VIEW;

	const stage = document.createElement("div");
	stage.className = "books__stage books__stage--pdf";
	// A row of one (single) or two (spread) page canvases. `leftCanvas` is the
	// current page; `rightCanvas` is the facing page, shown only in spread mode.
	const pages = document.createElement("div");
	pages.className = "books__pdf-pages";
	const left = buildPdfPage();
	const right = buildPdfPage();
	const { canvas: leftCanvas, links: leftLinks } = left;
	const { canvas: rightCanvas, links: rightLinks } = right;
	right.root.style.display = "none";

	if (port.pageCount > 0) {
		pages.append(left.root, right.root);
		stage.append(pages);
	} else {
		const empty = document.createElement("p");
		empty.className = "books__empty";
		empty.textContent = t("reader.empty");
		stage.append(empty);
	}

	const { footer, prev, next, status, progress } = buildReaderFooter();
	root.append(stage, footer);

	let state: PdfReaderState = createPdfReaderState(port.pageCount, options.initialPosition ?? null);
	let renderTasks: (PdfPageRenderHandle | null)[] = [];
	let disposed = false;
	// Bumped every paint; an async link fetch only applies its result when its
	// token still matches (a page flip / resize mid-fetch supersedes it).
	let paintToken = 0;

	function applyLinks(
		layer: HTMLElement,
		canvas: HTMLCanvasElement,
		pageIndex: number,
		maxWidth: number,
		maxHeight: number,
		token: number,
	): void {
		layer.replaceChildren();
		if (!port.getPageLinks) return;
		void port
			.getPageLinks(pageIndex, maxWidth, maxHeight)
			.then((links) => {
				if (disposed || token !== paintToken) return;
				layer.replaceChildren();
				// Match the canvas's CSS box so the rects (computed at the render
				// scale) map 1:1 over the page.
				layer.style.width = canvas.style.width;
				layer.style.height = canvas.style.height;
				for (const link of links) {
					const anchor = document.createElement("a");
					anchor.className = "books__pdf-link";
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
						options.onOpenLink?.(link.url);
					});
					layer.append(anchor);
				}
			})
			.catch(() => {});
	}

	function stageArea(): { w: number; h: number } {
		const rect = stage.getBoundingClientRect();
		// Breathing room so the page never sits flush against the chrome, then
		// scale by zoom — the page renders larger than the stage and scrolls.
		const z = zoomFactor(view);
		return {
			w: Math.max(0, (rect.width || 800) - 48) * z,
			h: Math.max(0, (rect.height || 900) - 48) * z,
		};
	}

	/** Reflect zoom + tint onto the surface: a tint filter on the canvases and
	 *  (when zoomed past fit) a scroll mode so the enlarged page isn't clipped.
	 *  Class-toggled on `root` so the CSS owns the actual filters. */
	function applyView(): void {
		for (const tint of PDF_TINT_ORDER) {
			root.classList.toggle(`books--pdf-tint-${tint}`, tint === view.tint);
		}
		root.classList.toggle("books--pdf-zoomed", zoomFactor(view) > 1);
	}

	// Show two facing pages once the stage is wide enough to hold them side by
	// side (a landscape reading pane) — the "real book" view. A narrow / portrait
	// pane stays single-page. Re-evaluated on every paint so a resize flips it.
	function isSpread(): boolean {
		if (state.pageCount <= 1) return false;
		const { w, h } = stageArea();
		return w >= h;
	}

	function step(): number {
		return isSpread() ? 2 : 1;
	}

	function paint(): void {
		if (disposed) return;
		applyView();
		const spread = isSpread();
		const rightIndex = state.pageIndex + 1;
		const showRight = spread && rightIndex < state.pageCount;
		const total = String(Math.max(1, state.pageCount));
		const pageStatus = showRight
			? t("reader.pageStatusSpread", {
					from: String(state.pageIndex + 1),
					to: String(rightIndex + 1),
					total,
				})
			: t("reader.pageStatus", { page: String(state.pageIndex + 1), total });
		status.textContent = pageStatus;
		leftCanvas.setAttribute("aria-label", `${title} — ${pageStatus}`);
		progress.textContent = t("reader.progress", {
			percent: String(Math.round(pdfProgress(state) * 100)),
		});
		prev.disabled = !canGoPrevPdf(state);
		next.disabled = !canGoNextPdf(state);
		if (state.pageCount <= 0) return;
		for (const task of renderTasks) task?.cancel();
		renderTasks = [];
		const token = ++paintToken;
		const { w, h } = stageArea();
		const perPageWidth = showRight ? Math.max(1, (w - SPREAD_GAP) / 2) : w;
		const leftTask = port.renderPage(state.pageIndex, leftCanvas, perPageWidth, h);
		renderTasks.push(leftTask);
		// A cancelled render (page flip mid-paint) rejects — not an error.
		leftTask?.promise.catch(() => {});
		applyLinks(leftLinks, leftCanvas, state.pageIndex, perPageWidth, h, token);
		if (showRight) {
			right.root.style.display = "";
			rightCanvas.setAttribute("aria-label", `${title} — ${pageStatus}`);
			const rightTask = port.renderPage(rightIndex, rightCanvas, perPageWidth, h);
			renderTasks.push(rightTask);
			rightTask?.promise.catch(() => {});
			applyLinks(rightLinks, rightCanvas, rightIndex, perPageWidth, h, token);
		} else {
			right.root.style.display = "none";
			rightLinks.replaceChildren();
		}
	}

	function go(mutator: (s: PdfReaderState) => PdfReaderState): void {
		const before = state;
		state = mutator(state);
		if (state === before) return;
		paint();
		const locator = pdfLocator(state);
		if (locator) options.onPositionChange?.(locator, pdfProgress(state));
	}

	const goNext = (): void => go((s) => goToPdfPage(s, s.pageIndex + step()));
	const goPrev = (): void => go((s) => goToPdfPage(s, s.pageIndex - step()));

	prev.addEventListener("click", goPrev);
	next.addEventListener("click", goNext);

	const viewBtn = controlButton(
		"bs-panel-toggle books__view-btn",
		t("pdf.view.open"),
		createIconElement(IconName.Settings, { size: 16 }),
	);
	viewBtn.setAttribute("aria-haspopup", "dialog");
	controlsHost.append(viewBtn);

	function setView(next: PdfViewSettings): void {
		if (next === view) return;
		view = next;
		paint();
		options.onViewChange?.(view);
	}

	let openPanel: { close: () => void } | null = null;
	function toggleViewPanel(): void {
		if (openPanel) {
			openPanel.close();
			openPanel = null;
			return;
		}
		openPanel = createPopoverElement({
			title: t("pdf.view.title"),
			body: buildViewPanel(view, setView),
			size: PopoverSize.Small,
			bodyPadding: PopoverBodyPadding.Comfortable,
			onClose: () => {
				openPanel = null;
				viewBtn.setAttribute("aria-expanded", "false");
			},
			testId: "books-pdf-view-panel",
			labels: { close: t("pdf.view.close") },
		});
		viewBtn.setAttribute("aria-expanded", "true");
	}
	viewBtn.addEventListener("click", toggleViewPanel);

	const disposers: ShortcutDisposer[] = [
		attachShortcut(window, ReaderChord.Next, goNext),
		attachShortcut(window, ReaderChord.Prev, goPrev),
	];

	const resize = new ResizeObserver(() => paint());
	resize.observe(stage);

	paint();

	return {
		dispose() {
			disposed = true;
			for (const d of disposers) d();
			resize.disconnect();
			for (const task of renderTasks) task?.cancel();
			openPanel?.close();
			// The controls slot + tint/zoom classes outlive this reader (the app
			// owns them) — leave them clean so a successor doesn't inherit stale
			// buttons or a dark filter.
			controlsHost.replaceChildren();
			for (const tint of PDF_TINT_ORDER) root.classList.remove(`books--pdf-tint-${tint}`);
			root.classList.remove("books--pdf-zoomed");
			port.dispose();
		},
		position: () => pdfLocator(state),
		goToPage: (pageIndex) => go((s) => goToPdfPage(s, pageIndex)),
	};
}

/** The PDF view form: a zoom stepper + a page-tint swatch row. Rebuilds itself
 *  on every change so the live zoom value + selected tint stay current. */
function buildViewPanel(
	settings: PdfViewSettings,
	onChange: (next: PdfViewSettings) => void,
): HTMLElement {
	const form = document.createElement("div");
	form.className = "books__type-panel";

	const rerender = (next: PdfViewSettings): void => {
		onChange(next);
		form.replaceChildren(...rows(next));
	};

	function rows(s: PdfViewSettings): HTMLElement[] {
		return [
			stepperRow(
				t("pdf.zoom"),
				formatZoom(s.zoom),
				() => rerender(stepZoom(s, -1)),
				() => rerender(stepZoom(s, 1)),
				"books-pdf-zoom",
			),
			tintRow(s, (tint) => rerender(withTint(s, tint))),
		];
	}

	form.replaceChildren(...rows(settings));
	return form;
}

const PDF_TINT_LABELS: Record<PdfTint, BooksI18nKey> = {
	light: "pdf.tint.light",
	sepia: "pdf.tint.sepia",
	dark: "pdf.tint.dark",
};

function tintRow(settings: PdfViewSettings, onPick: (tint: PdfTint) => void): HTMLElement {
	const row = labelledRow(t("pdf.tintLabel"), "stacked");
	const group = document.createElement("div");
	group.className = "books__type-swatches";
	// kbn-roles-exempt: imperative DOM radiogroup; the swatches are focusable <button>s (Tab+Enter operable). Arrow-roving lands with the Books React migration.
	group.setAttribute("role", "radiogroup");
	group.setAttribute("aria-label", t("pdf.tintLabel"));
	for (const tint of PDF_TINT_ORDER) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = `books__type-swatch books__type-swatch--${tint}`;
		btn.setAttribute("role", "radio");
		const active = tint === settings.tint;
		btn.setAttribute("aria-checked", active ? "true" : "false");
		btn.classList.toggle("books__type-swatch--active", active);
		const fill = document.createElement("span");
		fill.className = "books__type-swatch-fill";
		fill.setAttribute("aria-hidden", "true");
		fill.textContent = "Aa";
		const label = document.createElement("span");
		label.className = "books__type-swatch-label";
		label.textContent = t(PDF_TINT_LABELS[tint]);
		btn.append(fill, label);
		btn.addEventListener("click", () => onPick(tint));
		group.append(btn);
	}
	row.append(group);
	return row;
}

/** One page slot: a relative host wrapping the page canvas and the absolutely
 *  positioned link overlay that sits on top of it (CSS in `styles.css`). */
function buildPdfPage(): { root: HTMLElement; canvas: HTMLCanvasElement; links: HTMLElement } {
	const root = document.createElement("div");
	root.className = "books__pdf-page";
	const canvas = document.createElement("canvas");
	canvas.className = "books__pdf-canvas";
	canvas.setAttribute("role", "img");
	const links = document.createElement("div");
	links.className = "books__pdf-links";
	root.append(canvas, links);
	return { root, canvas, links };
}
