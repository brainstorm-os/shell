import { describe, expect, it } from "vitest";
import type { SerializedEditorStateLike } from "./preview";
import { serializedStateToHtml } from "./serialize-html";

function doc(children: unknown[]): SerializedEditorStateLike {
	return { root: { type: "root", children } } as SerializedEditorStateLike;
}
const text = (t: string, format = 0) => ({ type: "text", text: t, format });

describe("serializedStateToHtml", () => {
	it("returns '' for empty / malformed / string-garbage input", () => {
		expect(serializedStateToHtml(null)).toBe("");
		expect(serializedStateToHtml({} as never)).toBe("");
		expect(serializedStateToHtml("{not json")).toBe("");
	});

	it("renders paragraphs, headings, quotes, lists", () => {
		const html = serializedStateToHtml(
			doc([
				{ type: "paragraph", children: [text("hi")] },
				{ type: "heading", tag: "h3", children: [text("Title")] },
				{ type: "quote", children: [text("q")] },
				{
					type: "list",
					listType: "number",
					children: [{ type: "listitem", children: [text("one")] }],
				},
			]),
		);
		expect(html).toBe("<p>hi</p><h3>Title</h3><blockquote>q</blockquote><ol><li>one</li></ol>");
	});

	it("clamps an unknown heading tag to h2 and bullet lists to ul", () => {
		expect(serializedStateToHtml(doc([{ type: "heading", tag: "h9", children: [text("x")] }]))).toBe(
			"<h2>x</h2>",
		);
		expect(
			serializedStateToHtml(
				doc([{ type: "list", children: [{ type: "listitem", children: [text("a")] }] }]),
			),
		).toBe("<ul><li>a</li></ul>");
	});

	it("wraps text format bits (bold/italic/underline/strike/code), inner-out", () => {
		// Bold|Italic = 1|2 = 3
		expect(serializedStateToHtml(doc([{ type: "paragraph", children: [text("x", 3)] }]))).toBe(
			"<p><strong><em>x</em></strong></p>",
		);
		expect(serializedStateToHtml(doc([{ type: "paragraph", children: [text("c", 16)] }]))).toBe(
			"<p><code>c</code></p>",
		);
	});

	it("HTML-escapes text content (no markup injection)", () => {
		const html = serializedStateToHtml(
			doc([{ type: "paragraph", children: [text('<script>alert(1)</script> & "q"')] }]),
		);
		expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</p>");
		expect(html).not.toContain("<script>");
	});

	it("keeps safe link hrefs but drops javascript: / unknown schemes", () => {
		const safe = serializedStateToHtml(
			doc([{ type: "link", url: "https://x.com/a?b=1", children: [text("link")] }]),
		);
		expect(safe).toBe('<a href="https://x.com/a?b=1" rel="noreferrer">link</a>');

		const danger = serializedStateToHtml(
			doc([{ type: "link", url: "javascript:alert(1)", children: [text("x")] }]),
		);
		expect(danger).toBe("<a>x</a>"); // href dropped, no executable URL
		expect(danger).not.toContain("javascript:");
	});

	it("escapes the brainstorm:// entity href (internal links survive)", () => {
		const html = serializedStateToHtml(
			doc([{ type: "link", url: "brainstorm://entity/n_1", children: [text("ref")] }]),
		);
		expect(html).toBe('<a href="brainstorm://entity/n_1" rel="noreferrer">ref</a>');
	});

	it("renders images with escaped src/alt and drops an unsafe src", () => {
		expect(
			serializedStateToHtml(doc([{ type: "image", src: "https://x/y.png", altText: 'a"b' }])),
		).toBe('<img src="https://x/y.png" alt="a&quot;b" />');
		expect(serializedStateToHtml(doc([{ type: "image", src: "javascript:1", altText: "x" }]))).toBe(
			"",
		);
	});

	it("emits <br /> for linebreaks and respects maxBlocks", () => {
		expect(
			serializedStateToHtml(doc([{ type: "paragraph", children: [{ type: "linebreak" }] }])),
		).toBe("<p><br /></p>");
		const many = doc([
			{ type: "paragraph", children: [text("1")] },
			{ type: "paragraph", children: [text("2")] },
		]);
		expect(serializedStateToHtml(many, { maxBlocks: 1 })).toBe("<p>1</p>");
	});

	it("falls back to a decorator node's escaped plain text", () => {
		expect(
			serializedStateToHtml(
				doc([{ type: "paragraph", children: [{ type: "mention", text: "@A & B" }] }]),
			),
		).toBe("<p>@A &amp; B</p>");
	});
});

