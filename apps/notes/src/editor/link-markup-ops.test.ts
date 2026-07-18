// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	BRAINSTORM_ENTITY_LINK_PREFIX,
	LinkClickAction,
	buildEntityLinkUrl,
	findBinaryLinkFromEvent,
	findEntityLinkFromEvent,
	findMentionFromEvent,
	isBrainstormBinaryUrl,
	resolveLinkClick,
	triggerBinaryLinkDownload,
} from "./link-markup-ops";

describe("buildEntityLinkUrl", () => {
	it("prefixes the entity id with the canonical scheme", () => {
		expect(buildEntityLinkUrl("n_abc")).toBe("brainstorm://entity/n_abc");
		expect(buildEntityLinkUrl("n_abc")).toMatch(new RegExp(`^${BRAINSTORM_ENTITY_LINK_PREFIX}`));
	});

	it("preserves long ids verbatim — no encoding of opaque payloads", () => {
		const id = "ent_2026-05-13_xyz123_abcdef";
		expect(buildEntityLinkUrl(id)).toBe(`brainstorm://entity/${id}`);
	});

	it("throws on empty id (defensive — picker shouldn't surface those)", () => {
		expect(() => buildEntityLinkUrl("")).toThrowError();
		expect(() => buildEntityLinkUrl("   ")).toThrowError();
	});
});

describe("resolveLinkClick", () => {
	it("returns OpenEntity for a clean brainstorm:// URI", () => {
		expect(resolveLinkClick({ href: "brainstorm://entity/n_target" })).toEqual({
			action: LinkClickAction.OpenEntity,
			entityId: "n_target",
		});
	});

	it("strips a non-block #anchor / ?query from the parsed entity id", () => {
		expect(resolveLinkClick({ href: "brainstorm://entity/n_target#p3" })).toEqual({
			action: LinkClickAction.OpenEntity,
			entityId: "n_target",
		});
		expect(resolveLinkClick({ href: "brainstorm://entity/n_target?source=editor" })).toEqual({
			action: LinkClickAction.OpenEntity,
			entityId: "n_target",
		});
	});

	it("carries a #block-<id> anchor through as blockId (B11.13)", () => {
		expect(resolveLinkClick({ href: "brainstorm://entity/n_target#block-anchor7" })).toEqual({
			action: LinkClickAction.OpenEntity,
			entityId: "n_target",
			blockId: "anchor7",
		});
	});

	it("omits blockId for a malformed block fragment", () => {
		const decision = resolveLinkClick({ href: "brainstorm://entity/n_target#block-" });
		expect(decision).toEqual({
			action: LinkClickAction.OpenEntity,
			entityId: "n_target",
		});
	});

	it("passes through external https links", () => {
		expect(resolveLinkClick({ href: "https://anthropic.com" })).toEqual({
			action: LinkClickAction.PassThrough,
		});
	});

	it("passes through other-scheme links", () => {
		expect(resolveLinkClick({ href: "mailto:hi@example.com" })).toEqual({
			action: LinkClickAction.PassThrough,
		});
		expect(resolveLinkClick({ href: "ftp://files.example.com" })).toEqual({
			action: LinkClickAction.PassThrough,
		});
	});

	it("passes through empty / null / undefined hrefs", () => {
		expect(resolveLinkClick({ href: "" })).toEqual({ action: LinkClickAction.PassThrough });
		expect(resolveLinkClick({ href: null })).toEqual({ action: LinkClickAction.PassThrough });
		expect(resolveLinkClick({ href: undefined })).toEqual({
			action: LinkClickAction.PassThrough,
		});
	});

	it("passes through modifier-held clicks so the browser keeps its default behaviour", () => {
		expect(resolveLinkClick({ href: "brainstorm://entity/n_target", hasModifier: true })).toEqual({
			action: LinkClickAction.PassThrough,
		});
	});

	it("rejects a bare brainstorm://entity/ (no id) — those are malformed", () => {
		expect(resolveLinkClick({ href: "brainstorm://entity/" })).toEqual({
			action: LinkClickAction.PassThrough,
		});
	});
});

