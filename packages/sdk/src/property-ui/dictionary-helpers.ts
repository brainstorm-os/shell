/**
 * Pure helpers shared by the Tag cells (B5.7) and the DictionaryEditor
 * (B5.8): item lookup, active/archived partitioning, sort ordering, and
 * the chip-colour resolution. Vocabulary colour is **user data** — it
 * comes off the `DictionaryItem`, never a chrome state token. Kept DOM-
 * free so it gets unit coverage under the `node` environment.
 */

import type { Dictionary, DictionaryItem } from "@brainstorm-os/sdk-types";
import { HEX } from "./dictionary-import";

/** How the dictionary editor / picker orders items. Per-user pref,
 *  persisted under `app.settings:dictionary-sort:<id>`. */
export enum DictionarySortMode {
	Manual = "manual",
	Alpha = "alpha",
	AlphaDesc = "alpha-desc",
	MostUsed = "most-used",
}

export const DICTIONARY_SORT_ORDER: readonly DictionarySortMode[] = Object.freeze([
	DictionarySortMode.Manual,
	DictionarySortMode.Alpha,
	DictionarySortMode.AlphaDesc,
	DictionarySortMode.MostUsed,
]);

export function dictionarySortPrefKey(dictionaryId: string): string {
	return `app.settings:dictionary-sort:${dictionaryId}`;
}

export function parseDictionarySortMode(raw: unknown): DictionarySortMode {
	return DICTIONARY_SORT_ORDER.includes(raw as DictionarySortMode)
		? (raw as DictionarySortMode)
		: DictionarySortMode.Manual;
}

export function isArchived(item: DictionaryItem): boolean {
	return typeof item.archivedAt === "number";
}

/** Items still selectable in a value picker (not soft-deleted). */
export function activeItems(dict: Dictionary | undefined): readonly DictionaryItem[] {
	if (!dict) return [];
	return dict.items.filter((it) => !isArchived(it));
}

export function archivedItems(dict: Dictionary | undefined): readonly DictionaryItem[] {
	if (!dict) return [];
	return dict.items.filter(isArchived);
}

export function findItem(
	dict: Dictionary | undefined,
	id: string | null | undefined,
): DictionaryItem | undefined {
	if (!dict || !id) return undefined;
	return dict.items.find((it) => it.id === id);
}

/** Order items by the chosen mode. `usage` maps item id → consumer
 *  count (for Most-used). Manual / unknown falls back to `sortIndex`. */
export function sortItems(
	items: readonly DictionaryItem[],
	mode: DictionarySortMode,
	usage?: ReadonlyMap<string, number>,
): readonly DictionaryItem[] {
	const out = [...items];
	switch (mode) {
		case DictionarySortMode.Alpha:
			out.sort((a, b) => a.label.localeCompare(b.label));
			break;
		case DictionarySortMode.AlphaDesc:
			out.sort((a, b) => b.label.localeCompare(a.label));
			break;
		case DictionarySortMode.MostUsed:
			out.sort((a, b) => (usage?.get(b.id) ?? 0) - (usage?.get(a.id) ?? 0));
			break;
		default:
			out.sort((a, b) => a.sortIndex - b.sortIndex);
	}
	return out;
}

/** Case-insensitive label substring filter. */
export function filterItems(
	items: readonly DictionaryItem[],
	query: string,
): readonly DictionaryItem[] {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return items;
	return items.filter((it) => it.label.toLowerCase().includes(q));
}

/** Background + foreground for a chip, derived from the item's own
 *  accent (`item.colour`). No accent → a neutral chip (tokens, not a
 *  colour guess). Accepts the bare colour string or an item. */
export function chipColours(source: DictionaryItem | string | undefined): {
	background: string;
	foreground: string;
	border: string;
} {
	const raw = typeof source === "string" ? source : source?.colour;
	const accent = raw?.trim();
	// Re-validate even though the import gate already does — `chipColours`
	// is the interpolation boundary; a bad accent must never reach
	// `color-mix(...)` (CSS-injection / `url(...)` exfil surface).
	if (!accent || !HEX.test(accent)) {
		return {
			background: "var(--bg-elev)",
			foreground: "var(--text)",
			border: "var(--border)",
		};
	}
	return {
		background: `color-mix(in srgb, ${accent} 18%, var(--bg))`,
		foreground: `color-mix(in srgb, ${accent} 72%, var(--text))`,
		border: `color-mix(in srgb, ${accent} 38%, transparent)`,
	};
}

/** The next `sortIndex` to assign when appending a fresh item. */
export function nextSortIndex(dict: Dictionary | undefined): number {
	if (!dict || dict.items.length === 0) return 0;
	return Math.max(...dict.items.map((it) => it.sortIndex)) + 1;
}