describe("serializedStateToHtml — publishing mode (IE-12)", () => {
	const published = new Map([
		["in-1", "roadmap.html"],
		["in-set-id-22", "roadmap.html"],
	]);
	const site = {
		resolveEntityHref: (id: string) => published.get(id) ?? null,
		resolveAssetSrc: (id: string) => (id === "asset-in" ? "assets/1.png" : null),
		unpublishedLabel: "[unpublished]",
	};
	const para = (children: unknown[]) => doc([{ type: "paragraph", children }]);

	it("rewrites an entity link to its published page", () => {
		const state = para([
			{ type: "link", url: "brainstorm://entity/in-1", children: [text("the plan")] },
		]);
		expect(serializedStateToHtml(state, site)).toBe(
			'<p><a href="roadmap.html" rel="noreferrer">the plan</a></p>',
		);
	});

	it("drops the link to an unpublished entity and never emits its id", () => {
		const state = para([
			{ type: "link", url: "brainstorm://entity/secret-id-9", children: [text("see this")] },
		]);
		const html = serializedStateToHtml(state, site);
		expect(html).toBe("<p>see this</p>");
		expect(html).not.toContain("secret-id-9");
		expect(html).not.toContain("brainstorm:");
	});

	it.each(["mention", "page-ref", "transclusion", "inline-transclusion"])(
		"renders an in-set %s as a link and an out-of-set one as the neutral stand-in",
		(type) => {
			const inSet = para([{ type, entityId: "in-1", label: "Roadmap" }]);
			expect(serializedStateToHtml(inSet, site)).toBe('<p><a href="roadmap.html">Roadmap</a></p>');
			const outOfSet = para([{ type, entityId: "secret-id-9", label: "Layoff plan Q3" }]);
			const html = serializedStateToHtml(outOfSet, site);
			expect(html).toBe("<p>[unpublished]</p>");
			expect(html).not.toContain("Layoff");
			expect(html).not.toContain("secret-id-9");
		},
	);

	it("emits nothing for an out-of-set reference when no stand-in is given", () => {
		const state = para([{ type: "mention", entityId: "x", label: "Hidden" }]);
		expect(serializedStateToHtml(state, { resolveEntityHref: () => null })).toBe("<p></p>");
	});

	it("scrubs a vault URL that appears as visible text", () => {
		const state = para([
			{
				type: "autolink",
				url: "brainstorm://entity/secret-id-9",
				children: [text("brainstorm://entity/secret-id-9")],
			},
			text(" and brainstorm://asset/secret-asset?x=1 too"),
		]);
		const html = serializedStateToHtml(state, site);
		expect(html).not.toContain("secret-id-9");
		expect(html).not.toContain("secret-asset");
		expect(html).not.toContain("brainstorm:");
	});

	it("scrubs a vault URL split across differently formatted runs", () => {
		const bold = (t: string) => ({ type: "text", text: t, format: 1 });
		const splits: unknown[][] = [
			[text("brainstorm://entity/secret-"), bold("id-9")],
			[text("brainstorm://"), bold("entity/"), text("secret-id-9")],
			[text("brain"), bold("storm://entity/secret-id-9")],
			[text("see brainstorm://entity/sec"), bold("ret-id"), text("-9 after")],
		];
		for (const children of splits) {
			for (const url of ["brainstorm://entity/secret-id-9", "brainstorm://entity/in-1"]) {
				const html = serializedStateToHtml(para([{ type: "link", url, children }]), site);
				expect(html).not.toContain("secret-id-9");
				expect(html).not.toMatch(/secret-|id-9|ret-id/);
			}
		}
		const loose = serializedStateToHtml(
			para([text("go brainstorm://entity/secret-"), bold("id-9"), text(" now")]),
			site,
		);
		expect(loose).toBe("<p>go [unpublished] now</p>");
	});

	it("keeps the text after a split URL ends, and resets at a non-text node", () => {
		const html = serializedStateToHtml(
			para([text("brainstorm://entity/x"), { type: "linebreak" }, text("kept")]),
			site,
		);
		expect(html).toBe("<p>[unpublished]<br />kept</p>");
	});

	it("replaces link text that spells out the target id, in one run or several", () => {
		const bold = (t: string) => ({ type: "text", text: t, format: 1 });
		const outOfSet = "brainstorm://entity/secret-id-9";
		const whole = para([{ type: "link", url: outOfSet, children: [text("ref secret-id-9")] }]);
		expect(serializedStateToHtml(whole, site)).toBe("<p>[unpublished]</p>");
		const split = para([
			{ type: "link", url: outOfSet, children: [text("secret-"), bold("id"), text("-9")] },
		]);
		expect(serializedStateToHtml(split, site)).toBe("<p>[unpublished]</p>");
		const inSet = para([
			{
				type: "link",
				url: "brainstorm://entity/in-set-id-22",
				children: [text("in-set"), bold("-id-22")],
			},
		]);
		expect(serializedStateToHtml(inSet, site)).toBe(
			'<p><a href="roadmap.html" rel="noreferrer">[unpublished]</a></p>',
		);
	});

	it("leaves an out-of-set link as plain text: no anchor, no href, no id", () => {
		const bold = (t: string) => ({ type: "text", text: t, format: 1 });
		const state = para([
			{
				type: "link",
				url: "brainstorm://entity/secret-id-9?block=b1#frag",
				children: [text("the "), bold("terms")],
			},
		]);
		const html = serializedStateToHtml(state, site);
		expect(html).toBe("<p>the <strong>terms</strong></p>");
		expect(html).not.toMatch(/<a\b|href|secret-id-9|brainstorm/);
	});

	it("drops every other brainstorm: URL in publishing mode", () => {
		const state = para([
			{ type: "link", url: "brainstorm://app/notes?open=secret", children: [text("x")] },
		]);
		expect(serializedStateToHtml(state, site)).toBe("<p>x</p>");
	});

	it("escapes a resolver result and a hostile label", () => {
		const state = para([{ type: "mention", entityId: "e", label: '<img src=x onerror="1">' }]);
		const html = serializedStateToHtml(state, { resolveEntityHref: () => 'a".html' });
		expect(html).toBe('<p><a href="a&quot;.html">&lt;img src=x onerror=&quot;1&quot;&gt;</a></p>');
	});

	it("points a copied asset at its file and drops an image that was not copied", () => {
		const kept = doc([{ type: "image-block", src: "brainstorm://asset/asset-in", alt: "a" }]);
		expect(serializedStateToHtml(kept, site)).toBe(
			'<figure><img src="assets/1.png" alt="a" /></figure>',
		);
		const dropped = doc([{ type: "image-block", src: "brainstorm://asset/asset-out", alt: "a" }]);
		expect(serializedStateToHtml(dropped, site)).toBe("");
	});

	it("keeps raster data: images only when asked, and never an SVG one", () => {
		const png = "data:image/png;base64,iVBORw0KGgo=";
		const image = (src: string) => doc([{ type: "image", src, altText: "" }]);
		expect(serializedStateToHtml(image(png))).toBe("");
		expect(serializedStateToHtml(image(png), { allowDataImages: true })).toBe(
			`<img src="${png}" alt="" />`,
		);
		const svg = "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==";
		expect(serializedStateToHtml(image(svg), { allowDataImages: true })).toBe("");
		const smuggled = 'data:image/png;base64,AAAA" onerror="alert(1)';
		expect(serializedStateToHtml(image(smuggled), { allowDataImages: true })).toBe("");
	});
});

