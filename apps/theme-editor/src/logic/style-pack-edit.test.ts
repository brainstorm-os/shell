import { EMPTY_STYLE_PACK, STYLE_PACK_CSS_MIME } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { hasStylePackCss, setStylePackCss, setStylePackName } from "./style-pack-edit";

describe("style-pack-edit", () => {
	it("setStylePackCss is immutable + pins mime", () => {
		const next = setStylePackCss(EMPTY_STYLE_PACK, ".x{}");
		expect(next).not.toBe(EMPTY_STYLE_PACK);
		expect(next.css).toBe(".x{}");
		expect(next.mime).toBe(STYLE_PACK_CSS_MIME);
		expect(EMPTY_STYLE_PACK.css).toBe("");
	});

	it("setStylePackName is immutable", () => {
		expect(setStylePackName(EMPTY_STYLE_PACK, "Neon").name).toBe("Neon");
		expect(EMPTY_STYLE_PACK.name).toBe("Untitled style pack");
	});

	it("hasStylePackCss ignores whitespace-only", () => {
		expect(hasStylePackCss(EMPTY_STYLE_PACK)).toBe(false);
		expect(hasStylePackCss(setStylePackCss(EMPTY_STYLE_PACK, "  \n "))).toBe(false);
		expect(hasStylePackCss(setStylePackCss(EMPTY_STYLE_PACK, ".x{}"))).toBe(true);
	});
});
