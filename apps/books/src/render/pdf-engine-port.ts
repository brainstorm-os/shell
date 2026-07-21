/**
 * The `PdfPagePort` over the shared `@brainstorm-os/sdk/pdf-engine` (the one
 * pdf.js stack, shared with Preview — 9.21.5's "no second PDF stack").
 * Fit-to-stage scale comes from the engine's shared `fitScale`; rendering
 * goes through `renderPdfPage` (canvas sizing + dpr). Disposal destroys the
 * document and tears the engine worker down.
 */

import {
	type PdfEngineDocument,
	type PdfEnginePage,
	type PdfLink,
	clampZoom,
	pdfPageLinks,
	renderPdfPage,
	terminatePdfWorker,
} from "@brainstorm-os/sdk/pdf-engine";
import type { PdfPagePort, PdfPageRenderHandle } from "./pdf-reader";

/** Fit scale (CSS px per PDF point) for a page inside `maxWidth × maxHeight` —
 *  the un-dpr'd scale the canvas's CSS box is sized at. The reading view fills
 *  the box (no 1× cap, unlike the quick-look `fitScale`); clamp keeps it within
 *  the engine's zoom bounds. Shared by `renderPage` + `getPageLinks` so the
 *  link overlay lines up with the rendered canvas. */
function fitCssScale(page: PdfEnginePage, maxWidth: number, maxHeight: number): number {
	const base = page.getViewport({ scale: 1 });
	return clampZoom(Math.min(maxWidth / base.width, maxHeight / base.height));
}

export function enginePagePort(doc: PdfEngineDocument): PdfPagePort {
	return {
		pageCount: doc.numPages,
		renderPage(pageIndex, canvas, maxWidth, maxHeight): PdfPageRenderHandle {
			let cancelled = false;
			let task: { cancel(): void } | null = null;
			const promise = (async () => {
				// pdf.js pages are 1-based; the reader state is 0-based.
				const page = await doc.getPage(pageIndex + 1);
				if (cancelled) return;
				const scale = fitCssScale(page, maxWidth, maxHeight);
				const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
				const renderHandle = renderPdfPage(page, canvas, scale, dpr);
				if (!renderHandle) return;
				task = renderHandle;
				if (cancelled) renderHandle.cancel();
				await renderHandle.promise;
			})();
			return {
				promise,
				cancel: () => {
					cancelled = true;
					task?.cancel();
				},
			};
		},
		async getPageLinks(pageIndex, maxWidth, maxHeight): Promise<readonly PdfLink[]> {
			const page = await doc.getPage(pageIndex + 1);
			return pdfPageLinks(page, fitCssScale(page, maxWidth, maxHeight));
		},
		dispose() {
			void doc.destroy().catch(() => {});
			terminatePdfWorker();
		},
	};
}
