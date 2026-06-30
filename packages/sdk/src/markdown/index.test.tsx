/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockKind, Markdown, isSafeLinkUrl, parseMarkdown, wordCountForMarkdown } from "./index";

describe("parseMarkdown", () => {
	it("parses headings, lists, code fences, and rules", () => {
		const blocks = parseMarkdown(
			"# Title\n\nsome **text**\n\n- one\n- two\n\n```ts\ncode()\n```\n\n---",
		);
		expect(blocks.map((b) => b.kind)).toEqual([
			BlockKind.Heading,
			BlockKind.Paragraph,
			BlockKind.BulletList,
			BlockKind.CodeFence,
			BlockKind.HorizontalRule,
		]);
	});

	it("only treats known web schemes as safe links", () => {
		expect(isSafeLinkUrl("https://x.com")).toBe(true);
		expect(isSafeLinkUrl("brainstorm://asset/1")).toBe(true);
		expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
		expect(isSafeLinkUrl("n_abc123")).toBe(false);
	});

	it("counts words across headings, paragraphs and lists", () => {
		expect(wordCountForMarkdown("# a b\n\nc d e\n\n- f")).toBe(6);
	});
});

describe("<Markdown>", () => {
	let host: HTMLElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});
	afterEach(() => {
		flushSync(() => root.unmount());
		host.remove();
	});

	function render(node: Parameters<typeof root.render>[0]): void {
		flushSync(() => root.render(node));
	}

	it("renders markdown structure as real elements, not literal text", () => {
		render(createElement(Markdown, { source: "## Heading\n\n- **bold** item\n\n`code`" }));
		expect(host.querySelector("h2")?.textContent).toBe("Heading");
		expect(host.querySelector("ul li strong")?.textContent).toBe("bold");
		expect(host.querySelector("code")?.textContent).toBe("code");
		// the raw markers must NOT survive as text
		expect(host.textContent).not.toContain("##");
		expect(host.textContent).not.toContain("**");
	});

	it("renders safe links as anchors and drops unsafe schemes to text", () => {
		render(
			createElement(Markdown, {
				source: "[ok](https://x.com) and [bad](javascript:alert(1))",
			}),
		);
		const a = host.querySelector("a");
		expect(a?.getAttribute("href")).toBe("https://x.com");
		expect(a?.getAttribute("rel")).toBe("noreferrer noopener");
		expect(host.querySelectorAll("a")).toHaveLength(1);
		expect(host.textContent).toContain("bad"); // unsafe link → plain text
	});

	it("routes non-web links through the entity-link resolver as buttons", () => {
		const open = vi.fn();
		render(
			createElement(Markdown, {
				source: "see [the note](n_abc123)",
				onEntityLink: (t) => (t === "n_abc123" ? () => open(t) : null),
			}),
		);
		const btn = host.querySelector("button.bs-markdown__entity-link") as HTMLButtonElement | null;
		expect(btn?.textContent).toBe("the note");
		btn?.click();
		expect(open).toHaveBeenCalledWith("n_abc123");
	});

	it("is XSS-safe — raw HTML in the source becomes text, never markup", () => {
		render(createElement(Markdown, { source: "<img src=x onerror=alert(1)>" }));
		expect(host.querySelector("img")).toBeNull();
		expect(host.textContent).toContain("<img");
	});
});
