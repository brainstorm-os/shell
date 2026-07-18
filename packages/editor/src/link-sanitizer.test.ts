// @vitest-environment jsdom
/**
 * Repro for the friction-log residue "Lexical `LinkNode.sanitizeUrl`
 * renders any non-http(s) anchor as `about:blank`": a LinkNode whose url
 * is a `brainstorm://entity/<id>` (Mod+K link markup) or an imported
 * `brainstorm://asset/<id>` (PDF file link) must paint its real href —
 * the Notes click interceptor reads the DOM href, and `about:blank`
 * made every such anchor inert. Without the `link-sanitizer` prototype
 * override (side-effect-imported via `./nodes`), the `createDOM` cases
 * below fail with `href="about:blank"`.
 */

import { AutoLinkNode, LinkNode } from "@lexical/link";
import type { EditorConfig } from "lexical";
import { describe, expect, it } from "vitest";
import { createBrainstormHeadlessEditor } from "./headless";
import { ALLOWED_LINK_PROTOCOLS, sanitizeLinkUrl } from "./link-sanitizer";

/** Lexical 0.21 node ops must run inside an active editor. */
function inEditor<T>(fn: () => T): T {
	const editor = createBrainstormHeadlessEditor();
	let out!: T;
	editor.update(
		() => {
			out = fn();
		},
		{ discrete: true },
	);
	return out;
}

const CONFIG = { theme: {} } as EditorConfig;

function renderedHref(url: string): string | null {
	return inEditor(() => new LinkNode(url).createDOM(CONFIG).getAttribute("href"));
}

describe("LinkNode brainstorm:// anchors (link-sanitizer override)", () => {
	it("renders a brainstorm://entity link with its real href, not about:blank", () => {
		expect(renderedHref("brainstorm://entity/n_1")).toBe("brainstorm://entity/n_1");
	});

	it("renders an imported brainstorm://asset file link with its real href", () => {
		expect(renderedHref("brainstorm://asset/a_9f3")).toBe("brainstorm://asset/a_9f3");
	});

	it("keeps a block-anchored entity href intact", () => {
		expect(renderedHref("brainstorm://entity/n_1#block-b2")).toBe("brainstorm://entity/n_1#block-b2");
	});

	it("still renders http(s) and mailto links unchanged", () => {
		expect(renderedHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
		expect(renderedHref("http://example.com/")).toBe("http://example.com/");
		expect(renderedHref("mailto:kim@example.com")).toBe("mailto:kim@example.com");
	});

	it("still defangs executable / unknown schemes to about:blank", () => {
		// eslint-disable-next-line no-script-url
		expect(renderedHref("javascript:alert(1)")).toBe("about:blank");
		expect(renderedHref("data:text/html,<b>x</b>")).toBe("about:blank");
		expect(renderedHref("file:///etc/passwd")).toBe("about:blank");
		expect(renderedHref("vbscript:msgbox")).toBe("about:blank");
	});

	it("covers AutoLinkNode via inheritance", () => {
		const href = inEditor(() =>
			new AutoLinkNode("javascript:alert(1)").createDOM(CONFIG).getAttribute("href"),
		);
		expect(href).toBe("about:blank");
	});
});

describe("sanitizeLinkUrl", () => {
	it("keeps the allowlist strict: http, https, mailto, brainstorm only", () => {
		expect([...ALLOWED_LINK_PROTOCOLS].sort()).toEqual(["brainstorm:", "http:", "https:", "mailto:"]);
		// Lexical's default allowed sms/tel — nothing in the app mints them,
		// so the strict list drops them.
		expect(sanitizeLinkUrl("tel:+1555")).toBe("about:blank");
		expect(sanitizeLinkUrl("sms:+1555")).toBe("about:blank");
	});

	it("passes non-absolute URLs through unchanged (upstream contract)", () => {
		expect(sanitizeLinkUrl("#block-abc")).toBe("#block-abc");
		expect(sanitizeLinkUrl("./relative/path")).toBe("./relative/path");
	});
});
