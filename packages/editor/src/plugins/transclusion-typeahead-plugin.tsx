/**
 * TransclusionTypeaheadPlugin — `!@`-typeahead surface for inline
 * transclusion. Mirrors `MentionTypeaheadPlugin` for the popover chrome
 * and keyboard routing (the slash menu / mention typeahead patterns are
 * the established Notes idiom); the trigger grammar is the stricter
 * `detectTransclusionTrigger` from `transclusion-ops.ts` (start-of-line
 * or post-whitespace only — never inside a word).
 *
 * The picker calls `resolveTransclusionTarget` before insertion. v1
 * rejects the `Self` case only (a note can't transclude itself); the
 * multi-hop cycle / depth check accepts `childrenOf` from
 * `transclusion-ops` but ships with an empty edge map until the
 * read-only nested-body renderer lands at B6.4b — that's when the cost
 * of building the edge map (resolving every transclusion target's YDoc)
 * gets amortised against the work we already have to do for nesting.
 * The renderer-side depth budget is the defense against a hand-edited
 * body that smuggles a cycle past this guard.
 *
 * On accept the `!@<query>` span replaces with a `TransclusionNode` +
 * trailing newline (block-level — the node is `isInline(): false`).
 * Mirrors `applyEmbedInsertion`'s replace-and-trail pattern rather than
 * `applyMentionInsertion`'s in-line split, since transclusion is a
 * block-level node like BlockEmbedNode.
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";
import {
	type TypeaheadMenuItem,
	closeTypeaheadMenu,
	openTypeaheadMenu,
} from "@brainstorm-os/sdk/menus";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createParagraphNode,
	$createTextNode,
	$getNodeByKey,
	$getSelection,
	$isParagraphNode,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_HIGH,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_UP_COMMAND,
	KEY_ENTER_COMMAND,
	KEY_ESCAPE_COMMAND,
	type LexicalEditor,
	type NodeKey,
	type TextNode,
} from "lexical";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type EditorT, useEditorT } from "../i18n";
import { $createInlineTransclusionNode } from "../nodes/inline-transclusion-node";
import { $createTransclusionNode } from "../nodes/transclusion-node";
import { fetchEntities } from "./entity-index";
import { entityDisplayName, filterEntities } from "./mention-ops";
import {
	TransclusionPlacement,
	TransclusionRejectReason,
	type TransclusionTrigger,
	detectTransclusionTrigger,
	resolveTransclusionPlacement,
	resolveTransclusionTarget,
} from "./transclusion-ops";

type AnchorRect = { top: number; left: number; bottom: number };

type TypeaheadState = {
	textKey: NodeKey;
	trigger: TransclusionTrigger;
	anchor: AnchorRect;
	/** Whether the `!@` opened at the very start of its block (first child,
	 *  offset 0) — decides block vs inline placement (B11.1). */
	atBlockStart: boolean;
};

export type TransclusionTypeaheadPluginProps = {
	/** The currently-open note's id — passed to
	 *  `resolveTransclusionTarget` so a note can't transclude itself.
	 *  `null` for the empty "no note open" state (the picker still opens
	 *  on `!@`, but every result is acceptable since the self-check is
	 *  inert without a host id). */
	currentNoteId: string | null;
};

