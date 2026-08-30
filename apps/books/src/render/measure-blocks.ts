/**
 * The reflow reader's ruler — measures every content block once per
 * (width × typography) so pagination can pack real geometry instead of
 * guessing from a character count.
 *
 * All blocks go into ONE offscreen `.books__page` clone and are read back in a
 * single pass, so the whole book costs one layout rather than one per block.
 * The clone carries the live page's classes and sits inside the same stage, so
 * it inherits the `--reader-*` custom properties and measures against exactly
 * the typography the reader is painting.
 */

import { BlockKind, type IndexedSpineItem } from "../logic/content";
import type { BlockMetrics, SpineMetrics } from "../logic/measured-pagination";

/** An element's content box in FRACTIONAL px.
 *
 * `clientWidth`/`clientHeight` round to whole pixels, and the reading column is
 * `max-width: 65ch` — a fractional width. Handing the ruler the rounded 736px
 * where the page is really 735.703px made it 0.3px roomier than the surface it
 * models, which is enough for one word to fit that would not fit live: the
 * block measured 7 lines and rendered 8, and that page clipped. Sub-pixel
 * differences are not cosmetic here — they cost a whole line. */
export function contentBox(el: HTMLElement): { width: number; height: number } {
	const rect = el.getBoundingClientRect();
	const style = getComputedStyle(el);
	const px = (value: string): number => {
		const n = Number.parseFloat(value);
		return Number.isFinite(n) ? n : 0;
	};
	return {
		width:
			rect.width -
			px(style.paddingLeft) -
			px(style.paddingRight) -
			px(style.borderLeftWidth) -
			px(style.borderRightWidth),
		height:
			rect.height -
			px(style.paddingTop) -
			px(style.paddingBottom) -
			px(style.borderTopWidth) -
			px(style.borderBottomWidth),
	};
}

function readMetrics(el: HTMLElement): BlockMetrics {
	const style = getComputedStyle(el);
	const height = el.getBoundingClientRect().height;
	const lineHeight = Number.parseFloat(style.lineHeight);
	const marginBottom = Number.parseFloat(style.marginBottom);
	return {
		height,
		marginBottom: Number.isFinite(marginBottom) ? marginBottom : 0,
		// `line-height: normal` reports non-numeric; one line is the safe floor
		// (it only ever affects where an over-tall block splits).
		lines:
			Number.isFinite(lineHeight) && lineHeight > 0 ? Math.max(1, Math.round(height / lineHeight)) : 1,
	};
}

/** Measure every block of every spine item at the live page width. Returns
 *  empty metrics when the page has no layout yet (a hidden window, or the
 *  first paint before the box is resolved) — the caller falls back to the
 *  character-budget paginator until a real box arrives. */
export function measureSpineBlocks(
	stage: HTMLElement,
	page: HTMLElement,
	spine: readonly IndexedSpineItem[],
): SpineMetrics {
	const width = contentBox(page).width;
	if (!(width > 0)) return spine.map(() => []);

	const ruler = document.createElement("article");
	ruler.className = `${page.className} books__ruler`;
	ruler.setAttribute("aria-hidden", "true");
	ruler.style.width = `${width}px`;

	const elements: HTMLElement[][] = [];
	const fragment = document.createDocumentFragment();
	for (const item of spine) {
		const row: HTMLElement[] = [];
		for (const indexed of item.blocks) {
			const heading = indexed.block.kind === BlockKind.Heading;
			const el = document.createElement(heading ? "h2" : "p");
			el.className = heading ? "books__heading" : "books__paragraph";
			el.textContent = indexed.block.text;
			fragment.append(el);
			row.push(el);
		}
		elements.push(row);
	}
	ruler.append(fragment);
	stage.append(ruler);
	try {
		return elements.map((row) => row.map(readMetrics));
	} finally {
		ruler.remove();
	}
}
