import { describe, expect, it } from "vitest";
import { CODE_EDITOR_MESSAGES, t } from "./i18n";

describe("code-editor i18n", () => {
	it("returns the English default for a known key", () => {
		expect(t("appTitle")).toBe("Code");
		expect(t("filesHeading")).toBe("Files");
	});

	it("interpolates {name}-style params", () => {
		expect(t("bufferLabel", { name: "greet.ts" })).toBe("Source of greet.ts");
		expect(t("metaUnsaved", { count: 3, dirty: 1 })).toBe("3 files · 1 unsaved");
		expect(t("menuMoreActions", { name: "fib.py" })).toBe("More actions for fib.py");
	});

	it("has no unbalanced interpolation placeholders in the manifest", () => {
		for (const [key, template] of Object.entries(CODE_EDITOR_MESSAGES)) {
			expect(template, `${key} must be a non-empty string`).toBeTruthy();
			const opens = (template.match(/\{/g) ?? []).length;
			const closes = (template.match(/\}/g) ?? []).length;
			expect(opens, `${key} placeholder braces must balance`).toBe(closes);
		}
	});

	it("provides a localised Open label distinct from the app title", () => {
		expect(t("menuOpen")).toBe("Open");
		expect(t("menuOpen")).not.toBe(t("appTitle"));
	});
});
