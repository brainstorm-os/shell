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

	it("exports a bookmark or web embed as an escaped anchor, never an iframe", () => {
		const html = serializedStateToHtml(
			doc([
				{
					type: "web-embed",
					url: "https://www.google.com/maps/place/A&B/@1,2,3z",
					embedUrl: "https://www.google.com/maps?q=A%26B&z=3&output=embed",
					kind: "google-maps",
				},
				{ type: "bookmark", url: "https://example.com/a", title: "<b>T</b>", description: "" },
				{ type: "bookmark", url: "javascript:alert(1)", title: "x", description: "" },
				{ type: "web-embed", url: 'https://example.com/"onmouseover="x', embedUrl: null },
			]),
		);
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("output=embed");
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("<b>");
		expect(html).not.toContain('"onmouseover="');
		expect(html).toContain(
			'<a href="https://www.google.com/maps/place/A&amp;B/@1,2,3z" rel="noreferrer">',
		);
		expect(html).toContain(
			'<a href="https://example.com/a" rel="noreferrer">&lt;b&gt;T&lt;/b&gt;</a>',
		);
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
		expect(serializedStateToHtml(whole, site)).toBe("<p>ref [unpublished]</p>");
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

describe("serializedStateToHtml — publishing mode, every emitted string (IE-12)", () => {
	const SECRET = "secret-entity-id-9";
	const URL = `brainstorm://entity/${SECRET}`;
	const site = {
		resolveEntityHref: (id: string) => (id === "published-id-1" ? "page.html" : null),
		resolveEntityLabel: (id: string) => (id === "published-id-1" ? "Current title" : null),
		resolveAssetSrc: (id: string) => (id === "asset-in" ? "assets/1.png" : null),
		unpublishedLabel: "[x]",
		allowDataImages: true,
	};
	/** A mention elsewhere in the body makes SECRET an id the body references. */
	const reference = { type: "mention", entityId: SECRET, label: "Hidden" };
	const leaks: Array<[string, unknown]> = [
		["an unknown leaf's text", { type: "equation", text: `see ${URL}` }],
		["an unknown leaf's bare id", { type: "equation", text: `id ${SECRET}` }],
		[
			"a tab pane title",
			{ type: "tabs", children: [{ type: "tab-pane", title: URL, children: [] }] },
		],
		[
			"a tab pane title with a bare id",
			{ type: "tabs", children: [{ type: "tab-pane", title: SECRET, children: [] }] },
		],
		["an image alt", { type: "image", src: "brainstorm://asset/asset-in", altText: URL }],
		[
			"an image caption",
			{ type: "image", src: "brainstorm://asset/asset-in", altText: "", caption: SECRET },
		],
		[
			"an image-block alt and caption",
			{ type: "image-block", src: "brainstorm://asset/asset-in", alt: SECRET, caption: URL },
		],
		["an inline-image alt", { type: "inline-image", src: "brainstorm://asset/asset-in", alt: URL }],
		["a bookmark title", { type: "bookmark", url: "https://example.com/a", title: URL }],
		["a bookmark url", { type: "bookmark", url: `https://example.com/?next=${URL}` }],
		["a bookmark url carrying the id", { type: "bookmark", url: `https://example.com/${SECRET}` }],
		["a date-mention label", { type: "date-mention", iso: "2026-01-01", label: URL }],
		["a link href query", { type: "link", url: `https://example.com/?next=${URL}`, children: [] }],
		[
			"a percent-encoded link href",
			{
				type: "link",
				url: `https://example.com/?n=${encodeURIComponent(encodeURIComponent(URL))}`,
				children: [],
			},
		],
		["a relative href", { type: "link", url: `./${URL}`, children: [] }],
		["a rooted href", { type: "link", url: `/${URL}`, children: [] }],
		["a fragment href", { type: "link", url: `#${URL}`, children: [] }],
		["a mixed-case href", { type: "link", url: "./BrainStorm://entity/x", children: [] }],
		[
			"an href carrying only the id",
			{ type: "link", url: `https://x.example/${SECRET}`, children: [] },
		],
		["a published mention's label", { type: "mention", entityId: "published-id-1", label: URL }],
		["a remote image", { type: "image", src: `https://example.com/${SECRET}.png`, altText: "" }],
	];

	it.each(leaks)("keeps a vault URL and a referenced id out of %s", (_where, node) => {
		const html = serializedStateToHtml(
			doc([{ type: "paragraph", children: [reference] }, node as never]),
			site,
		);
		expect(html.toLowerCase()).not.toContain("brainstorm:");
		expect(html).not.toContain(SECRET);
		expect(html).not.toContain("Hidden");
	});

	it("drops the href but keeps the text of a link that names the vault", () => {
		const state = doc([
			{
				type: "paragraph",
				children: [{ type: "link", url: `./${URL}`, children: [text("read me")] }],
			},
		]);
		expect(serializedStateToHtml(state, site)).toBe("<p>read me</p>");
	});

	it("shows a published reference under the page's current title, not its stored label", () => {
		const state = doc([
			{
				type: "paragraph",
				children: [{ type: "page-ref", entityId: "published-id-1", label: "Stale or planted" }],
			},
		]);
		expect(serializedStateToHtml(state, site)).toBe('<p><a href="page.html">Current title</a></p>');
	});

	it("emits no remote or relative image source — only a copied asset or inline data", () => {
		const image = (src: string) => ({ type: "image", src, altText: "a" });
		const html = serializedStateToHtml(
			doc([
				image("https://tracker.example/p.gif"),
				image("http://tracker.example/p.gif"),
				image("//tracker.example/p.gif"),
				image("/abs/p.gif"),
				image("./rel/p.gif"),
				{ type: "image-block", src: "https://tracker.example/b.png" },
				{ type: "inline-image", src: "https://tracker.example/i.png" },
				image("brainstorm://asset/asset-in"),
				image("data:image/png;base64,AAAA"),
			]),
			site,
		);
		expect(html).toBe(
			'<img src="assets/1.png" alt="a" /><img src="data:image/png;base64,AAAA" alt="a" />',
		);
	});

	it("still keeps a remote image in a plain single-note export", () => {
		expect(serializedStateToHtml(doc([{ type: "image", src: "https://x/y.png", altText: "" }]))).toBe(
			'<img src="https://x/y.png" alt="" />',
		);
	});
});

describe("serializedStateToHtml — hostile nesting", () => {
	const nest = (depth: number, type: string) => {
		let node: Record<string, unknown> = { type: "paragraph", children: [text("deep <b>")] };
		for (let level = 0; level < depth; level += 1) node = { type, children: [node] };
		return node;
	};

	it.each(["quote", "list", "callout", "link"])(
		"flattens 20,000 nested %s nodes to text instead of overflowing the stack",
		(type) => {
			const html = serializedStateToHtml(doc([nest(20_000, type)]));
			expect(html).toContain("deep &lt;b&gt;");
			expect(html.length).toBeLessThan(4_000);
		},
	);

	it("survives the same depth in publishing mode and still scrubs what it flattens", () => {
		const deep = nest(20_000, "quote");
		const leaf = { type: "paragraph", children: [text("brainstorm://entity/deep-secret-id")] };
		let node: Record<string, unknown> = leaf;
		for (let level = 0; level < 200; level += 1) node = { type: "quote", children: [node] };
		const html = serializedStateToHtml(doc([deep, node]), {
			resolveEntityHref: () => null,
			unpublishedLabel: "[x]",
		});
		expect(html).toContain("deep &lt;b&gt;");
		expect(html).not.toContain("deep-secret-id");
		expect(html).not.toContain("brainstorm:");
	});

	it("renders ordinary nesting unchanged", () => {
		expect(serializedStateToHtml(doc([nest(10, "quote")]))).toBe(
			`${"<blockquote>".repeat(10)}<p>deep &lt;b&gt;</p>${"</blockquote>".repeat(10)}`,
		);
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