describe("findEntityLinkFromEvent", () => {
	function makeRoot(html: string): HTMLDivElement {
		const root = document.createElement("div");
		root.innerHTML = html;
		document.body.append(root);
		return root;
	}

	function cleanup(root: HTMLDivElement) {
		root.remove();
	}

	it("returns the nearest entity-link anchor + parsed id when the click lands inside one", () => {
		const root = makeRoot('<p><a href="brainstorm://entity/n_target"><span>target</span></a></p>');
		const span = root.querySelector("span");
		if (!span) throw new Error("seed missing");
		const match = findEntityLinkFromEvent(span, root);
		expect(match).not.toBeNull();
		expect(match?.entityId).toBe("n_target");
		expect(match?.anchor.getAttribute("href")).toBe("brainstorm://entity/n_target");
		cleanup(root);
	});

	it("carries the anchor's data-entity-type so the open reaches the type-specific opener", () => {
		const root = makeRoot(
			'<a href="brainstorm://entity/ent_q3" data-entity-type="io.brainstorm.database/List/v1"><span>Q3</span></a>',
		);
		const span = root.querySelector("span");
		if (!span) throw new Error("seed missing");
		const match = findEntityLinkFromEvent(span, root);
		expect(match?.entityId).toBe("ent_q3");
		expect(match?.entityType).toBe("io.brainstorm.database/List/v1");
		cleanup(root);
	});

	it("omits entityType when the anchor carries none (plain link-markup)", () => {
		const root = makeRoot('<a href="brainstorm://entity/n_target"><span>t</span></a>');
		const span = root.querySelector("span");
		if (!span) throw new Error("seed missing");
		const match = findEntityLinkFromEvent(span, root);
		expect(match?.entityId).toBe("n_target");
		expect(match?.entityType).toBeUndefined();
		cleanup(root);
	});

	it("returns null for clicks on external https anchors", () => {
		const root = makeRoot('<p><a href="https://anthropic.com">external</a></p>');
		const a = root.querySelector("a");
		if (!a) throw new Error("seed missing");
		expect(findEntityLinkFromEvent(a, root)).toBeNull();
		cleanup(root);
	});

	it("returns null for clicks landing outside any anchor", () => {
		const root = makeRoot("<p>plain text</p>");
		const p = root.querySelector("p");
		if (!p) throw new Error("seed missing");
		expect(findEntityLinkFromEvent(p, root)).toBeNull();
		cleanup(root);
	});

	it("returns null when the target is not an Element (e.g. document)", () => {
		const root = makeRoot('<a href="brainstorm://entity/n_x">x</a>');
		expect(findEntityLinkFromEvent(null, root)).toBeNull();
		expect(findEntityLinkFromEvent(document, root)).toBeNull();
		cleanup(root);
	});

	it("does not match anchors outside the supplied root (boundary check)", () => {
		const root = makeRoot("<p>inside</p>");
		const sibling = document.createElement("a");
		sibling.setAttribute("href", "brainstorm://entity/n_x");
		document.body.append(sibling);
		expect(findEntityLinkFromEvent(sibling, root)).toBeNull();
		sibling.remove();
		cleanup(root);
	});
});

describe("findMentionFromEvent", () => {
	function makeRoot(html: string): HTMLDivElement {
		const root = document.createElement("div");
		root.innerHTML = html;
		document.body.append(root);
		return root;
	}

	function cleanup(root: HTMLDivElement) {
		root.remove();
	}

	// Mirrors MentionNode.createDOM: an outer span carrying both
	// data-entity-id + data-entity-type, with an inner decorator chip that
	// only carries the id.
	const MENTION_HTML =
		'<p><span class="notes__mention" data-entity-id="n_target" data-entity-type="io.brainstorm.notes/Note/v1">' +
		'<span class="notes__mention-chip" data-entity-id="n_target">' +
		'<span class="notes__mention-at">@</span><span class="notes__mention-label">Target</span>' +
		"</span></span></p>";

	it("resolves id + type when the click lands on the inner label span", () => {
		const root = makeRoot(MENTION_HTML);
		const label = root.querySelector(".notes__mention-label");
		if (!label) throw new Error("seed missing");
		expect(findMentionFromEvent(label, root)).toEqual({
			entityId: "n_target",
			entityType: "io.brainstorm.notes/Note/v1",
		});
		cleanup(root);
	});

	it("resolves from the outer node element too", () => {
		const root = makeRoot(MENTION_HTML);
		const node = root.querySelector(".notes__mention");
		if (!node) throw new Error("seed missing");
		expect(findMentionFromEvent(node, root)?.entityId).toBe("n_target");
		cleanup(root);
	});

	it("returns null on plain text and on entity-link anchors (not mentions)", () => {
		const root = makeRoot(
			'<p>plain</p><a href="brainstorm://entity/n_x" data-entity-id="n_x">link</a>',
		);
		const p = root.querySelector("p");
		const a = root.querySelector("a");
		if (!p || !a) throw new Error("seed missing");
		expect(findMentionFromEvent(p, root)).toBeNull();
		// The anchor has data-entity-id but no data-entity-type → not a mention.
		expect(findMentionFromEvent(a, root)).toBeNull();
		cleanup(root);
	});

	it("returns null for an empty entity id (half-built node) and non-Element targets", () => {
		const root = makeRoot(
			'<span class="notes__mention" data-entity-id="" data-entity-type="io.brainstorm.notes/Note/v1">x</span>',
		);
		const span = root.querySelector("span");
		if (!span) throw new Error("seed missing");
		expect(findMentionFromEvent(span, root)).toBeNull();
		expect(findMentionFromEvent(null, root)).toBeNull();
		expect(findMentionFromEvent(document, root)).toBeNull();
		cleanup(root);
	});

	it("does not match a mention outside the supplied root (boundary check)", () => {
		const root = makeRoot("<p>inside</p>");
		const sibling = document.createElement("span");
		sibling.setAttribute("data-entity-id", "n_x");
		sibling.setAttribute("data-entity-type", "io.brainstorm.notes/Note/v1");
		document.body.append(sibling);
		expect(findMentionFromEvent(sibling, root)).toBeNull();
		sibling.remove();
		cleanup(root);
	});
});

