import { SkinTone } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { SKIN_TONE_BASE_CHARS, applySkinTone, emojiFilename } from "./emoji-data";

describe("applySkinTone", () => {
	it("passes through when tone is None", () => {
		expect(applySkinTone("👋", SkinTone.None)).toBe("👋");
	});

	it("passes through emojis that don't support skin tones", () => {
		expect(applySkinTone("😀", SkinTone.Dark)).toBe("😀");
		expect(applySkinTone("🐶", SkinTone.Light)).toBe("🐶");
	});

	it("appends modifier for single-codepoint base", () => {
		const result = applySkinTone("👋", SkinTone.Dark);
		expect(emojiFilename(result)).toBe("1f44b-1f3ff.webp");
	});

	it("inserts modifier after the base of a ZWJ sequence", () => {
		const result = applySkinTone("👨‍🦰", SkinTone.Dark);
		expect(emojiFilename(result)).toBe("1f468-1f3ff-200d-1f9b0.webp");
	});

	it("drops a trailing VS-16 immediately after the base", () => {
		const result = applySkinTone("🖐️", SkinTone.Light);
		expect(emojiFilename(result)).toBe("1f590-1f3fb.webp");
	});

	it("keeps a VS-16 that sits past the base codepoint", () => {
		const result = applySkinTone("🧔‍♂️", SkinTone.Light);
		expect(emojiFilename(result)).toBe("1f9d4-1f3fb-200d-2642-fe0f.webp");
	});

	it("covers every people-body emoji marked as supporting skin tones", () => {
		expect(SKIN_TONE_BASE_CHARS.has("👋")).toBe(true);
		expect(SKIN_TONE_BASE_CHARS.has("👨‍🦰")).toBe(true);
		expect(SKIN_TONE_BASE_CHARS.has("😀")).toBe(false);
	});
});
