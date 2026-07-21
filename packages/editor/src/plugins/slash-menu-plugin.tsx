/**
 * SlashMenuPlugin — Lexical plugin + UI for the slash-command surface.
 *
 * Trigger: typing `/` at the start of an empty (or filtered) paragraph
 * opens the menu anchored to that paragraph's row. As the user keeps
 * typing, the text after the `/` is the filter query; ArrowUp/Down move
 * the highlight, Enter activates, Esc closes (all via Lexical commands
 * so the editor's existing key flow stays consistent).
 *
 * On accept the plugin clears the paragraph (deleting the `/<query>`
 * text) and dispatches the command, which dispatches
 * `TURN_INTO_COMMAND` to mutate the now-empty paragraph into the chosen
 * block type. Caret remains in the resulting block.
 *
 * Presentation: the popup is the shared **controlled-list** typeahead menu
 * (`@brainstorm-os/sdk/menus` `openTypeaheadMenu`) — the fancy-menus runtime in
 * `focusOnMount:false` + `KeyboardNavigation.None` mode, so it renders +
 * positions but never grabs focus or handles keys. The editor keeps focus and
 * owns the keyboard (the Lexical commands below), driving the runtime's
 * highlight through `activeIndex`. This replaced the former hand-rolled
 * `.fm-menu` div (≤fancy-menus 0.1.0 couldn't host-drive a list).
 *
 * v1 limits: triggers in plain `ParagraphNode`s only (not inside list
 * items or other containers). Multi-line slash commands aren't a thing.
 *
 * The command catalogue is host-provided — each app passes the
 * `commands` prop (Notes' full set; Journal's slimmer set). When
 * omitted the menu still mounts but renders nothing (no rows to show).
 */

import { closeTypeaheadMenu, openTypeaheadMenu } from "@brainstorm-os/sdk/menus";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$getNodeByKey,
	$getSelection,
	$isParagraphNode,
	$isRangeSelection,
	COMMAND_PRIORITY_HIGH,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_UP_COMMAND,
	KEY_ENTER_COMMAND,
	KEY_ESCAPE_COMMAND,
	type NodeKey,
} from "lexical";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BlockCommand } from "../block-command";
import { useEditorT } from "../i18n";

type MenuState = {
	paragraphKey: NodeKey;
	query: string;
};

export type SlashMenuPluginProps = {
	/** Command catalogue surfaced in the menu. Apps assemble their own
	 *  (`@brainstorm-os/editor`'s `BlockCommand` type). When omitted the
	 *  menu mounts but renders no rows. */
	commands?: readonly BlockCommand[];
};

