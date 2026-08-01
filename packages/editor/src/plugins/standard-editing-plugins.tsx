/**
 * `<StandardEditingPlugins>` — the standard block-editing experience bundled
 * once in the common editor so every app gets the SAME slash menu, block
 * gutter, turn-into, tables, toggles, columns, checklists, dividers, markdown
 * shortcuts and tab-indentation without re-wiring the tree. Apps mount it as
 * the child of `<BrainstormEditor>` and pair it with
 * `additionalNodes={STANDARD_ADDITIONAL_NODES}` so the commands have nodes to
 * create.
 *
 * It wraps its subtree in `<BlockSelectionPlugin>` (the multi-block selection
 * provider the gutter / action menu read from), then mounts the generic plugin
 * set. Host-specific extras (an app's own `OnChangePlugin`, extra slash
 * commands, media drop) go in `children` — they render inside the selection
 * provider alongside the standard set.
 *
 * Notes deliberately still hand-mounts its own (larger, app-coupled) tree;
 * this bundle is the baseline for apps that want a Notes-like editor without
 * Notes' mentions / transclusions / properties / media library.
 */

import { TRANSFORMERS } from "@lexical/markdown";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { type ReactNode, useMemo } from "react";
import type { BlockCommand } from "../block-command";
import { useEditorT } from "../i18n";
import { BLOCK_MARKDOWN_TRANSFORMERS } from "../markdown-block-transformers";
import {
	createStandardBlockActions,
	createStandardBlockCommands,
	orderCommandsByPalette,
} from "../standard-commands";
import { BlockGutterPlugin } from "./block-gutter-plugin";
import { BlockSelectionPlugin } from "./block-selection-plugin";
import { ColumnsPlugin } from "./columns-plugin";
import { FormatChordsPlugin } from "./format-chords-plugin";
import { InitialFocusPlugin } from "./initial-focus-plugin";
import { InlineToolbarPlugin } from "./inline-toolbar-plugin";
import { ListMarkdownShortcutsPlugin } from "./list-markdown-shortcuts-plugin";
import { SlashMenuPlugin } from "./slash-menu-plugin";
import { TablesPlugin } from "./table-plugin";
import { TogglePlugin } from "./toggle-plugin";
import { TurnIntoPlugin } from "./turn-into-plugin";

export type StandardEditingPluginsProps = {
	/** CSS selector for the editor's scroll container — the block gutter
	 *  positions its hover affordance relative to it. Defaults to the nearest
	 *  scrollable ancestor when omitted. */
	scrollContainerSelector?: string;
	/** Focus the first block on mount (e.g. a freshly opened doc). Off by
	 *  default so it doesn't steal focus in read-first surfaces. */
	autoFocus?: boolean;
	/** Extra slash-menu commands appended after the standard set (app-specific
	 *  inserts). The standard turn-into / structural commands always come first. */
	extraCommands?: readonly BlockCommand[];
	/** Ordered subset of shared command ids this app exposes in its slash menu
	 *  (F-070 rung (b)). When set, the standard catalogue is filtered + reordered
	 *  to match; `extraCommands` still append after. Omit for the full catalogue. */
	palette?: readonly string[];
	/** Document id toggle collapsed-state is namespaced under (per-device,
	 *  persisted across reloads). Omit for a session-only in-memory store. */
	docId?: string;
	/** Floating selection formatting toolbar (B/I/U/S/code + colour + link).
	 *  On by default. `<FullEditorPlugins>` turns it off here and mounts its own
	 *  (with mention/emoji overflow rows) to avoid a double toolbar. */
	inlineToolbar?: boolean;
	/** Keyboard chords for strike (`Mod+Shift+S`), code (`Mod+Shift+E`) and
	 *  turn-into (`Mod+Alt+0…9`). On by default. */
	formatChords?: boolean;
	/** Host-specific plugins/decorators rendered inside the selection provider
	 *  alongside the standard set (e.g. the app's `OnChangePlugin`). */
	children?: ReactNode;
};

export function StandardEditingPlugins({
	scrollContainerSelector,
	autoFocus = false,
	extraCommands,
	palette,
	docId,
	inlineToolbar = true,
	formatChords = true,
	children,
}: StandardEditingPluginsProps): ReactNode {
	const t = useEditorT();
	const commands = useMemo(() => {
		const base = orderCommandsByPalette(createStandardBlockCommands(t), palette);
		return extraCommands && extraCommands.length > 0 ? [...base, ...extraCommands] : base;
	}, [t, extraCommands, palette]);
	const actions = useMemo(() => createStandardBlockActions(t), [t]);

	return (
		<BlockSelectionPlugin>
			<CheckListPlugin />
			<HorizontalRulePlugin />
			<MarkdownShortcutPlugin transformers={[...BLOCK_MARKDOWN_TRANSFORMERS, ...TRANSFORMERS]} />
			<ListMarkdownShortcutsPlugin />
			<TabIndentationPlugin />
			<TurnIntoPlugin />
			<SlashMenuPlugin commands={commands} />
			<TablesPlugin />
			<TogglePlugin {...(docId ? { docId } : {})} />
			<ColumnsPlugin />
			<BlockGutterPlugin
				commands={actions}
				{...(scrollContainerSelector ? { scrollContainerSelector } : {})}
			/>
			{autoFocus ? <InitialFocusPlugin /> : null}
			{inlineToolbar ? <InlineToolbarPlugin /> : null}
			{formatChords ? <FormatChordsPlugin /> : null}
			{children}
		</BlockSelectionPlugin>
	);
}
