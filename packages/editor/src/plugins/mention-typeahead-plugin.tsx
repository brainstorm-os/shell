/**
 * MentionTypeaheadPlugin — `@`-typeahead surface for cross-app linking.
 *
 * Listens to editor updates; whenever the caret sits inside a plain
 * TextNode whose content matches `@<query>` (per
 * `detectMentionTrigger`), it opens an anchored popover ranking the
 * vault's entities by title. On accept, the plugin splits the anchor
 * TextNode and replaces `@<query>` with a `MentionNode` followed by a
 * trailing space so the caret can keep typing.
 *
 * Restrictions (v1):
 *   - Trigger detection runs against the single anchor TextNode, not
 *     across multiple inline runs. `**bold@query**` is intentionally
 *     not detected — the user can wrap the chip after insertion.
 *   - The picker queries `vaultEntities.list()` once per open (it
 *     refreshes when the popover opens, not while typing).
 *   - "+ Create new note" is a placeholder for the next iteration that
 *     wires `useNotes.create` + auto-mention.
 *
 * Anchoring uses the live selection's `getBoundingClientRect()` so the
 * popover hugs the caret across line wraps. Outside-mousedown closes;
 * Esc / ArrowKeys / Enter route through the Notes keyboard registry
 * for consistency with the slash menu + add-property menu.
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import {
	type TypeaheadMenuItem,
	closeTypeaheadMenu,
	openTypeaheadMenu,
} from "@brainstorm-os/sdk/menus";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createTextNode,
	$getNodeByKey,
	$getSelection,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_HIGH,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_UP_COMMAND,
	KEY_ENTER_COMMAND,
	KEY_ESCAPE_COMMAND,
	type LexicalEditor,
	type LexicalNode,
	type NodeKey,
	type TextNode,
} from "lexical";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EntityIcon } from "../entity-icon";
import { type EditorT, useEditorT } from "../i18n";
import { $createDateMentionNode } from "../nodes/date-mention-node";
import { $createMentionNode } from "../nodes/mention-node";
import { useEditorShortcut } from "./editor-shortcut";
import { fetchEntities, getEntityIcon } from "./entity-index";
import {
	type MentionTrigger,
	detectMentionTrigger,
	entityDisplayName,
	mentionEntityTypeLabel,
} from "./mention-ops";
import {
	type DateOption,
	type TypeaheadOption,
	TypeaheadOptionKind,
	buildTypeaheadOptions,
} from "./typeahead-options";

/** Mod+Shift+M opens the mention picker. */
const OPEN_MENTION_CHORDS = ["Mod+Shift+M"] as const;

type AnchorRect = { top: number; left: number; bottom: number };

type TypeaheadState = {
	textKey: NodeKey;
	trigger: MentionTrigger;
	anchor: AnchorRect;
};

export type MentionTypeaheadPluginProps = {
	/** The currently-open note's id, excluded from the picker so the
	 *  user can't self-mention. Optional — pass `null` for the empty
	 *  "no note open" state. */
	currentNoteId: string | null;
};

