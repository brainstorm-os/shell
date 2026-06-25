/**
 * Shared pdf.js engine — THE one PDF stack (extracted from Preview's
 * 9.20.5 renderer at copy two, when Books' PDF reading mode (9.21.5)
 * needed the same document/page/canvas plumbing; Preview now delegates).
 *
 * pdf.js (+ its worker) is heavy (~3 MB, OQ-PV-2), so nothing here imports
 * it statically: `loadPdfEngine()` does the dynamic `import("pdfjs-dist")`,
 * which Vite code-splits into its own lazy chunk per consuming app, and the
 * worker is bundled via the canonical `new Worker(new URL(...))` pattern.
 * Apps pay the tax only when a PDF is actually opened.
 *
 * The zoom/fit math is pure and lives here too so both consumers share one
 * definition; everything else is a thin seam over the slice of the pdf.js
 * API the apps touch (structural types — no dependency on its large d.ts).
 */

import { installMathSumPrecise } from "./math-sum-precise";

export type PdfEngineViewport = {
	width: number;
	height: number;
	/** Maps a PDF user-space rect `[x1, y1, x2, y2]` into viewport coordinates
	 *  (top-left origin, y down) at this viewport's scale. Present on the real
	 *  pdf.js viewport; optional so a structural fake can omit it. */
	convertToViewportRectangle?(rect: readonly number[]): number[];
};

/** The slice of a pdf.js annotation we read. `subtype === "Link"` with a web
 *  `url`/`unsafeUrl` is an external link; everything else is ignored. */
export type RawPdfAnnotation = {
	subtype?: string;
	rect?: readonly number[];
	url?: unknown;
	unsafeUrl?: unknown;
};

export type PdfEnginePage = {
	getViewport(opts: { scale: number }): PdfEngineViewport;
	/** Page annotations (pdf.js `getAnnotations`). Optional so a structural
	 *  fake — or a build without it — degrades to "no links". */
	getAnnotations?(opts?: { intent?: string }): Promise<readonly RawPdfAnnotation[]>;
	render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
		promise: Promise<void>;
		cancel(): void;
	};
};

/** A clickable link on a rendered page, positioned in CSS pixels relative to
 *  the page's top-left (the canvas box) at the scale it was rendered. */
export type PdfLinkRect = { left: number; top: number; width: number; height: number };
export type PdfLink = { url: string; rect: PdfLinkRect };

/** Link targets we will surface. PDFs can embed `javascript:` / `file:` /
 *  `data:` URIs in link annotations — those never become clickable links; only
 *  these user-safe schemes pass (the host's egress path is the backstop, this
 *  is the front door). */
const SAFE_LINK_SCHEME = /^(?:https?|mailto|tel):/i;

/**
 * Map a page's raw annotations to safe external links, positioned in the
 * coordinate space of `viewport` (pass a viewport built at the SAME CSS scale
 * the page was rendered at, so the rects line up with the canvas box). Pure —
 * the async `pdfPageLinks` wrapper feeds it real pdf.js objects.
 */
export function pdfLinksFromAnnotations(
	annotations: readonly RawPdfAnnotation[],
	viewport: Pick<PdfEngineViewport, "convertToViewportRectangle">,
): PdfLink[] {
	const convert = viewport.convertToViewportRectangle;
	if (typeof convert !== "function") return [];
	const links: PdfLink[] = [];
	for (const annotation of annotations) {
		if (annotation.subtype !== "Link") continue;
		if (!Array.isArray(annotation.rect) || annotation.rect.length < 4) continue;
		const raw = typeof annotation.url === "string" ? annotation.url : annotation.unsafeUrl;
		const url = typeof raw === "string" ? raw.trim() : "";
		if (url.length === 0 || !SAFE_LINK_SCHEME.test(url)) continue;
		const mapped = convert(annotation.rect);
		if (mapped.length < 4) continue;
		const x1 = mapped[0] ?? 0;
		const y1 = mapped[1] ?? 0;
		const x2 = mapped[2] ?? 0;
		const y2 = mapped[3] ?? 0;
		const left = Math.min(x1, x2);
		const top = Math.min(y1, y2);
		const width = Math.abs(x2 - x1);
		const height = Math.abs(y2 - y1);
		if (width <= 0 || height <= 0) continue;
		links.push({ url, rect: { left, top, width, height } });
	}
	return links;
}

/**
 * Fetch + map a page's external links at `cssScale` (the un-dpr'd render
 * scale — the canvas's CSS width is `pageWidth × cssScale`). Returns `[]` when
 * the page can't enumerate annotations or the viewport can't map rects.
 */
export async function pdfPageLinks(page: PdfEnginePage, cssScale: number): Promise<PdfLink[]> {
	if (typeof page.getAnnotations !== "function") return [];
	const annotations = await page.getAnnotations({ intent: "display" }).catch(() => null);
	if (!annotations) return [];
	return pdfLinksFromAnnotations(annotations, page.getViewport({ scale: cssScale }));
}

/** One pdf.js outline (bookmark) node. `dest` is either a named destination
 *  string or an explicit destination array whose first element is a page
 *  ref — `resolvePdfOutline` turns both into 0-based page indices. */
export type PdfOutlineNode = {
	title: string;
	dest: unknown;
	items?: PdfOutlineNode[];
};

export type PdfEngineDocument = {
	numPages: number;
	getPage(n: number): Promise<PdfEnginePage>;
	getMetadata(): Promise<{ info?: Record<string, unknown> }>;
	getOutline(): Promise<PdfOutlineNode[] | null>;
	getDestination(dest: string): Promise<unknown[] | null>;
	getPageIndex(ref: unknown): Promise<number>;
	destroy(): Promise<void>;
};

