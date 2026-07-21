import { ALL_EMOJIS } from "@brainstorm-os/sdk/icon-picker";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { describe, expect, it } from "vitest";
import { EMOJI_SHORTCODE_TRANSFORMER } from "./emoji-transformer";

const T = EMOJI_SHORTCODE_TRANSFORMER;
const sample = ALL_EMOJIS[0] as (typeof ALL_EMOJIS)[number];

function editor() {
	return createHeadlessEditor({
		namespace: "emoji-test",
		nodes: [],
		onError: (e) => {
			throw e;
		},
	});
}

/** Apply the transformer's own `replace` against the match its regExp makes
 *  for `text`, returning the resulting paragraph text. Deterministic — does
 *  not depend on the markdown plugin's keystroke timing. */
function applied(text: string): string {
	const ed = editor();
	ed.update(
		() => {
			const p = $createParagraphNode();
			p.append($createTextNode(text));
			$getRoot().append(p);
			const match = text.match(T.regExp);
			const node = $getRoot().getAllTextNodes()[0];
			if (match && node) T.replace?.(node, match);
		},
		{ discrete: true },
	);
	return ed.getEditorState().read(() => $getRoot().getTextContent());
}

describe("EMOJI_SHORTCODE_TRANSFORMER", () => {
	it("is triggered by ':' and matches a :slug: at the caret", () => {
		expect(T.trigger).toBe(":");
		expect(T.regExp.test(`:${sample.slug}:`)).toBe(true);
		expect(T.regExp.test(`:${sample.slug}:x`)).toBe(false); // anchored at end
		expect(T.regExp.test("::")).toBe(false); // empty body
	});

	it("rewrites a known :slug: to its emoji glyph", () => {
		expect(applied(`hi :${sample.slug}:`)).toBe(`hi ${sample.char}`);
	});

	it("leaves an unknown :slug: untouched (no-op)", () => {
		expect(applied(":definitely_not_real:")).toBe(":definitely_not_real:");
	});
});