export function MentionTypeaheadPlugin({ currentNoteId }: MentionTypeaheadPluginProps) {
	const [editor] = useLexicalComposerContext();
	const t = useEditorT();
	const [state, setState] = useState<TypeaheadState | null>(null);
	const [entities, setEntities] = useState<readonly VaultEntity[]>([]);
	const [highlightIndex, setHighlightIndex] = useState(0);

	const excludeIds = useMemo(
		() => (currentNoteId ? new Set([currentNoteId]) : new Set<string>()),
		[currentNoteId],
	);

	const options = useMemo(
		() => buildTypeaheadOptions(entities, state?.trigger.query ?? "", Date.now(), excludeIds),
		[entities, state, excludeIds],
	);

	// B11.6 — `Mod+Shift+M` opens the picker by inserting the `@` trigger at
	// the caret (the same path typing `@` takes; the updateListener below then
	// detects it). A space is prefixed only when the caret is mid-word so the
	// `@` lands at a trigger boundary `detectMentionTrigger` accepts.
	useEditorShortcut(
		OPEN_MENTION_CHORDS,
		useCallback(
			(event: KeyboardEvent) => {
				event.preventDefault();
				editor.focus();
				editor.update(() => {
					const sel = $getSelection();
					if (!$isRangeSelection(sel)) return;
					const node = sel.anchor.getNode();
					const before = $isTextNode(node) ? node.getTextContent().slice(0, sel.anchor.offset) : "";
					const prev = before.slice(-1);
					const needsSpace = prev !== "" && !/[\s([{]/.test(prev);
					sel.insertText(needsSpace ? " @" : "@");
				});
			},
			[editor],
		),
	);

	useEffect(() => {
		if (highlightIndex >= options.length) setHighlightIndex(0);
	}, [options.length, highlightIndex]);

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

	// Refresh the entity list whenever the typeahead transitions from
	// closed → open. Filtering happens client-side as the user types.
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

	const insertOption = useCallback(
		(option: TypeaheadOption) => {
			if (!state) return;
			if (option.kind === TypeaheadOptionKind.Date) {
				applyDateMentionInsertion(editor, state.textKey, state.trigger, option.date);
			} else {
				applyMentionInsertion(editor, state.textKey, state.trigger, {
					entityId: option.entity.id,
					entityType: option.entity.type,
					label: entityDisplayName(option.entity),
				});
			}
			close();
		},
		[editor, state, close],
	);

	useEffect(() => {
		if (!state) return;
		const offs = [
			editor.registerCommand(
				KEY_ARROW_DOWN_COMMAND,
				(event) => {
					if (options.length === 0) return false;
					event?.preventDefault();
					setHighlightIndex((i) => (i + 1) % options.length);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ARROW_UP_COMMAND,
				(event) => {
					if (options.length === 0) return false;
					event?.preventDefault();
					setHighlightIndex((i) => (i - 1 + options.length) % options.length);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ENTER_COMMAND,
				(event) => {
					if (options.length === 0) return false;
					event?.preventDefault();
					const pick = options[highlightIndex];
					if (pick) insertOption(pick);
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
	}, [editor, state, options, highlightIndex, insertOption, close]);

	// Open / refresh / close the shared controlled-list typeahead menu as the
	// `@`-trigger state + ranked options + highlight change. Anchors to the live
	// caret rect (it hugs the caret across line wraps); the editor keeps focus
	// and owns the keyboard above. A row click commits via `onSelect`. When the
	// query matches nothing, a single non-interactive row carries the empty /
	// no-results message so the trigger stays visibly active.
	useEffect(() => {
		if (!state) {
			closeTypeaheadMenu();
			return;
		}
		const query = state.trigger.query;
		const items: TypeaheadMenuItem[] =
			options.length > 0
				? options.map((option) => optionToMenuItem(option, t))
				: [
						{
							id: EMPTY_ROW_ID,
							label:
								query.length > 0 ? t("editor.mention.noResults", { query }) : t("editor.mention.empty"),
							disabled: true,
						},
					];
		openTypeaheadMenu({
			items,
			rect: anchorToRect(state.anchor),
			activeIndex: options.length > 0 ? highlightIndex : -1,
			ariaLabel: t("editor.mention.region"),
			onSelect: (id) => {
				const pick = options.find((option) => optionId(option) === id);
				if (pick) insertOption(pick);
			},
		});
	}, [state, options, highlightIndex, insertOption, t]);

	// Close on unmount so a torn-down editor can't leave the menu hanging.
	useEffect(() => () => closeTypeaheadMenu(), []);

	return null;
}

/** Id used by the synthetic empty-state row (never committed). */
const EMPTY_ROW_ID = "__mention_empty__";

/** Stable id for a typeahead option — entity id, or `date-<iso>` for a date. */
function optionId(option: TypeaheadOption): string {
	return option.kind === TypeaheadOptionKind.Date ? `date-${option.date.iso}` : option.entity.id;
}

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

/** Map a ranked typeahead option to a shared menu row (icon + name + caption).
 *  The `t`-bound date caption is resolved at the call site (a hook value). */
function optionToMenuItem(option: TypeaheadOption, t: EditorT): TypeaheadMenuItem {
	if (option.kind === TypeaheadOptionKind.Date) {
		const { iso, label } = option.date;
		return {
			id: `date-${iso}`,
			label,
			icon: <Icon name={IconName.KindDate} size={14} />,
			description: label === iso ? t("editor.date.caption") : iso,
		};
	}
	return {
		id: option.entity.id,
		label: entityDisplayName(option.entity),
		icon: <EntityIcon icon={getEntityIcon(option.entity.id)} size={14} />,
		description: mentionEntityTypeLabel(option.entity.type),
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
	const trigger = detectMentionTrigger(text, caret);
	if (!trigger) return null;
	const rect = readCaretRect();
	if (!rect) return null;
	return { textKey: node.getKey(), trigger, anchor: rect };
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

export type MentionInsertion = {
	entityId: string;
	entityType: string;
	label: string;
};

/** Replace `@<query>` in the anchor TextNode with the inline chip `makeNode`
 *  builds, then a trailing space, and place the caret after the space. Wraps
 *  its own `editor.update()` so tests can drive it on a headless editor. The
 *  `@`-mention + `@`-date inserts share this splice (the only difference is
 *  the node built). */
function replaceTriggerWithNode(
	editor: LexicalEditor,
	textKey: NodeKey,
	trigger: MentionTrigger,
	makeNode: () => LexicalNode,
): void {
	editor.update(
		() => {
			const node = $getNodeByKey(textKey);
			if (!node || !$isTextNode(node)) return;
			const text = node.getTextContent();
			const start = trigger.triggerOffset;
			const end = start + 1 + trigger.query.length;
			if (end > text.length) return;
			const middle = pickMiddle(node, text, start, end);
			if (!middle) return;
			const chip = makeNode();
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

/** Replace `@<query>` with a `MentionNode`. Exported so the typeahead tests
 *  can call it directly on a headless editor. */
export function applyMentionInsertion(
	editor: LexicalEditor,
	textKey: NodeKey,
	trigger: MentionTrigger,
	insertion: MentionInsertion,
): void {
	replaceTriggerWithNode(editor, textKey, trigger, () =>
		$createMentionNode(insertion.entityId, insertion.entityType, insertion.label),
	);
}

/** Replace `@<query>` with a `DateMentionNode` carrying the resolved day. */
export function applyDateMentionInsertion(
	editor: LexicalEditor,
	textKey: NodeKey,
	trigger: MentionTrigger,
	date: DateOption["date"],
): void {
	replaceTriggerWithNode(editor, textKey, trigger, () =>
		$createDateMentionNode(date.iso, date.label),
	);
}

/** Split the anchor TextNode at `[start, end)` and return the middle
 *  segment (the `@<query>` portion). Returns `null` if the split
 *  yields nothing — e.g. the offsets escaped the node's range. */
function pickMiddle(node: TextNode, text: string, start: number, end: number): TextNode | null {
	if (start === 0 && end === text.length) return node;
	const parts: TextNode[] = node.splitText(start, end);
	if (parts.length === 0) return null;
	if (start === 0) return parts[0] ?? null;
	if (end === text.length) return parts[1] ?? null;
	return parts[1] ?? null;
}
