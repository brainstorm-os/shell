/**
 * The pure highlight model + an in-memory store for the 9.21.4 authoring
 * drop. A `Highlight/v1` is a first-class anchored annotation (see
 * types/highlight.ts) — NOT a mark in the book body. This module owns:
 *
 *   - `composeHighlight` — build a `Highlight/v1` from a resolved selection.
 *   - query helpers — sort by anchor, find the highlights overlapping a
 *     page's range, and the per-page paint segments.
 *   - `HighlightStore` — a small observable in-memory collection behind a
 *     `HighlightPort` seam. The store never reaches the vault directly; the
 *     port's `create`/`update`/`remove` callbacks are where 9.21.2/9.21.6
 *     wire the real `Highlight/v1` entity writes (the same seam pattern the
 *     typography model uses for persistence). Until then the store is its
 *     own source of truth so the whole authoring surface works in the
 *     preview drop. NOTE: this is an imperative, self-contained app store
 *     for a non-React render surface — not a vault-entity reactivity loop;
 *     when the real entity reads land they flow through @brainstorm-os/react-yjs
 *     per the reactivity rule.
 */

import type { Highlight, HighlightColor } from "../types/highlight";
import { type LocatorRange, compareLocators, normalizeRange } from "../types/locator";
import type { ResolvedSelection } from "./selection-locator";

/** Inputs needed to build a `Highlight/v1` beyond the resolved selection. */
export type ComposeHighlightInput = {
	bookId: string;
	color: HighlightColor;
	selection: ResolvedSelection;
	note?: string;
	now: number;
	id: string;
};

export function composeHighlight(input: ComposeHighlightInput): Highlight {
	return {
		id: input.id,
		bookId: input.bookId,
		anchor: normalizeRange(input.selection.range),
		color: input.color,
		quote: input.selection.quote,
		note: input.note?.trim() ?? "",
		createdAt: input.now,
		updatedAt: input.now,
	};
}

/** Stable order over highlights: by anchor start, then end — reading order
 *  down the book. */
export function sortHighlights(highlights: readonly Highlight[]): Highlight[] {
	return [...highlights].sort((a, b) => {
		const byStart = compareLocators(a.anchor.start, b.anchor.start);
		if (byStart !== 0) return byStart;
		return compareLocators(a.anchor.end, b.anchor.end);
	});
}

/** True when a highlight's anchor overlaps a page's `LocatorRange` (any
 *  shared character). Touching-only-at-the-boundary does not count — the
 *  page range is start-inclusive / end-exclusive. */
export function highlightOverlapsRange(highlight: Highlight, page: LocatorRange): boolean {
	return (
		compareLocators(highlight.anchor.start, page.end) < 0 &&
		compareLocators(highlight.anchor.end, page.start) > 0
	);
}

/** The highlights (in reading order) that have any ink on the given page. */
export function highlightsOnPage(
	highlights: readonly Highlight[],
	page: LocatorRange,
): Highlight[] {
	return sortHighlights(highlights.filter((h) => highlightOverlapsRange(h, page)));
}

/** A clipped paint span for one highlight on one page fragment — the
 *  intersection of the highlight's anchor with the fragment, expressed as
 *  char offsets within the fragment's text (`[from, to)`). */
export type HighlightSpan = {
	highlightId: string;
	color: HighlightColor;
	/** Offset within the fragment text where the ink starts. */
	from: number;
	/** Offset within the fragment text where the ink ends (exclusive). */
	to: number;
};

/** Compute the paint spans a single highlight contributes to a fragment
 *  that starts at `fragmentSpineOffset` and is `fragmentLength` chars long.
 *  Returns `null` when the highlight does not touch the fragment. */
export function highlightSpanInFragment(
	highlight: Highlight,
	fragmentSpineOffset: number,
	fragmentLength: number,
): HighlightSpan | null {
	const fragEnd = fragmentSpineOffset + fragmentLength;
	const from = Math.max(highlight.anchor.start.charOffset, fragmentSpineOffset);
	const to = Math.min(highlight.anchor.end.charOffset, fragEnd);
	if (to <= from) return null;
	return {
		highlightId: highlight.id,
		color: highlight.color,
		from: from - fragmentSpineOffset,
		to: to - fragmentSpineOffset,
	};
}

/** The persistence seam. The store calls these on every mutation; the
 *  preview drop leaves them unset (in-memory only), 9.21.6 wires them to
 *  `Highlight/v1` entity writes. */
export type HighlightPort = {
	create?: (highlight: Highlight) => void;
	update?: (highlight: Highlight) => void;
	remove?: (id: string) => void;
};

export type HighlightStoreListener = (highlights: readonly Highlight[]) => void;

/** A small observable in-memory collection of highlights for one book.
 *  Keeps its list sorted in reading order and notifies listeners on every
 *  change. The render surface subscribes; the port forwards writes. */
export class HighlightStore {
	private highlights: Highlight[];
	private readonly listeners = new Set<HighlightStoreListener>();

	constructor(
		private readonly port: HighlightPort = {},
		initial: readonly Highlight[] = [],
	) {
		this.highlights = sortHighlights(initial);
	}

	list(): readonly Highlight[] {
		return this.highlights;
	}

	get(id: string): Highlight | null {
		return this.highlights.find((h) => h.id === id) ?? null;
	}

	subscribe(listener: HighlightStoreListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	add(highlight: Highlight): Highlight {
		this.highlights = sortHighlights([...this.highlights, highlight]);
		this.port.create?.(highlight);
		this.emit();
		return highlight;
	}

	setColor(id: string, color: HighlightColor, now: number): Highlight | null {
		return this.mutate(id, (h) => ({ ...h, color, updatedAt: now }));
	}

	setNote(id: string, note: string, now: number): Highlight | null {
		return this.mutate(id, (h) => ({ ...h, note: note.trim(), updatedAt: now }));
	}

	remove(id: string): boolean {
		const before = this.highlights.length;
		this.highlights = this.highlights.filter((h) => h.id !== id);
		if (this.highlights.length === before) return false;
		this.port.remove?.(id);
		this.emit();
		return true;
	}

	private mutate(id: string, fn: (h: Highlight) => Highlight): Highlight | null {
		const existing = this.get(id);
		if (!existing) return null;
		const next = fn(existing);
		this.highlights = sortHighlights(this.highlights.map((h) => (h.id === id ? next : h)));
		this.port.update?.(next);
		this.emit();
		return next;
	}

	private emit(): void {
		for (const listener of this.listeners) listener(this.highlights);
	}
}
