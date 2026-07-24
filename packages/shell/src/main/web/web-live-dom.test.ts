import { describe, expect, it } from "vitest";
import {
	EXTRACTED_TEXT_MAX_CHARS,
	LIVE_DOM_MAX_CHARS,
	clampLiveDomHtml,
	toExtractedText,
} from "./web-live-dom";

describe("clampLiveDomHtml", () => {
	it("passes an ordinary document through untouched", () => {
		const html = "<html><body><p>hi</p></body></html>";
		expect(clampLiveDomHtml(html)).toBe(html);
	});

	it("takes the prefix of an enormous document rather than hanging on it", () => {
		const clamped = clampLiveDomHtml("x".repeat(LIVE_DOM_MAX_CHARS + 5_000));
		expect(clamped.length).toBe(LIVE_DOM_MAX_CHARS);
	});
});

describe("toExtractedText", () => {
	const base = { url: "https://a.test/post", fallbackTitle: "Tab title" };

	it("projects an extraction into the wire shape", () => {
		expect(
			toExtractedText({ ...base, extractedTitle: "The Article", textContent: "  body  " }),
		).toEqual({
			url: "https://a.test/post",
			title: "The Article",
			text: "body",
			truncated: false,
		});
	});

	it("falls back to the tab's title when the extractor found none", () => {
		expect(toExtractedText({ ...base, extractedTitle: null, textContent: "body" })?.title).toBe(
			"Tab title",
		);
		expect(toExtractedText({ ...base, extractedTitle: "   ", textContent: "body" })?.title).toBe(
			"Tab title",
		);
	});

	it("caps the text and FLAGS the truncation (never silently elides)", () => {
		const result = toExtractedText({
			...base,
			textContent: "y".repeat(EXTRACTED_TEXT_MAX_CHARS + 10),
		});
		expect(result?.text.length).toBe(EXTRACTED_TEXT_MAX_CHARS);
		expect(result?.truncated).toBe(true);
	});

	it("returns null when the page yielded nothing readable", () => {
		expect(toExtractedText({ ...base, textContent: "" })).toBeNull();
		expect(toExtractedText({ ...base, textContent: "   \n\t " })).toBeNull();
	});
});
