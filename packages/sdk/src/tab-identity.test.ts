// @vitest-environment happy-dom

import { IconKind, TAB_ICON_NONE } from "@brainstorm-os/sdk-types";
import { beforeEach, describe, expect, it } from "vitest";
import { publishTabIdentity } from "./tab-identity";

function iconLink(): HTMLLinkElement | null {
	return document.head.querySelector('link[rel="icon"][data-bs-tab-icon]');
}

describe("publishTabIdentity", () => {
	beforeEach(() => {
		document.title = "";
		iconLink()?.remove();
	});

	it("sets the document title and an emoji SVG favicon", () => {
		publishTabIdentity({ title: "capability-check.ts", icon: { kind: IconKind.Emoji, value: "📝" } });
		expect(document.title).toBe("capability-check.ts");
		const href = iconLink()?.getAttribute("href") ?? "";
		expect(href.startsWith("data:image/svg+xml,")).toBe(true);
		expect(decodeURIComponent(href)).toContain("📝");
	});

	it("passes image icons through as their brainstorm:// URL", () => {
		publishTabIdentity({
			title: "Note",
			icon: { kind: IconKind.Image, value: "brainstorm://icon/abc.png" },
		});
		expect(iconLink()?.getAttribute("href")).toBe("brainstorm://icon/abc.png");
	});

	it("publishes the explicit no-icon favicon for null/pack icons", () => {
		publishTabIdentity({ title: "A", icon: { kind: IconKind.Emoji, value: "📝" } });
		publishTabIdentity({ title: "A", icon: null });
		expect(iconLink()?.getAttribute("href")).toBe(TAB_ICON_NONE);
		publishTabIdentity({ title: "A", icon: { kind: IconKind.Pack, value: "phosphor/files" } });
		expect(iconLink()?.getAttribute("href")).toBe(TAB_ICON_NONE);
	});

	it("reuses one link element across publishes", () => {
		publishTabIdentity({ title: "A", icon: { kind: IconKind.Emoji, value: "📝" } });
		publishTabIdentity({ title: "B", icon: { kind: IconKind.Emoji, value: "📘" } });
		expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
		expect(document.title).toBe("B");
	});

	it("escapes XML-significant characters in malformed emoji values", () => {
		publishTabIdentity({
			title: "A",
			icon: { kind: IconKind.Emoji, value: '<script>"x"</script>' },
		});
		const href = iconLink()?.getAttribute("href") ?? "";
		expect(decodeURIComponent(href)).not.toContain("<script>");
	});
});
