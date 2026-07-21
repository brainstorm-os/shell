import { createBrainstormHeadlessEditor } from "@brainstorm-os/editor";
import { describe, expect, it } from "vitest";
import { type SerializedBlock, htmlToSerializedBlocks } from "./html-to-blocks";

const blocks = (html: string) => htmlToSerializedBlocks(html);
const types = (bs: SerializedBlock[]) => bs.map((b) => b.type);

describe("htmlToSerializedBlocks — structure", () => {
	it("maps headings with their level tag", () => {
		const [h] = blocks("<h2>Title</h2>");
		expect(h?.type).toBe("heading");
		expect(h?.tag).toBe("h2");
		expect((h?.children?.[0] as SerializedBlock)?.text).toBe("Title");
	});

	it("maps paragraphs with inline bold / italic / code as text-format bits", () => {
		const [p] = blocks("<p>plain <strong>b</strong> <em>i</em> <code>c</code></p>");
		const kids = (p?.children ?? []) as SerializedBlock[];
		const byText = (t: string) => kids.find((k) => k.text === t);
		expect(byText("plain ")?.format).toBe(0);
		expect(byText("b")?.format).toBe(1); // bold
		expect(byText("i")?.format).toBe(2); // italic
		expect(byText("c")?.format).toBe(16); // code
	});

	it("maps links to a link node carrying the href", () => {
		const [p] = blocks('<p>see <a href="https://x.test" title="T">here</a></p>');
		const link = (p?.children as SerializedBlock[]).find((k) => k.type === "link");
		expect(link?.url).toBe("https://x.test");
		expect(link?.title).toBe("T");
		expect((link?.children?.[0] as SerializedBlock)?.text).toBe("here");
	});

	it("maps ul/ol to a list with listitems + listType", () => {
		const [ul] = blocks("<ul><li>one</li><li>two</li></ul>");
		expect(ul?.type).toBe("list");
		expect(ul?.listType).toBe("bullet");
		expect(ul?.children?.length).toBe(2);
		expect((ul?.children?.[0] as SerializedBlock).type).toBe("listitem");
		const [ol] = blocks("<ol><li>a</li></ol>");
		expect(ol?.listType).toBe("number");
		expect((ol?.children?.[0] as SerializedBlock).value).toBe(1);
	});

	it("maps pre>code to a code block with inferred language", () => {
		const [c] = blocks('<pre class="language-ts"><code>const x = 1;</code></pre>');
		expect(c?.type).toBe("code");
		expect(c?.language).toBe("ts");
		expect((c?.children?.[0] as SerializedBlock)?.text).toBe("const x = 1;");
	});

	it("maps blockquote to a quote block", () => {
		const [q] = blocks("<blockquote>wisdom</blockquote>");
		expect(q?.type).toBe("quote");
	});

	it("maps img to a paragraph-wrapped image node", () => {
		const [p] = blocks('<img src="https://x.test/a.png" alt="shot">');
		expect(p?.type).toBe("paragraph");
		const img = (p?.children?.[0] as SerializedBlock) ?? null;
		expect(img?.type).toBe("image");
		expect(img?.src).toBe("https://x.test/a.png");
		expect(img?.altText).toBe("shot");
	});

	it("flattens unmapped containers, keeping nested blocks", () => {
		const out = blocks("<article><div><h1>H</h1><p>body</p></div></article>");
		expect(types(out)).toEqual(["heading", "paragraph"]);
	});

	it("returns [] for empty input", () => {
		expect(blocks("")).toEqual([]);
		expect(blocks("   ")).toEqual([]);
	});
});

describe("htmlToSerializedBlocks — round-trips through the real editor", () => {
	// The gold-standard validity check: parse the hand-built JSON into a real
	// Brainstorm headless editor (the exact node set), re-export, and confirm the
	// block types survive — proving every emitted shape is importable by Lexical.
	it("every block type imports + re-exports with the same type", () => {
		const html = `
			<h1>Heading</h1>
			<p>Para with <strong>bold</strong> and a <a href="https://x.test">link</a>.</p>
			<ul><li>one</li><li>two</li></ul>
			<blockquote>quote</blockquote>
			<pre class="language-js"><code>x()</code></pre>
			<img src="https://x.test/i.png" alt="i">`;
		const built = blocks(html);
		expect(built.length).toBeGreaterThan(0);

		const editor = createBrainstormHeadlessEditor();
		const state = editor.parseEditorState({
			root: { type: "root", version: 1, direction: null, format: "", indent: 0, children: built },
		});
		editor.setEditorState(state);
		const reexported = (editor.getEditorState().toJSON() as { root: { children: SerializedBlock[] } })
			.root.children;

		// Round-trip stable → shapes are valid Lexical. (Dropped/coerced nodes
		// would change the type sequence.)
		expect(reexported.map((b) => b.type)).toEqual(built.map((b) => b.type));
		expect(reexported.map((b) => b.type)).toEqual([
			"heading",
			"paragraph",
			"list",
			"quote",
			"code",
			"paragraph",
		]);
	});
});

describe("htmlToSerializedBlocks — Net-2e URL scheme guard (defense-in-depth)", () => {
	it("drops a javascript: link wrapper but keeps its text", () => {
		const [p] = blocks('<p>see <a href="javascript:alert(1)">danger</a> ok</p>');
		const kids = (p?.children ?? []) as SerializedBlock[];
		expect(kids.some((k) => k.type === "link")).toBe(false);
		expect(kids.map((k) => k.text).join("")).toContain("danger");
	});

	it("drops an image with a data: / javascript: src", () => {
		expect(blocks('<img src="data:text/html;base64,PHN2Zz4=" alt="x">')).toEqual([]);
		expect(
			blocks('<p><a href="https://ok.test">keep</a><img src="javascript:1"></p>')[0]?.children?.some(
				(k) => (k as SerializedBlock).type === "image",
			),
		).toBe(false);
	});

	it("keeps http(s)/mailto/brainstorm links + relative + anchor", () => {
		for (const url of [
			"https://x.test",
			"mailto:a@b.test",
			"brainstorm://entity/x",
			"/rel",
			"#sec",
		]) {
			const [p] = blocks(`<p><a href="${url}">l</a></p>`);
			const link = (p?.children as SerializedBlock[]).find((k) => k.type === "link");
			expect(link?.url, url).toBe(url);
		}
	});
});