/** A flattened outline entry: `pageIndex` is 0-based, `depth` is the nesting
 *  level (0 = top). The shape every TOC surface renders from. */
export type PdfOutlineEntry = {
	title: string;
	pageIndex: number;
	depth: number;
};

/**
 * Flatten a document's outline into page-indexed entries. Each node's
 * destination is resolved (named destinations go through `getDestination`);
 * a node that fails to resolve is skipped — a partial TOC beats none, and
 * real-world PDFs routinely carry a few broken bookmarks. Returns `[]` for
 * a document without an outline.
 */
export async function resolvePdfOutline(doc: PdfEngineDocument): Promise<PdfOutlineEntry[]> {
	const outline = await doc.getOutline().catch(() => null);
	if (!outline) return [];
	const entries: PdfOutlineEntry[] = [];
	async function walk(nodes: PdfOutlineNode[], depth: number): Promise<void> {
		for (const node of nodes) {
			try {
				const dest = typeof node.dest === "string" ? await doc.getDestination(node.dest) : node.dest;
				if (Array.isArray(dest) && dest.length > 0) {
					const pageIndex = await doc.getPageIndex(dest[0]);
					if (Number.isInteger(pageIndex) && pageIndex >= 0) {
						entries.push({ title: node.title, pageIndex, depth });
					}
				}
			} catch {
				// Broken bookmark — skip the node, keep its siblings/children.
			}
			if (node.items && node.items.length > 0) await walk(node.items, depth + 1);
		}
	}
	await walk(outline, 0);
	return entries;
}

export type PdfRenderTask = {
	promise: Promise<void>;
	cancel(): void;
};

let loadedPdfjs: typeof import("pdfjs-dist") | null = null;

/** Lazy-load pdf.js + wire its worker (idempotent across calls). */
export async function loadPdfEngine(): Promise<typeof import("pdfjs-dist")> {
	// Electron 41 (Chromium 134) lacks `Math.sumPrecise`, which pdf.js v6 calls
	// on both threads. Install it on the main thread before pdf.js loads; the
	// worker installs its own in `pdf-worker.ts` (a separate realm).
	installMathSumPrecise();
	const pdfjs = await import("pdfjs-dist");
	if (!pdfjs.GlobalWorkerOptions.workerPort && !pdfjs.GlobalWorkerOptions.workerSrc) {
		pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("./pdf-worker.ts", import.meta.url), {
			type: "module",
		});
	}
	loadedPdfjs = pdfjs;
	return pdfjs;
}

/** Open a PDF document from raw bytes. */
export async function openPdfDocument(bytes: Uint8Array): Promise<PdfEngineDocument> {
	const pdfjs = await loadPdfEngine();
	const task = pdfjs.getDocument({ data: bytes });
	const doc = (await task.promise) as unknown as PdfEngineDocument;
	// pdfjs `PDFDocumentProxy.destroy()` returns `void` (and is absent in some
	// builds), but the engine contract — and every caller's `.destroy().catch()`
	// — awaits a Promise. The loading task's `destroy()` is the real
	// Promise-returning teardown, so expose that as the document's `destroy`.
	(doc as { destroy: () => Promise<void> }).destroy = () => task.destroy();
	return doc;
}

/** Tear the shared worker down once the last consumer is done with PDFs —
 *  the same lifecycle Preview's `dispose()` always had. Safe to call when
 *  the engine never loaded (it no-ops rather than forcing the import). */
export function terminatePdfWorker(): void {
	const port = loadedPdfjs?.GlobalWorkerOptions.workerPort;
	// `Worker` is absent under jsdom/node (tests) — and without the engine
	// loaded there is nothing to terminate anyway.
	if (typeof Worker !== "undefined" && port instanceof Worker) {
		port.terminate();
		if (loadedPdfjs) loadedPdfjs.GlobalWorkerOptions.workerPort = null;
	}
}

/**
 * Render one page into `canvas` at `scale` (CSS scale; the backing store is
 * multiplied by `dpr` for crispness). Sizes the canvas + its CSS box, then
 * kicks the pdf.js render. Returns the cancellable task, or `null` when the
 * canvas has no 2d context (test environments). A cancelled task's promise
 * rejects — callers swallow that as "page flipped mid-paint", not an error.
 */
export function renderPdfPage(
	page: PdfEnginePage,
	canvas: HTMLCanvasElement,
	scale: number,
	dpr: number,
): PdfRenderTask | null {
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	const ratio = dpr > 0 ? dpr : 1;
	const viewport = page.getViewport({ scale: scale * ratio });
	canvas.width = Math.max(1, Math.floor(viewport.width));
	canvas.height = Math.max(1, Math.floor(viewport.height));
	canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
	canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
	return page.render({ canvasContext: ctx, viewport });
}

export const PDF_MIN_ZOOM = 0.25;
export const PDF_MAX_ZOOM = 8;
export const PDF_ZOOM_STEP = 1.25;

export function clampZoom(zoom: number): number {
	if (Number.isNaN(zoom)) return 1;
	return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, zoom));
}

/** The scale that fits a page (intrinsic `pageW × pageH`, in PDF points at
 *  scale 1) entirely inside `viewW × viewH` pixels — quick-look default. Never
 *  upscales past 1× (a tiny page stays crisp); degenerate sizes fall back to
 *  1 so a not-yet-measured viewport doesn't divide-by-zero. */
export function fitScale(pageW: number, pageH: number, viewW: number, viewH: number): number {
	if (pageW <= 0 || pageH <= 0 || viewW <= 0 || viewH <= 0) return 1;
	return clampZoom(Math.min(viewW / pageW, viewH / pageH, 1));
}
