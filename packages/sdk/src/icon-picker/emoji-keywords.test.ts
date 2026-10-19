import { describe, expect, it } from "vitest";
import { ALL_EMOJIS, searchEmojis } from "./emoji-data";
import { EMOJI_KEYWORDS } from "./emoji-keywords";
import { emojiShortcodeCandidates, resolveEmojiShortcode } from "./emoji-shortcode";

/** The common names people type that the Unicode name/slug does NOT contain
 *  ("coffee" is `hot_beverage`, "heart" alone has no exact slug, "check" is
 *  `check_mark_button`). Each must hit from the picker search. */
const COMMON_QUERIES: ReadonlyArray<[string, string]> = [
	["coffee", "☕"],
	["heart", "❤️"],
	["check", "✅"],
	["rocket", "🚀"],
	["fire", "🔥"],
];

describe("emoji search keywords", () => {
	for (const [query, expected] of COMMON_QUERIES) {
		it(`"${query}" returns at least one hit, including ${expected}`, () => {
			const hits = searchEmojis(query);
			expect(hits.length).toBeGreaterThan(0);
			expect(hits.map((e) => e.char)).toContain(expected);
		});
	}

	it("is case-insensitive and tolerant of surrounding whitespace", () => {
		expect(searchEmojis("  Coffee ").map((e) => e.char)).toContain("☕");
	});

	it("every keyword alias targets a slug that exists in the dataset", () => {
		const slugs = new Set(ALL_EMOJIS.map((e) => e.slug));
		const missing = Object.keys(EMOJI_KEYWORDS).filter((slug) => !slugs.has(slug));
		expect(missing).toEqual([]);
	});

	it("resolves a keyword as a `:shortcode:` too", () => {
		expect(resolveEmojiShortcode("coffee")).toBe("☕");
		expect(emojiShortcodeCandidates("coffee").map((e) => e.char)).toContain("☕");
	});

	it("still resolves a real slug ahead of any alias", () => {
		expect(resolveEmojiShortcode("hot_beverage")).toBe("☕");
	});
});