describe("serializedStateToHtml — structure beyond the v1 vocabulary", () => {
	it("renders the title node, rules and tables", () => {
		expect(serializedStateToHtml(doc([{ type: "title", children: [text("T")] }]))).toBe("<h1>T</h1>");
		expect(serializedStateToHtml(doc([{ type: "horizontalrule" }]))).toBe("<hr />");
		const table = {
			type: "table",
			children: [
				{
					type: "tablerow",
					children: [
						{ type: "tablecell", headerState: 1, children: [text("H")] },
						{ type: "tablecell", headerState: 0, children: [text("<c>")] },
					],
				},
			],
		};
		expect(serializedStateToHtml(doc([table]))).toBe(
			"<table><tr><th>H</th><td>&lt;c&gt;</td></tr></table>",
		);
	});

	it("keeps the content of a container it has no form for", () => {
		const callout = { type: "callout", children: [{ type: "paragraph", children: [text("hi")] }] };
		expect(serializedStateToHtml(doc([callout]))).toBe("<div><p>hi</p></div>");
	});

	it("renders a mention's label as text outside publishing mode", () => {
		const state = doc([{ type: "paragraph", children: [{ type: "mention", label: "A & B" }] }]);
		expect(serializedStateToHtml(state)).toBe("<p>A &amp; B</p>");
	});
});
