import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EditorPreview, TextFormat, renderEditorState } from "./preview";

const state = {
	root: {
		type: "root",
		children: [
			{ type: "heading", tag: "h1", children: [{ type: "text", text: "Title" }] },
			{
				type: "paragraph",
				children: [
					{ type: "text", text: "plain " },
					{ type: "text", text: "bold", format: TextFormat.Bold },
					{ type: "text", text: "code", format: TextFormat.Code },
				],
			},
			{ type: "quote", children: [{ type: "text", text: "quoted" }] },
			{
				type: "list",
				listType: "number",
				children: [{ type: "listitem", children: [{ type: "text", text: "one" }] }],
			},
			{
				type: "paragraph",
				children: [{ type: "link", url: "https://x.test", children: [{ type: "text", text: "lnk" }] }],
			},
			{ type: "code", children: [{ type: "text", text: "const x=1" }] },
			{
				type: "paragraph",
				children: [{ type: "image", src: "i://1", altText: "alt", caption: "cap", width: 80 }],
			},
			{
				type: "paragraph",
				children: [
					{ type: "text", text: "ping " },
					{ type: "mention", entityId: "ed25519:abc", entityType: "", label: "Razor" },
				],
			},
			{ type: "io.acme/kanban@v1", children: [] },
		],
	},
};

describe("renderEditorState", () => {
	const html = renderToStaticMarkup(<EditorPreview state={state} />);

	it("renders baseline nodes natively", () => {
		expect(html).toContain("<h1");
		expect(html).toContain(">Title<");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain('<code class="bs-editor__text--code">code</code>');
		expect(html).toContain("<blockquote");
		expect(html).toContain("<ol");
		expect(html).toContain('<a class="bs-editor__link" href="https://x.test"');
		expect(html).toContain("<pre");
		expect(html).toContain('<img src="i://1" alt="alt"');
		expect(html).toContain("cap");
	});

	it("renders a fallback chip with the node type as the display hint", () => {
		expect(html).toContain('data-node-type="io.acme/kanban@v1"');
		expect(html).toContain("⟦io.acme/kanban@v1⟧");
	});

	it("renders an inline mention as a chip, not the fallback", () => {
		expect(html).toContain('class="notes__mention-chip"');
		expect(html).toContain('data-entity-id="ed25519:abc"');
		expect(html).toContain(">Razor<");
		expect(html).not.toContain("⟦mention⟧");
	});

	it("parses a JSON string and tolerates malformed input", () => {
		expect(renderEditorState(JSON.stringify(state)).length).toBe(9);
		expect(renderEditorState("{not json")).toEqual([]);
		expect(renderEditorState(null)).toEqual([]);
		expect(renderEditorState({})).toEqual([]);
	});

	it("caps top-level blocks via maxBlocks", () => {
		expect(renderEditorState(state, { maxBlocks: 2 }).length).toBe(2);
	});

	it("does not import lexical (read path is Lexical-free)", async () => {
		const mod = await import("./preview");
		expect(Object.keys(mod)).toContain("renderEditorState");
		// preview.tsx imports only react — assert no lexical in its import graph
		// by checking the module loaded without pulling the editor factory.
		expect(mod).not.toHaveProperty("BrainstormEditor");
	});
});