export function SlashMenuPlugin({ commands = [] }: SlashMenuPluginProps = {}) {
	const [editor] = useLexicalComposerContext();
	const t = useEditorT();
	const [state, setState] = useState<MenuState | null>(null);
	const [highlightIndex, setHighlightIndex] = useState(0);

	const items = useMemo(
		() => (state ? filterCommands(commands, state.query) : []),
		[state, commands],
	);

	// Reset the highlight whenever the visible list shrinks past the cursor.
	useEffect(() => {
		if (highlightIndex >= items.length) setHighlightIndex(0);
	}, [items.length, highlightIndex]);

	useEffect(() => {
		return editor.registerUpdateListener(({ editorState }) => {
			editorState.read(() => {
				const next = computeMenuState();
				setState((prev) => {
					if (!next && !prev) return prev;
					if (next && prev && next.paragraphKey === prev.paragraphKey && next.query === prev.query) {
						return prev;
					}
					return next;
				});
			});
		});
	}, [editor]);

	const activate = useCallback(
		(command: BlockCommand) => {
			if (!state) return;
			editor.update(() => {
				const node = $getNodeByKey(state.paragraphKey);
				if (node && $isParagraphNode(node)) {
					node.clear();
					node.selectStart();
				}
			});
			setState(null);
			// Run the chosen command as a fresh top-level update. When activate
			// fires from the Enter handler it is nested inside KEY_ENTER_COMMAND's
			// update; dispatching the block command there merges it with the clear
			// above, so the selection just moved to the emptied paragraph reads as
			// lost and the block never transforms. Deferring runs the command after
			// the Enter update commits, against a settled selection — identical to
			// the click path (which is already top-level).
			queueMicrotask(() => command.run({ editor }));
		},
		[editor, state],
	);

	useEffect(() => {
		if (!state || items.length === 0) return;
		const unsubscribers = [
			editor.registerCommand(
				KEY_ARROW_DOWN_COMMAND,
				(event) => {
					event?.preventDefault();
					setHighlightIndex((i) => (i + 1) % items.length);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ARROW_UP_COMMAND,
				(event) => {
					event?.preventDefault();
					setHighlightIndex((i) => (i - 1 + items.length) % items.length);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ENTER_COMMAND,
				(event) => {
					event?.preventDefault();
					const choice = items[highlightIndex];
					if (choice) activate(choice);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ESCAPE_COMMAND,
				(event) => {
					event?.preventDefault();
					setState(null);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
		];
		return () => {
			for (const off of unsubscribers) off();
		};
	}, [editor, state, items, highlightIndex, activate]);

	// Open / refresh / close the shared controlled-list typeahead menu as the
	// slash state + filtered items + highlight change. The menu anchors to the
	// paragraph's row element and never takes focus (the editor owns the
	// keyboard above); a row click commits via `onSelect`. Fail-soft: when no
	// menu provider is mounted (some test/standalone shells), `openTypeaheadMenu`
	// is a no-op and the keyboard path above still drives everything.
	useEffect(() => {
		if (!state || items.length === 0) {
			closeTypeaheadMenu();
			return;
		}
		const anchor = editor.getElementByKey(state.paragraphKey);
		if (!anchor) {
			closeTypeaheadMenu();
			return;
		}
		openTypeaheadMenu({
			items: items.map((command) => ({
				id: command.id,
				label: command.label,
				icon: command.icon,
				...(command.description ? { description: command.description } : {}),
			})),
			anchor,
			activeIndex: highlightIndex,
			ariaLabel: t("editor.slashMenu.region"),
			onSelect: (id) => {
				const command = items.find((c) => c.id === id);
				if (command) activate(command);
			},
		});
	}, [editor, state, items, highlightIndex, activate, t]);

	// Close on unmount so a torn-down editor can't leave the menu hanging.
	useEffect(() => () => closeTypeaheadMenu(), []);

	return null;
}

function computeMenuState(): MenuState | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
	const anchor = selection.anchor.getNode();
	let topLevel: ReturnType<typeof anchor.getTopLevelElement>;
	try {
		topLevel = anchor.getTopLevelElementOrThrow();
	} catch {
		return null;
	}
	if (!topLevel || !$isParagraphNode(topLevel)) return null;
	const text = topLevel.getTextContent();
	if (!text.startsWith("/")) return null;
	// Bail if the query crossed into whitespace — the user is using `/` for
	// something other than a slash command (e.g., typing a date).
	const query = text.slice(1);
	if (query.includes("\n")) return null;
	return { paragraphKey: topLevel.getKey(), query };
}

/** Filter + RANK by relevance so the best match is highlighted first.
 *  Plain registry-order filtering shadowed real targets: e.g. "/sub"
 *  matched `Heading 2` (keyword "subtitle") and `Heading 3` (keyword
 *  "subheading") — both earlier in the registry — so pressing Enter
 *  inserted a heading instead of the `Sub-page` the user wanted. A
 *  label-prefix match must beat a keyword-substring match. Ties keep
 *  registry order (stable). */
export function filterCommands(
	commands: readonly BlockCommand[],
	query: string,
): readonly BlockCommand[] {
	const q = query.trim().toLowerCase();
	if (!q) return commands;
	const scored: { command: BlockCommand; score: number; index: number }[] = [];
	commands.forEach((command, index) => {
		const label = command.label.toLowerCase();
		const kw = command.keywords;
		let score = -1;
		if (label === q) score = 0;
		else if (label.startsWith(q)) score = 1;
		else if (kw.some((k) => k.toLowerCase() === q)) score = 2;
		else if (label.includes(q)) score = 3;
		else if (kw.some((k) => k.toLowerCase().startsWith(q))) score = 4;
		else if (kw.some((k) => k.toLowerCase().includes(q))) score = 5;
		if (score >= 0) scored.push({ command, score, index });
	});
	scored.sort((a, b) => a.score - b.score || a.index - b.index);
	return scored.map((s) => s.command);
}