describe("binary brainstorm:// link routing (imported PDF / uploaded file anchors)", () => {
	function makeRoot(html: string): HTMLDivElement {
		const root = document.createElement("div");
		root.innerHTML = html;
		document.body.append(root);
		return root;
	}

	it("recognises asset and app-file URLs, and nothing else", () => {
		expect(isBrainstormBinaryUrl("brainstorm://asset/a_9f3")).toBe(true);
		expect(isBrainstormBinaryUrl("brainstorm://app-file/notes/abc.pdf")).toBe(true);
		// Bare hosts, entity URIs and external links are not binary content.
		expect(isBrainstormBinaryUrl("brainstorm://asset/")).toBe(false);
		expect(isBrainstormBinaryUrl("brainstorm://entity/n_1")).toBe(false);
		expect(isBrainstormBinaryUrl("https://example.com/a.pdf")).toBe(false);
		expect(isBrainstormBinaryUrl("about:blank")).toBe(false);
	});

	it("finds the nearest binary anchor from a click target inside it", () => {
		const root = makeRoot('<p><a href="brainstorm://asset/a_9f3"><span>report.pdf</span></a></p>');
		const span = root.querySelector("span");
		if (!span) throw new Error("seed missing");
		const match = findBinaryLinkFromEvent(span, root);
		expect(match?.url).toBe("brainstorm://asset/a_9f3");
		expect(match?.anchor.textContent).toBe("report.pdf");
		root.remove();
	});

	it("ignores entity links, external links, and anchors outside the root", () => {
		const root = makeRoot(
			'<a href="brainstorm://entity/n_1">entity</a><a href="https://x.test/a.pdf">ext</a>',
		);
		for (const a of root.querySelectorAll("a")) {
			expect(findBinaryLinkFromEvent(a, root)).toBeNull();
		}
		const outside = document.createElement("a");
		outside.setAttribute("href", "brainstorm://asset/a_1");
		document.body.append(outside);
		expect(findBinaryLinkFromEvent(outside, root)).toBeNull();
		outside.remove();
		root.remove();
	});

	it("downloads via a transient <a download> carrying the display filename", () => {
		// The Electron will-navigate guard drops brainstorm:// navigations, so
		// the interceptor must go through the download pipeline instead — the
		// same contract FileBlockNode's chip uses.
		const clicked: Array<{ href: string; download: string }> = [];
		const onClick = (event: MouseEvent) => {
			const a = event.target as HTMLAnchorElement;
			clicked.push({ href: a.getAttribute("href") ?? "", download: a.download });
			event.preventDefault(); // keep jsdom from attempting a navigation
		};
		document.addEventListener("click", onClick, true);
		triggerBinaryLinkDownload("brainstorm://asset/a_9f3", "  report.pdf  ");
		triggerBinaryLinkDownload("brainstorm://app-file/notes/abc.bin", null);
		document.removeEventListener("click", onClick, true);
		expect(clicked).toEqual([
			{ href: "brainstorm://asset/a_9f3", download: "report.pdf" },
			{ href: "brainstorm://app-file/notes/abc.bin", download: "" },
		]);
		// The transient anchor must not leak into the document.
		expect(document.querySelector('a[href^="brainstorm://"]')).toBeNull();
	});
});
