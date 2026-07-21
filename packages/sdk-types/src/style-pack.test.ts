import { describe, expect, it } from "vitest";
import {
	EMPTY_STYLE_PACK,
	STYLE_PACK_BODY_ROOT,
	STYLE_PACK_CSS_MIME,
	STYLE_PACK_TYPE_URL,
	type StylePackDef,
	StylePackIssueCode,
	isStylePackIssueCode,
	isValidStylePack,
	resolveStylePack,
	validateStylePack,
} from "./style-pack";

function pack(over: Partial<StylePackDef> = {}): StylePackDef {
	return { name: "Polish", css: ".dashboard {}", mime: STYLE_PACK_CSS_MIME, ...over };
}

describe("constants", () => {
	it("pins the type url, mime + buffer root", () => {
		expect(STYLE_PACK_TYPE_URL).toBe("brainstorm/StylePack/v1");
		expect(STYLE_PACK_CSS_MIME).toBe("text/css");
		// Must match @brainstorm-os/editor getCodeBuffer's root so code-editor
		// binds the same buffer on cross-app open.
		expect(STYLE_PACK_BODY_ROOT).toBe("content");
	});

	it("ships an empty default with the fixed mime", () => {
		expect(EMPTY_STYLE_PACK.css).toBe("");
		expect(EMPTY_STYLE_PACK.mime).toBe(STYLE_PACK_CSS_MIME);
		expect(isValidStylePack(EMPTY_STYLE_PACK)).toBe(true);
	});
});

describe("validateStylePack", () => {
	it("accepts a well-formed pack", () => {
		expect(validateStylePack(pack())).toEqual([]);
		expect(isValidStylePack(pack())).toBe(true);
	});

	it("flags a blank name", () => {
		expect(validateStylePack(pack({ name: "  " })).map((i) => i.code)).toContain(
			StylePackIssueCode.EmptyName,
		);
	});

	it("flags a non-string css", () => {
		expect(
			validateStylePack(pack({ css: undefined as unknown as string })).map((i) => i.code),
		).toContain(StylePackIssueCode.MissingCss);
	});

	it("flags a wrong mime", () => {
		expect(validateStylePack(pack({ mime: "text/plain" })).map((i) => i.code)).toContain(
			StylePackIssueCode.WrongMime,
		);
	});

	it("empty css is structurally valid (sanitizer handles content)", () => {
		expect(isValidStylePack(pack({ css: "" }))).toBe(true);
	});
});

describe("resolveStylePack", () => {
	it("normalizes a partial / malformed payload, never throwing", () => {
		expect(resolveStylePack(null)).toEqual(EMPTY_STYLE_PACK);
		expect(resolveStylePack({ css: ".x{}" })).toEqual({
			name: EMPTY_STYLE_PACK.name,
			css: ".x{}",
			mime: STYLE_PACK_CSS_MIME,
		});
		expect(resolveStylePack({ name: "P", mime: "bogus" }).mime).toBe(STYLE_PACK_CSS_MIME);
	});
});

describe("isStylePackIssueCode", () => {
	it("guards the enum", () => {
		expect(isStylePackIssueCode(StylePackIssueCode.EmptyName)).toBe(true);
		expect(isStylePackIssueCode("nope")).toBe(false);
	});
});
