/**
 * Full emoji metadata — sourced from `unicode-emoji-json` (Unicode 15.x).
 * The shell bundles 3921 WebP glyphs from the iamcal/img-apple-160 set
 * keyed by `<codepoint>.webp`; this module exposes the metadata side so
 * the picker can group, search, and display every emoji that has art.
 *
 * Emojis whose WebP isn't in our bundle (rare — usually new Unicode
 * additions post-dating the iamcal release we shipped) render an
 * `onerror` fallback via the cell component, so a missing image never
 * leaves a broken row.
 *
 * Helpers `emojiFilename` and `emojiUrl` mirror the shell's algorithm.
 */

import { SkinTone as ST, type SkinTone } from "@brainstorm-os/sdk-types";
import emojisByGroup from "unicode-emoji-json/data-by-group.json";

export type EmojiData = {
	char: string;
	name: string;
	slug: string;
	skinToneSupport: boolean;
};

export type EmojiGroup = {
	name: string;
	slug: string;
	emojis: readonly EmojiData[];
};

type RawEmoji = {
	emoji: string;
	name: string;
	slug: string;
	skin_tone_support: boolean;
};

type RawGroup = {
	name: string;
	slug: string;
	emojis: RawEmoji[];
};

export const EMOJI_GROUPS: readonly EmojiGroup[] = (emojisByGroup as RawGroup[])
	.filter((g) => g.slug !== "component")
	.map((g) => ({
		name: g.name,
		slug: g.slug,
		emojis: g.emojis.map((e) => ({
			char: e.emoji,
			name: e.name,
			slug: e.slug,
			skinToneSupport: e.skin_tone_support,
		})),
	}));

export const ALL_EMOJIS: readonly EmojiData[] = EMOJI_GROUPS.flatMap((g) => g.emojis);

export const SKIN_TONE_BASE_CHARS: ReadonlySet<string> = new Set(
	ALL_EMOJIS.filter((e) => e.skinToneSupport).map((e) => e.char),
);

const VS16 = "️";

/** Apply a Fitzpatrick skin-tone modifier to an emoji character. The
 *  modifier is inserted directly after the base codepoint, before any ZWJ
 *  sequence — matching the iamcal/emoji-data filename convention this
 *  picker bundles. A trailing VS-16 immediately after the base codepoint
 *  is dropped because the Fitzpatrick modifier already forces emoji
 *  presentation, and the bundled asset names omit it in that position
 *  (e.g. `1f590-fe0f.webp` becomes `1f590-1f3fb.webp`). Emojis without
 *  skin-tone support pass through unchanged. */
export function applySkinTone(char: string, tone: SkinTone): string {
	if (tone === ST.None) return char;
	if (!SKIN_TONE_BASE_CHARS.has(char)) return char;
	const codePoints = Array.from(char);
	const base = codePoints[0];
	if (base === undefined) return char;
	const modifier = String.fromCodePoint(Number.parseInt(tone, 16));
	const rest = codePoints.slice(1);
	if (rest[0] === VS16) rest.shift();
	return base + modifier + rest.join("");
}

export function emojiFilename(char: string): string {
	const parts: string[] = [];
	for (const c of char) {
		const cp = c.codePointAt(0);
		if (cp === undefined) continue;
		parts.push(cp.toString(16));
	}
	return `${parts.join("-")}.webp`;
}

export function emojiUrl(char: string): string {
	return `brainstorm://emoji/${emojiFilename(char)}`;
}

/** Case-insensitive substring search across name + slug, returns a flat
 *  list ordered by group → original index (matches the visible order). */
export function searchEmojis(query: string): readonly EmojiData[] {
	const q = query.trim().toLowerCase();
	if (!q) return ALL_EMOJIS;
	const matches: EmojiData[] = [];
	for (const e of ALL_EMOJIS) {
		if (e.name.includes(q) || e.slug.includes(q)) matches.push(e);
	}
	return matches;
}
