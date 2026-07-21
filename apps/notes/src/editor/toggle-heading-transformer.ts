/**
 * B11.1 — toggle-header markdown shortcut: typing `#> ` / `##> ` / `###> ` at
 * the start of a line turns the line into a collapsible toggle whose summary
 * is styled as an h1/h2/h3 heading (the `ToggleVariant.Heading{1,2,3}` the
 * slash menu / turn-into already produce).
 *
 * An `@lexical/markdown` `ElementTransformer` on the editor's
 * `MarkdownShortcutPlugin` list — the same proven on-type pipeline the unicode
 * shortcuts + equation use. It can't reuse the library's `createBlockNode`
 * helper (that appends the line's inline children straight onto the new node);
 * a `ToggleNode` holds *block* children (`[title, body]`), so the custom
 * `replace` wraps the post-marker inline content into the title paragraph,
 * exactly mirroring `INSERT_TOGGLE_COMMAND` in `@brainstorm-os/editor`'s
 * toggle-plugin. The `#> ` grammar is disjoint from the built-in heading
 * shortcut (`# ` requires whitespace immediately after the `#`s; `#>` has `>`),
 * so the two never collide.
 */

import { $createToggleNode, ToggleNode, ToggleVariant } from "@brainstorm-os/editor";
import type { ElementTransformer } from "@lexical/markdown";
import { $createParagraphNode } from "lexical";

/** `#` count → toggle heading variant (1→h1, 2→h2, 3→h3). */
const HEADING_VARIANT_BY_LEVEL: readonly ToggleVariant[] = [
	ToggleVariant.Heading1,
	ToggleVariant.Heading2,
	ToggleVariant.Heading3,
];

export const TOGGLE_HEADING_TRANSFORMER: ElementTransformer = {
	dependencies: [ToggleNode],
	// Toggles don't round-trip to markdown in v1 (title + body has no single
	// `#> ` line form); export is B11.12's concern, so this stays inert.
	export: () => null,
	regExp: /^(#{1,3})>\s/,
	replace: (parentNode, children, match) => {
		const level = (match[1] ?? "").length;
		const variant = HEADING_VARIANT_BY_LEVEL[level - 1] ?? ToggleVariant.Heading1;
		const toggle = $createToggleNode(variant);
		const title = $createParagraphNode();
		title.append(...children);
		const body = $createParagraphNode();
		toggle.append(title, body);
		parentNode.replace(toggle);
		title.select(0, 0);
	},
	type: "element",
};
