/**
 * Emoji shortcode resolution (B11.1) — map a `:slug:` style shortcode to its
 * emoji character, and search slugs for a typeahead. Keyed on the Unicode
 * `slug` already carried by `emoji-data` (`grinning_face`, `thumbs_up`, …) so
 * there's one emoji dataset product-wide (the picker + the Notes `:`-typeahead
 * + the markdown shortcut all read it). Pure + dataset-driven — no DOM, no
 * editor — so the lookup + ranking are unit-testable on their own.
 */

import { ALL_EMOJIS, type EmojiData, emojiKeywords } from "./emoji-data";

/** Characters a `:slug:` shortcode may contain (Unicode emoji slugs are
 *  lowercase words joined by `_`). Exported so the editor transformer's
 *  trigger regExp and this module agree on the grammar. */
export const EMOJI_SHORTCODE_BODY = "[a-z0-9_]+";

const SHORTCODE_RE = new RegExp(`^${EMOJI_SHORTCODE_BODY}$`);

/** slug → emoji char, built once over the full set. */
const BY_SLUG: ReadonlyMap<string, string> = new Map(ALL_EMOJIS.map((e) => [e.slug, e.char]));

/** Keyword aliases that fit the shortcode grammar (`:coffee:` → ☕). A real
 *  slug always wins over an alias; the first emoji claiming an alias keeps
 *  it. */
const BY_ALIAS: ReadonlyMap<string, string> = (() => {
	const map = new Map<string, string>();
	for (const e of ALL_EMOJIS) {
		for (const k of emojiKeywords(e)) {
			if (SHORTCODE_RE.test(k) && !BY_SLUG.has(k) && !map.has(k)) map.set(k, e.char);
		}
	}
	return map;
})();

/** Resolve a bare slug or alias (no surrounding colons) to its emoji char,
 *  or `null` when nothing claims it. */
export function resolveEmojiShortcode(slug: string): string | null {
	const q = slug.toLowerCase();
	return BY_SLUG.get(q) ?? BY_ALIAS.get(q) ?? null;
}

/**
 * Rank emoji for the `:`-typeahead: slugs that START with `query` first
 * (shortest slug wins within that group, so `:grin` surfaces `grinning_face`
 * before `grinning_face_with_big_eyes`), then slugs that merely CONTAIN it.
 * An empty query returns nothing (the typeahead waits for at least one char).
 * Capped at `limit` (default 10) — the menu is a small bounded list.
 */
export function emojiShortcodeCandidates(query: string, limit = 10): EmojiData[] {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return [];
	const prefix: EmojiData[] = [];
	const contains: EmojiData[] = [];
	for (const e of ALL_EMOJIS) {
		const keys = [e.slug, ...emojiKeywords(e)];
		if (keys.some((k) => k.startsWith(q))) prefix.push(e);
		else if (keys.some((k) => k.includes(q))) contains.push(e);
	}
	prefix.sort((a, b) => a.slug.length - b.slug.length);
	return [...prefix, ...contains].slice(0, limit);
}
