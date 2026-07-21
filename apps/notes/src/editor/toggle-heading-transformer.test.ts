import { ToggleNode, ToggleVariant } from "@brainstorm-os/editor";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { describe, expect, it } from "vitest";
import { TOGGLE_HEADING_TRANSFORMER } from "./toggle-heading-transformer";

const T = TOGGLE_HEADING_TRANSFORMER;

function editor() {
	return createHeadlessEditor({
		namespace: "toggle-heading-test",
		nodes: [ToggleNode],
		onError: (e) => {
			throw e;
		},
	});
}

describe("TOGGLE_HEADING_TRANSFORMER", () => {
	it("matches #> / ##> / ###> at the start of a line (and only those)", () => {
		expect(T.regExp.test("#> summary")).toBe(true);
		expect(T.regExp.test("##> summary")).toBe(true);
		expect(T.regExp.test("###> summary")).toBe(true);
		// Plain heading (no `>`) and 4+ levels don't match.
		expect(T.regExp.test("# heading")).toBe(false);
		expect(T.regExp.test("####> too deep")).toBe(false);
		// Must be at line start.
		expect(T.regExp.test("x #> mid")).toBe(false);
	});

	it("wraps the line into a Heading-variant toggle whose title holds the content", () => {
		const ed = editor();
		ed.update(
			() => {
				const p = $createParagraphNode();
				p.append($createTextNode("summary text"));
				$getRoot().append(p);
				const match = "#> summary text".match(T.regExp);
				if (!match) throw new Error("regExp should match");
				// Simulate the post-marker children the plugin hands `replace`.
				T.replace?.(p, [...p.getChildren()], match, false);
			},
			{ discrete: true },
		);

		ed.getEditorState().read(() => {
			const toggle = $getRoot().getFirstChild();
			expect(toggle).toBeInstanceOf(ToggleNode);
			if (!(toggle instanceof ToggleNode)) throw new Error("expected a ToggleNode");
			expect(toggle.getVariant()).toBe(ToggleVariant.Heading1);
			const children = toggle.getChildren();
			expect(children).toHaveLength(2); // [title, body]
			expect(children[0]?.getTextContent()).toBe("summary text");
			expect(children[1]?.getTextContent()).toBe(""); // empty body
		});
	});

	it("maps the # count to the heading level (## → h2, ### → h3)", () => {
		for (const [marker, variant] of [
			["##> two", ToggleVariant.Heading2],
			["###> three", ToggleVariant.Heading3],
		] as const) {
			const ed = editor();
			ed.update(
				() => {
					const p = $createParagraphNode();
					p.append($createTextNode("x"));
					$getRoot().append(p);
					const match = marker.match(T.regExp);
					if (!match) throw new Error(`should match ${marker}`);
					T.replace?.(p, [...p.getChildren()], match, false);
				},
				{ discrete: true },
			);
			ed.getEditorState().read(() => {
				const toggle = $getRoot().getFirstChild();
				if (!(toggle instanceof ToggleNode)) throw new Error("expected a ToggleNode");
				expect(toggle.getVariant(), marker).toBe(variant);
			});
		}
	});
});
