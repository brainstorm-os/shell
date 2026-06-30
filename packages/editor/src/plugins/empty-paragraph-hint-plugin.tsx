/**
 * EmptyParagraphHintPlugin — when the caret sits inside an empty
 * top-level paragraph, mark its DOM element with `data-empty-hint="true"`
 * + `data-empty-hint-text="…"`. CSS in `styles.css` paints the attribute
 * value as ghost text via `::before`.
 *
 * Scoped intentionally:
 *   - Empty paragraphs that don't have the caret stay blank (no visual
 *     noise on long docs).
 *   - Only `ParagraphNode` qualifies — list items / headings / quotes
 *     are already visually distinct and have their own affordances.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isTableCellNode } from "@lexical/table";
import {
	$getSelection,
	$isParagraphNode,
	$isRangeSelection,
	$isTextNode,
	type LexicalEditor,
	type NodeKey,
	type ParagraphNode,
} from "lexical";
import { useEffect } from "react";
import { useEditorT } from "../i18n";

const HINT_ATTR = "data-empty-hint";
const HINT_TEXT_ATTR = "data-empty-hint-text";

export function EmptyParagraphHintPlugin() {
	const [editor] = useLexicalComposerContext();
	const t = useEditorT();

	useEffect(() => {
		let last: NodeKey | null = null;
		const hint = t("editor.placeholder.empty");

		function clear(key: NodeKey | null): void {
			if (!key) return;
			const el = editor.getElementByKey(key);
			if (!el) return;
			el.removeAttribute(HINT_ATTR);
			el.removeAttribute(HINT_TEXT_ATTR);
		}

		function apply(): void {
			const next = pickEmptyParagraph(editor);
			if (next === last) return;
			clear(last);
			if (next) {
				const el = editor.getElementByKey(next);
				if (el) {
					el.setAttribute(HINT_ATTR, "true");
					el.setAttribute(HINT_TEXT_ATTR, hint);
					// The hint is rendered via ::before with position: absolute;
					// the host needs `position: relative` so the ghost text lines
					// up with the paragraph's first line, not the editor root.
					if (!el.style.position) el.style.position = "relative";
				}
			}
			last = next;
		}

		const unsubscribe = editor.registerUpdateListener(apply);
		// Run once on mount so the hint shows for documents that start with
		// an empty paragraph (the common "fresh note" case).
		apply();
		return () => {
			unsubscribe();
			clear(last);
		};
	}, [editor, t]);

	return null;
}

function pickEmptyParagraph(editor: LexicalEditor): NodeKey | null {
	let key: NodeKey | null = null;
	editor.getEditorState().read(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		if (!selection.isCollapsed()) return;
		const anchor = selection.anchor.getNode();
		let top: ReturnType<typeof anchor.getTopLevelElement>;
		try {
			top = anchor.getTopLevelElementOrThrow();
		} catch {
			return;
		}
		if (!top || !$isParagraphNode(top)) return;
		// A table cell is a Lexical shadow root, so an empty cell's paragraph is
		// its own top-level element and would otherwise get the hint — but the
		// full "Type ‘/’ for commands" text overflows the narrow cell. Cells are
		// already visually distinct (grid lines), so skip the hint inside them.
		if ($isTableCellNode(top.getParent())) return;
		if ($isBlankHintParagraph(top)) {
			key = top.getKey();
		}
	});
	return key;
}

/**
 * A paragraph qualifies for the slash hint only when it's genuinely blank — no
 * children, or only empty text nodes. An inline decorator (the Select / date /
 * number field, an inline image / mention) contributes no text yet IS content,
 * so a bare `getTextContent().length === 0` check wrongly counted such a
 * paragraph as blank and painted the "Type ‘/’ for commands" ghost on top of
 * the field's own placeholder. Must run inside an editor read.
 */
export function $isBlankHintParagraph(paragraph: ParagraphNode): boolean {
	const children = paragraph.getChildren();
	return (
		children.length === 0 ||
		children.every((child) => $isTextNode(child) && child.getTextContent().length === 0)
	);
}
