import { createHeadlessEditor } from "@lexical/headless";
import { $createHeadingNode, HeadingNode } from "@lexical/rich-text";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { describe, expect, it } from "vitest";
import {
	BLOCK_BACKGROUND_STYLE_PROP,
	blockBackgroundExportCss,
	serializedStateWithBlockStyles,
	withBlockBackground,
} from "./block-background";
import { serializedStateToHtml } from "./serialize-html";
import { serializedStateToMarkdown } from "./serialize-markdown";
import { SwatchColor } from "./text-color";

const BLUE = `${BLOCK_BACKGROUND_STYLE_PROP}: blue`;

describe("block backgrounds in exports (B11.23)", () => {
	it("export CSS names the theme token with the baked tint as the standalone fallback", () => {
		expect(blockBackgroundExportCss(BLUE)).toBe(
			"background-color: var(--color-block-background-blue, light-dark(#d4e7f7, #22384d))",
		);
		expect(blockBackgroundExportCss("")).toBeNull();
		expect(blockBackgroundExportCss(`${BLOCK_BACKGROUND_STYLE_PROP}: url(x)`)).toBeNull();
		expect(blockBackgroundExportCss(42)).toBeNull();
	});

	it("HTML carries a block's background as an escaped inline style", () => {
		const state = {
			root: {
				children: [
					{ type: "paragraph", style: BLUE, children: [{ type: "text", text: "tinted" }] },
					{ type: "heading", tag: "h2", style: `${BLOCK_BACKGROUND_STYLE_PROP}: red`, children: [] },
					{ type: "quote", children: [{ type: "text", text: "plain" }] },
					{
						type: "list",
						listType: "bullet",
						children: [{ type: "listitem", style: BLUE, children: [{ type: "text", text: "li" }] }],
					},
				],
			},
		};
		const html = serializedStateToHtml(state);
		expect(html).toContain(
			'<p style="background-color: var(--color-block-background-blue, light-dark(#d4e7f7, #22384d))">tinted</p>',
		);
		expect(html).toContain('<h2 style="background-color: var(--color-block-background-red');
		expect(html).toContain("<blockquote>plain</blockquote>");
		expect(html).toContain('<li style="background-color: var(--color-block-background-blue');
	});

	it("Markdown deliberately drops backgrounds — it has no block-colour syntax, and inline HTML would make the .md non-portable and break re-import", () => {
		const state = {
			root: {
				children: [{ type: "paragraph", style: BLUE, children: [{ type: "text", text: "tinted" }] }],
			},
		};
		expect(serializedStateToMarkdown(state)).toBe("tinted");
	});

	it("serializedStateWithBlockStyles restores the element style Lexical's exportJSON drops", () => {
		const editor = createHeadlessEditor({
			namespace: "bg-export",
			nodes: [HeadingNode],
			onError: (e) => {
				throw e;
			},
		});
		editor.update(
			() => {
				const p = $createParagraphNode().append($createTextNode("x"));
				p.setStyle(withBlockBackground("", SwatchColor.Blue));
				$getRoot().append(p, $createHeadingNode("h1").append($createTextNode("h")));
			},
			{ discrete: true },
		);
		const plain = editor.getEditorState().toJSON().root.children[0] as { style?: string };
		expect(plain.style).toBeUndefined();
		const json = serializedStateWithBlockStyles(editor);
		const [p, h] = json.root.children as Array<{ style?: string }>;
		expect(p?.style).toBe(BLUE);
		expect(h?.style).toBeUndefined();
		expect(serializedStateToHtml(json)).toContain('<p style="background-color');
	});
});
