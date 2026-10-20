/**
 * TogglePlugin — owns the collapsible block:
 *   - INSERT_TOGGLE_COMMAND: wrap the current block into a ToggleNode
 *     (summary = first child, body = an empty paragraph), variant from
 *     the payload (plain toggle vs collapsible heading).
 *   - Disclosure: a click in the toggle's left gutter (where the CSS
 *     caret sits), on the summary row, flips the collapsed state. Closing
 *     moves the caret to the summary so it never lands in now-hidden body.
 *   - Backspace at the very start of the summary, when the body is
 *     empty, unwraps the toggle back to a plain paragraph so an empty
 *     toggle is never undeletable.
 *   - Outliner keys on a summary line (B11.30): Tab / Shift+Tab nest and
 *     un-nest toggles, Enter starts a sibling (see `toggle-outliner.ts`).
 *
 * Collapsed state is **per-device chrome** (B11.5): it lives in a
 * `ToggleCollapseStore` keyed by the node's persisted `__bsId`, never on
 * the node / in the synced body. The plugin re-applies the stored state to
 * the DOM (`data-open`) on mount and after every editor update so freshly
 * reconciled toggles render in the device's last-left state.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import {
	$createParagraphNode,
	$getNearestNodeFromDOMNode,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	COMMAND_PRIORITY_EDITOR,
	COMMAND_PRIORITY_LOW,
	COMMAND_PRIORITY_NORMAL,
	KEY_BACKSPACE_COMMAND,
	KEY_ENTER_COMMAND,
	KEY_TAB_COMMAND,
	createCommand,
} from "lexical";
import { useEffect, useMemo } from "react";
import type { ToggleVariant } from "../block-types";
import {
	$createToggleNode,
	$isToggleNode,
	TOGGLE_ID_ATTR,
	type ToggleNode,
} from "../nodes/toggle-node";
import { ToggleCollapseStore } from "./toggle-collapse-store";
import { $enterOnSummary, $indentToggle, $outdentToggle, $summaryToggle } from "./toggle-outliner";

export const INSERT_TOGGLE_COMMAND = createCommand<ToggleVariant>("INSERT_TOGGLE_COMMAND");

/** Width of the left gutter that holds the disclosure caret. Matches the
 *  `padding-left` of `.notes__toggle` in styles.css. */
const DISCLOSURE_GUTTER_PX = 26;

export type TogglePluginProps = {
	/** Document id the collapsed state is namespaced under (per-device,
	 *  persisted across reloads). Omit for a session-only in-memory store. */
	docId?: string;
};

export function TogglePlugin({ docId }: TogglePluginProps = {}) {
	const [editor] = useLexicalComposerContext();
	const store = useMemo(() => new ToggleCollapseStore(docId), [docId]);

	useEffect(() => {
		/** Reflect the per-device collapsed state onto every toggle element. */
		function applyCollapsedState() {
			const root = editor.getRootElement();
			if (!root) return;
			for (const el of root.querySelectorAll<HTMLElement>(`[${TOGGLE_ID_ATTR}]`)) {
				const id = el.getAttribute(TOGGLE_ID_ATTR);
				if (!id) continue;
				el.dataset.open = store.isCollapsed(id) ? "false" : "true";
			}
		}

		function onMouseDown(event: MouseEvent) {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			const el = target.closest<HTMLElement>(".notes__toggle");
			if (!el) return;
			const rect = el.getBoundingClientRect();
			if (event.clientX - rect.left > DISCLOSURE_GUTTER_PX) return;
			const summary = el.firstElementChild;
			if (summary && event.clientY > summary.getBoundingClientRect().bottom) return;
			const id = el.getAttribute(TOGGLE_ID_ATTR);
			if (!id) return;
			event.preventDefault();
			const collapsed = store.toggle(id);
			el.dataset.open = collapsed ? "false" : "true";
			if (collapsed) {
				// Don't leave the caret stranded in the now-hidden body.
				editor.update(() => {
					const node = $getNearestNodeFromDOMNode(el);
					let toggle: ToggleNode | null = null;
					for (let n = node; n; n = n.getParent()) {
						if ($isToggleNode(n)) {
							toggle = n;
							break;
						}
					}
					const first = toggle?.getFirstChild();
					if ($isElementNode(first)) first.selectEnd();
				});
			}
		}

		const root = editor.getRootElement();
		root?.addEventListener("mousedown", onMouseDown);
		const unregisterRoot = editor.registerRootListener((next, prev) => {
			prev?.removeEventListener("mousedown", onMouseDown);
			next?.addEventListener("mousedown", onMouseDown);
			if (next) applyCollapsedState();
		});
		applyCollapsedState();

		return mergeRegister(
			() => root?.removeEventListener("mousedown", onMouseDown),
			unregisterRoot,
			editor.registerUpdateListener(() => applyCollapsedState()),
			editor.registerCommand(
				INSERT_TOGGLE_COMMAND,
				(variant) => {
					const selection = $getSelection();
					if (!$isRangeSelection(selection)) return false;
					const anchor = selection.anchor.getNode();
					let block = anchor;
					try {
						block = anchor.getTopLevelElementOrThrow();
					} catch {
						return false;
					}
					const toggle = $createToggleNode(variant);
					const title = $createParagraphNode();
					if ($isElementNode(block)) {
						for (const child of block.getChildren()) title.append(child);
					}
					const body = $createParagraphNode();
					toggle.append(title, body);
					block.replace(toggle);
					title.selectEnd();
					return true;
				},
				COMMAND_PRIORITY_EDITOR,
			),
			editor.registerCommand(
				KEY_TAB_COMMAND,
				(event) => {
					const toggle = $summaryToggle();
					if (!toggle) return false;
					// Nothing to nest under / out of → not ours: Tab falls through to
					// TabIndentationPlugin instead of being swallowed.
					if (event.shiftKey) {
						if (!$outdentToggle(toggle)) return false;
						event.preventDefault();
						return true;
					}
					const parent = $indentToggle(toggle);
					if (!parent) return false;
					event.preventDefault();
					store.setCollapsed(parent.getBlockId(), false);
					return true;
				},
				COMMAND_PRIORITY_NORMAL,
			),
			editor.registerCommand(
				KEY_ENTER_COMMAND,
				(event) => {
					if (event?.shiftKey) return false;
					const toggle = $summaryToggle();
					if (!toggle || !$enterOnSummary(toggle)) return false;
					event?.preventDefault();
					return true;
				},
				COMMAND_PRIORITY_NORMAL,
			),
			editor.registerCommand(
				KEY_BACKSPACE_COMMAND,
				() => {
					const selection = $getSelection();
					if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
					if (selection.anchor.offset !== 0) return false;
					const anchor = selection.anchor.getNode();
					const block = anchor.getParent();
					if (!block || !$isElementNode(block)) return false;
					const toggle = block.getParent();
					if (!$isToggleNode(toggle)) return false;
					if (toggle.getFirstChild() !== block) return false;
					// Only unwrap when the body is just empty paragraphs.
					const bodyHasContent = toggle
						.getChildren()
						.slice(1)
						.some((child) => child.getTextContent().trim().length > 0);
					if (bodyHasContent) return false;
					const replacement = $createParagraphNode();
					for (const child of block.getChildren()) replacement.append(child);
					toggle.replace(replacement);
					replacement.selectStart();
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
		);
	}, [editor, store]);

	return null;
}
