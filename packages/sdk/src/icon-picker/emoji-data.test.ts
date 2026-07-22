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

describe("emojiFilename", () => {
	it("zero-pads BMP codepoints < U+1000 to 4 hex digits (matches the art pack)", () => {
		// The bug: without padding these 404'd and rendered blank in the picker.
		expect(emojiFilename("0️⃣")).toBe("0030-fe0f-20e3.webp");
		expect(emojiFilename("9️⃣")).toBe("0039-fe0f-20e3.webp");
		expect(emojiFilename("#️⃣")).toBe("0023-fe0f-20e3.webp");
		expect(emojiFilename("*️⃣")).toBe("002a-fe0f-20e3.webp");
		expect(emojiFilename("©️")).toBe("00a9-fe0f.webp");
		expect(emojiFilename("®️")).toBe("00ae-fe0f.webp");
	});

	it("leaves codepoints already ≥ 4 hex digits unchanged", () => {
		expect(emojiFilename("👋")).toBe("1f44b.webp");
		expect(emojiFilename("❤️")).toBe("2764-fe0f.webp");
		expect(emojiFilename("👨‍💻")).toBe("1f468-200d-1f4bb.webp");
	});
});
