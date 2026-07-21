/**
 * B11.1 — emoji shortcode shortcut: typing `:grinning_face:` (the Unicode
 * `slug` the picker + `@brainstorm-os/sdk/icon-picker` already use) rewrites to
 * the emoji glyph as you type the closing `:`.
 *
 * An `@lexical/markdown` `TextMatchTransformer` on the editor's
 * `MarkdownShortcutPlugin` list — the same proven on-type pipeline the unicode
 * shortcuts ride. An unknown slug is a no-op (the `:foo:` text stays literal),
 * so the shortcut never eats a colon the user meant to keep. The `:`-triggered
 * fuzzy typeahead (`emojiShortcodeCandidates`) is the discoverability layer + a
 * separate editor follow-up; this is the exact-slug rewrite.
 */

import { EMOJI_SHORTCODE_BODY, resolveEmojiShortcode } from "@brainstorm-os/sdk/icon-picker";
import type { TextMatchTransformer } from "@lexical/markdown";
import type { TextNode } from "lexical";

export const EMOJI_SHORTCODE_TRANSFORMER: TextMatchTransformer = {
	dependencies: [],
	// Glyphs don't round-trip back to `:slug:`, so export is inert.
	export: () => null,
	importRegExp: new RegExp(`:(${EMOJI_SHORTCODE_BODY}):`),
	regExp: new RegExp(`:(${EMOJI_SHORTCODE_BODY}):$`),
	replace: (textNode: TextNode, match: RegExpMatchArray) => {
		const char = resolveEmojiShortcode(match[1] ?? "");
		if (!char) return; // unknown slug — leave the `:foo:` text untouched
		textNode.spliceText(match.index ?? 0, match[0].length, char, true);
	},
	trigger: ":",
	type: "text-match",
};
