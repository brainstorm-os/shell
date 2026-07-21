/**
 * PDF view math — 9.20.5.
 *
 * Pure page-navigation + render-scale geometry for the quick-look PDF
 * renderer, separated from the pdf.js / canvas DOM glue so the paging + fit
 * logic is unit-testable without the (browser-only, worker-backed) renderer.
 * Pages are 1-based to match pdf.js (`getPage(n)`, `numPages`).
 */

export type PdfNavState = {
	/** Current 1-based page. */
	page: number;
	/** Total page count (≥ 1 once the document loads). */
	total: number;
};

/** Snap a page to [1, total]. A zero/negative total clamps to page 1 so the
 *  pre-load state (total unknown) is well-defined. */
export function clampPage(page: number, total: number): number {
	const hi = Math.max(1, Math.floor(total));
	if (!Number.isFinite(page)) return 1;
	return Math.min(hi, Math.max(1, Math.floor(page)));
}

export function goToPage(state: PdfNavState, page: number): PdfNavState {
	const next = clampPage(page, state.total);
	return next === state.page ? state : { ...state, page: next };
}

export function nextPage(state: PdfNavState): PdfNavState {
	return goToPage(state, state.page + 1);
}

export function prevPage(state: PdfNavState): PdfNavState {
	return goToPage(state, state.page - 1);
}

export function isFirstPage(state: PdfNavState): boolean {
	return state.page <= 1;
}

export function isLastPage(state: PdfNavState): boolean {
	return state.page >= state.total;
}

/** `"3 / 12"` page indicator. */
export function pageLabel(state: PdfNavState): string {
	return `${state.page} / ${Math.max(1, state.total)}`;
}

// Zoom/fit math moved to the shared engine when Books became the second PDF
// consumer (9.21.5); re-exported so this module stays Preview's one import
// site for PDF view math.
export {
	PDF_MAX_ZOOM,
	PDF_MIN_ZOOM,
	PDF_ZOOM_STEP,
	clampZoom,
	fitScale,
} from "@brainstorm-os/sdk/pdf-engine";
