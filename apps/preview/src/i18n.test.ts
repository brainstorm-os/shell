/**
 * Preview i18n manifest — every key resolves and every `{placeholder}`
 * declared in the manifest interpolates. Guards against a bare-literal
 * regression slipping back into app.ts / inspector.ts (the keys here are
 * the contract those files consume).
 */

import { describe, expect, it } from "vitest";
import { PREVIEW_I18N, type PreviewI18nKey, t } from "./i18n";

describe("preview i18n", () => {
	it("resolves every manifest key to its English default", () => {
		for (const key of Object.keys(PREVIEW_I18N) as PreviewI18nKey[]) {
			expect(t(key)).toBe(PREVIEW_I18N[key]);
		}
	});

	it("interpolates the counter position", () => {
		expect(t("counter.position", { index: 2, total: 7 })).toBe("2 of 7");
	});

	it("interpolates the stage error keys", () => {
		expect(t("stage.noPreviewFor", { mime: "image/heic" })).toBe("No preview for image/heic");
		expect(t("stage.rendererNotWired", { kind: "pdf" })).toBe(
			"No preview available for pdf files yet.",
		);
		expect(t("stage.rendererFailed", { detail: "boom" })).toBe("Renderer failed: boom");
	});

	it("interpolates singular vs plural item counts", () => {
		expect(t("context.itemCount.one", { count: 1 })).toBe("1 item");
		expect(t("context.itemCount.other", { count: 4 })).toBe("4 items");
	});

	it("degrades an unknown key to the key string (no crash)", () => {
		expect(t("does.not.exist" as PreviewI18nKey)).toBe("does.not.exist");
	});
});
