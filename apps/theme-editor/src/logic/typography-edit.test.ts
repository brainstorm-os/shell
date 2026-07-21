import { FontRole, SYSTEM_TYPOGRAPHY, TypographyScale } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	isSystemTypography,
	seedTypography,
	setFontStack,
	setScale,
	setTypographyName,
} from "./typography-edit";

describe("seedTypography", () => {
	it("seeds a valid, system-equivalent typography with the given name", () => {
		const typo = seedTypography("My fonts");
		expect(typo.name).toBe("My fonts");
		expect(typo.scale).toBe(SYSTEM_TYPOGRAPHY.scale);
		expect(typo.fonts.ui.stack).toBe(SYSTEM_TYPOGRAPHY.fonts.ui.stack);
		expect(isSystemTypography(typo)).toBe(true);
	});
});

describe("immutable setters", () => {
	it("setFontStack replaces one role without mutating the source", () => {
		const a = seedTypography("X");
		const b = setFontStack(a, FontRole.Body, "Georgia, serif");
		expect(b.fonts.body.stack).toBe("Georgia, serif");
		expect(a.fonts.body.stack).toBe(SYSTEM_TYPOGRAPHY.fonts.body.stack);
	});

	it("setScale + setTypographyName are immutable", () => {
		const a = seedTypography("X");
		expect(setScale(a, TypographyScale.Compact).scale).toBe(TypographyScale.Compact);
		expect(setTypographyName(a, "Y").name).toBe("Y");
		expect(a.scale).toBe(SYSTEM_TYPOGRAPHY.scale);
		expect(a.name).toBe("X");
	});
});

describe("isSystemTypography", () => {
	it("is true for the untouched seed (name ignored)", () => {
		expect(isSystemTypography(seedTypography("Whatever"))).toBe(true);
	});

	it("is false once a stack or the scale changes", () => {
		expect(isSystemTypography(setFontStack(seedTypography("X"), FontRole.Code, "Fira Code"))).toBe(
			false,
		);
		expect(isSystemTypography(setScale(seedTypography("X"), TypographyScale.Comfortable))).toBe(
			false,
		);
	});
});
