import { describe, expect, it } from "vitest";
import { WHITEBOARD_MANIFEST, createT } from "./t";

const t = createT();

describe("createT() (over @brainstorm-os/sdk/i18n)", () => {
	it("returns the default-English string for a known key", () => {
		expect(t("whiteboard.zoom.in")).toBe("Zoom in");
	});

	it("interpolates {param} placeholders", () => {
		expect(t("whiteboard.zoom.level", { percent: 150 })).toBe("150%");
		expect(t("whiteboard.node.group.aria", { count: 3 })).toBe("Group of 3 items");
	});

	it("leaves an unsupplied {param} as the `{name}` literal", () => {
		expect(t("whiteboard.node.sticky.aria")).toBe("Sticky note: {text}");
	});

	it("applies host overrides without mutating the manifest", () => {
		const localized = createT({ "whiteboard.zoom.in": "Agrandir" });
		expect(localized("whiteboard.zoom.in")).toBe("Agrandir");
		expect(t("whiteboard.zoom.in")).toBe("Zoom in");
	});

	it("exposes every key it declares as a non-empty default", () => {
		for (const [key, value] of Object.entries(WHITEBOARD_MANIFEST)) {
			expect(value.length, key).toBeGreaterThan(0);
		}
	});
});