export function TransclusionTypeaheadPlugin({ currentNoteId }: TransclusionTypeaheadPluginProps) {
	const [editor] = useLexicalComposerContext();
	const t = useEditorT();
	const [state, setState] = useState<TypeaheadState | null>(null);
	const [entities, setEntities] = useState<readonly VaultEntity[]>([]);
	const [highlightIndex, setHighlightIndex] = useState(0);

	// `Self` is the only cycle the v1 picker can detect synchronously;
	// deeper cycles need an edge map we don't have until B6.4b lands the
	// nested-body renderer. The exclusion list pre-filters the host so a
	// Self-rejected row never appears in the results, sparing the user
	// the dead-end-pick UX.
	const excludeIds = useMemo(
		() => (currentNoteId ? new Set([currentNoteId]) : new Set<string>()),
		[currentNoteId],
	);

	const results = useMemo(
		() => filterEntities(entities, state?.trigger.query ?? "", excludeIds),
		[entities, state, excludeIds],
	);

	useEffect(() => {
		if (highlightIndex >= results.length) setHighlightIndex(0);
	}, [results.length, highlightIndex]);

	useEffect(() => {
		return editor.registerUpdateListener(({ editorState }) => {
			editorState.read(() => {
				const next = computeTriggerState();
				setState((prev) => {
					if (!next && !prev) return prev;
					if (
						next &&
						prev &&
						next.textKey === prev.textKey &&
						next.trigger.triggerOffset === prev.trigger.triggerOffset &&
						next.trigger.query === prev.trigger.query &&
						next.anchor.top === prev.anchor.top &&
						next.anchor.left === prev.anchor.left
					) {
						return prev;
					}
					return next;
				});
			});
		});
	}, [editor]);

	useEffect(() => {
		if (!state) return;
		let cancelled = false;
		void fetchEntities().then((entities) => {
			if (!cancelled) setEntities(entities);
		});
		return () => {
			cancelled = true;
		};
	}, [state]);

	const close = useCallback(() => {
		setState(null);
	}, []);

	const insertTransclusion = useCallback(
		(entity: VaultEntity) => {
			if (!state) return;
			// `Self` is the only check that fires synchronously with v1 data.
			// The picker's exclude list already removes the host; this is a
			// defense-in-depth fence for the rare path where the host id
			// landed in the entity list anyway (e.g. a future picker variant).
			if (currentNoteId) {
				const verdict = resolveTransclusionTarget(currentNoteId, entity.id, () => []);
				if (!verdict.ok && verdict.reason === TransclusionRejectReason.Self) {
					close();
					return;
				}
			}
			const label = entityDisplayName(entity);
			const insertion = { entityId: entity.id, entityType: entity.type, label };
			const placement = resolveTransclusionPlacement(state.atBlockStart);
			if (placement === TransclusionPlacement.Inline) {
				applyInlineTransclusionInsertion(editor, state.textKey, state.trigger, insertion);
			} else {
				applyTransclusionInsertion(editor, state.textKey, state.trigger, insertion);
			}
			close();
		},
		[editor, state, currentNoteId, close],
	);

	useEffect(() => {
		if (!state) return;
		const offs = [
			editor.registerCommand(
				KEY_ARROW_DOWN_COMMAND,
				(event) => {
					if (results.length === 0) return false;
					event?.preventDefault();
					setHighlightIndex((i) => (i + 1) % results.length);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ARROW_UP_COMMAND,
				(event) => {
					if (results.length === 0) return false;
					event?.preventDefault();
					setHighlightIndex((i) => (i - 1 + results.length) % results.length);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ENTER_COMMAND,
				(event) => {
					if (results.length === 0) return false;
					event?.preventDefault();
					const pick = results[highlightIndex]?.entity;
					if (pick) insertTransclusion(pick);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ESCAPE_COMMAND,
				(event) => {
					event?.preventDefault();
					close();
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
		];
		return () => {
			for (const off of offs) off();
		};
	}, [editor, state, results, highlightIndex, insertTransclusion, close]);

	// Open / refresh / close the shared controlled-list typeahead menu as the
	// `!@`-trigger state + ranked results + highlight change. Anchors to the live
	// caret rect; the editor keeps focus and owns the keyboard above. A row click
	// commits via `onSelect`; an empty query shows a non-interactive no-results
	// row so the trigger stays visibly active.
	useEffect(() => {
		if (!state) {
			closeTypeaheadMenu();
			return;
		}
		const query = state.trigger.query;
		const items: TypeaheadMenuItem[] =
			results.length > 0
				? results.map((result) => ({
						id: result.entity.id,
						label: entityDisplayName(result.entity),
						description: shortTypeLabel(result.entity.type, t),
					}))
				: [
						{
							id: EMPTY_ROW_ID,
							label:
								query.length > 0
									? t("editor.transclusion.noResults", { query })
									: t("editor.transclusion.empty"),
							disabled: true,
						},
					];
		openTypeaheadMenu({
			items,
			rect: anchorToRect(state.anchor),
			activeIndex: results.length > 0 ? highlightIndex : -1,
			ariaLabel: t("editor.transclusion.region"),
			onSelect: (id) => {
				const pick = results.find((result) => result.entity.id === id);
				if (pick) insertTransclusion(pick.entity);
			},
		});
	}, [state, results, highlightIndex, insertTransclusion, t]);

	// Close on unmount so a torn-down editor can't leave the menu hanging.
	useEffect(() => () => closeTypeaheadMenu(), []);

	return null;
}

/** Id used by the synthetic empty-state row (never committed). */
const EMPTY_ROW_ID = "__transclusion_empty__";

/** A thin caret rect → the viewport rect the runtime anchors the menu to. */
function anchorToRect(a: AnchorRect): DOMRect {
	return {
		x: a.left,
		y: a.top,
		top: a.top,
		bottom: a.bottom,
		left: a.left,
		right: a.left,
		width: 0,
		height: a.bottom - a.top,
		toJSON: () => ({ x: a.left, y: a.top, width: 0, height: a.bottom - a.top }),
	};
}

function computeTriggerState(): TypeaheadState | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
	const anchor = selection.anchor;
	const node = anchor.getNode();
	if (!$isTextNode(node)) return null;
	const text = node.getTextContent();
	const caret = anchor.offset;
	const trigger = detectTransclusionTrigger(text, caret);
	if (!trigger) return null;
	const rect = readCaretRect();
	if (!rect) return null;
	const atBlockStart = trigger.triggerOffset === 0 && node.getPreviousSibling() === null;
	return { textKey: node.getKey(), trigger, anchor: rect, atBlockStart };
}

function readCaretRect(): AnchorRect | null {
	if (typeof window === "undefined") return null;
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0).cloneRange();
	const rects = range.getClientRects();
	const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
	if (!rect || (rect.top === 0 && rect.left === 0 && rect.bottom === 0)) return null;
	return { top: rect.top, left: rect.left, bottom: rect.bottom };
}

function shortTypeLabel(entityType: string, t: EditorT): string {
	if (!entityType) return t("editor.transclusion.typeUnknown");
	const lastSlash = entityType.lastIndexOf("/");
	const tail = lastSlash >= 0 ? entityType.slice(lastSlash + 1) : entityType;
	const trimmed = tail.replace(/^v\d+$/, "");
	if (trimmed.length > 0) return trimmed;
	const penultimate = entityType.slice(0, lastSlash);
	const prevSlash = penultimate.lastIndexOf("/");
	return prevSlash >= 0 ? penultimate.slice(prevSlash + 1) : penultimate;
}

export type TransclusionInsertion = {
	entityId: string;
	entityType: string;
	label: string;
};

/** Replace `!@<query>` in the anchor TextNode with a `TransclusionNode`
 *  and ensure a clean follow-paragraph for the caret to land in. Wraps
 *  its own `editor.update()` so tests can call it directly. Block-level
 *  splice — the `!@<query>` span is removed, the host paragraph is split
 *  around it, and the `TransclusionNode` is inserted between the two
 *  halves (similar to BlockEmbedNode insertion). */
export function applyTransclusionInsertion(
	editor: LexicalEditor,
	textKey: NodeKey,
	trigger: TransclusionTrigger,
	insertion: TransclusionInsertion,
): void {
	editor.update(
		() => {
			const node = $getNodeByKey(textKey);
			if (!node || !$isTextNode(node)) return;
			const text = node.getTextContent();
			const start = trigger.triggerOffset;
			const end = start + 2 + trigger.query.length;
			if (end > text.length) return;
			const middle = pickMiddle(node, text, start, end);
			if (!middle) return;
			const transclusion = $createTransclusionNode(
				insertion.entityId,
				insertion.entityType,
				insertion.label,
			);
			// Replace the `!@<query>` text segment with the block node.
			// Lexical's `replace` handles the splice + re-parent; after that
			// we ensure the caret lands in a fresh paragraph after the node
			// so the user can keep typing without their cursor stranded
			// inside the (block-level, decorator) transclusion.
			middle.replace(transclusion);
			const parent = transclusion.getParent();
			if (parent && $isParagraphNode(parent) && parent.getChildrenSize() === 1) {
				// The transclusion is the only child of its enclosing paragraph;
				// promote it: insert a new empty paragraph after and remove the
				// now-redundant wrapper around the decorator node. (Decorator
				// nodes don't need a paragraph wrapper to render but Lexical
				// won't strip one for us.)
				const tail = $createParagraphNode();
				parent.insertAfter(tail);
				tail.select(0, 0);
			} else {
				const tail = $createParagraphNode();
				transclusion.insertAfter(tail);
				tail.select(0, 0);
			}
		},
		{ discrete: true },
	);
}

/** Replace `!@<query>` with an inline `InlineTransclusionNode` (B11.1), keeping
 *  the host paragraph intact and dropping the caret in a trailing space after
 *  the chip — the inline analogue of `applyTransclusionInsertion`'s block
 *  splice, mirroring `replaceTriggerWithNode` from the mention plugin. Exported
 *  so the typeahead tests can drive it on a headless editor. */
export function applyInlineTransclusionInsertion(
	editor: LexicalEditor,
	textKey: NodeKey,
	trigger: TransclusionTrigger,
	insertion: TransclusionInsertion,
): void {
	editor.update(
		() => {
			const node = $getNodeByKey(textKey);
			if (!node || !$isTextNode(node)) return;
			const text = node.getTextContent();
			const start = trigger.triggerOffset;
			const end = start + 2 + trigger.query.length;
			if (end > text.length) return;
			const middle = pickMiddle(node, text, start, end);
			if (!middle) return;
			const chip = $createInlineTransclusionNode(
				insertion.entityId,
				insertion.entityType,
				insertion.label,
			);
			middle.replace(chip);
			const tail = chip.getNextSibling();
			if (tail && $isTextNode(tail)) {
				tail.setTextContent(` ${tail.getTextContent()}`);
				tail.select(1, 1);
			} else {
				const space = $createTextNode(" ");
				chip.insertAfter(space);
				space.select(1, 1);
			}
		},
		{ discrete: true },
	);
}

/** Split the anchor TextNode at `[start, end)` and return the middle
 *  segment (the `!@<query>` portion). Returns `null` if the split
 *  yields nothing. Same shape as MentionTypeaheadPlugin's helper. */
function pickMiddle(node: TextNode, text: string, start: number, end: number): TextNode | null {
	if (start === 0 && end === text.length) return node;
	const parts: TextNode[] = node.splitText(start, end);
	if (parts.length === 0) return null;
	if (start === 0) return parts[0] ?? null;
	if (end === text.length) return parts[1] ?? null;
	return parts[1] ?? null;
}
