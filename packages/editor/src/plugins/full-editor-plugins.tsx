/**
 * `<FullEditorPlugins>` — the shared "rich editor" composition every app
 * mounts so Notes / Journal / Tasks get the SAME editing surface. It
 * builds on `<StandardEditingPlugins>` (slash menu, block gutter,
 * turn-into, tables, toggles, columns, checklist, divider, markdown,
 * tab-indentation, block selection) and layers the now-shared rich
 * plugins on top: the code-block stack, in-document find, emoji
 * typeahead, the empty-paragraph hint, and marquee block selection.
 *
 * Pair it with `additionalNodes={STANDARD_ADDITIONAL_NODES}` on
 * `<BrainstormEditor>` and import `@brainstorm-os/editor/editor-theme.css`
 * once at app boot so the blocks are styled.
 *
 * Mentions, transclusion, entity embeds (`/embed` → `BlockEmbedNode`),
 * and media are all shared now — each behind a flag (defaulting on when
 * the host provides an entity context / stays on for media) so an app
 * turns one off only as a deliberate product choice. Still-Notes-only:
 * link-markup, property blocks, backlinks.
 *
 * Every extra is on by default but individually switchable, so a light
 * surface (e.g. a comment box) can drop the code stack while still
 * getting the standard block menu.
 *
 * This composition is the CAPABILITY FLOOR for every editor surface. Notes
 * hand-assembles its tree (it interleaves Notes-only slash commands) rather
 * than mounting this, so the two can't share code directly — instead
 * `apps/notes/src/editor/editor-parity.test.ts` fences the drift: Notes must
 * offer every generic command + node this provides. Add a generally-useful
 * capability HERE first (it reaches Journal/Tasks/Bookmarks for free), then
 * wire it into Notes; never the reverse.
 */

import { type ReactNode, useMemo } from "react";
import type { BlockCommand } from "../block-command";
import type { SelectionCommentAnchor } from "../comments/selection-anchor";
import { useEditorT } from "../i18n";
import { createMediaBlockCommands } from "../media-commands";
import { createEntityEmbedCommand, createTransclusionCommand } from "../standard-commands";
import { BlockEmbedPickerPlugin } from "./block-embed-picker-plugin";
import { CodeBlockPlugin } from "./code-block-plugin";
import { CodeBlockToolbarPlugin } from "./code-block-toolbar-plugin";
import { CodeHighlightPlugin } from "./code-highlight-plugin";
import { CodeLineNumbersPlugin } from "./code-line-numbers-plugin";
import { EmbedPlugin } from "./embed-plugin";
import { EmojiTypeaheadPlugin } from "./emoji-typeahead-plugin";
import { EmptyParagraphHintPlugin } from "./empty-paragraph-hint-plugin";
import { FindPlugin } from "./find-plugin";
import { InlineToolbarPlugin } from "./inline-toolbar-plugin";
import { MarqueePlugin } from "./marquee-plugin";
import { MediaDropPlugin } from "./media-drop-plugin";
import { MediaInspectorPlugin } from "./media-inspector-plugin";
import { MentionTypeaheadPlugin } from "./mention-typeahead-plugin";
import { StandardEditingPlugins } from "./standard-editing-plugins";
import { TransclusionTypeaheadPlugin } from "./transclusion-typeahead-plugin";

export type FullEditorPluginsProps = {
	/** CSS selector for the editor's scroll container — the block gutter
	 *  positions its hover affordance relative to it. */
	scrollContainerSelector?: string;
	/** Focus the first block on mount (e.g. a freshly opened doc). */
	autoFocus?: boolean;
	/** Extra slash-menu commands appended after the standard set. */
	extraCommands?: readonly BlockCommand[];
	/** Ordered subset of shared command ids this app's slash menu exposes
	 *  (F-070 rung (b)). Omit for the full shared catalogue. The host-gated
	 *  "Reference" command is appended after, independent of the palette. */
	palette?: readonly string[];
	/** Document id toggle collapsed-state is namespaced under. */
	docId?: string;
	/** Code-block editing stack (toolbar + highlight + line numbers). */
	code?: boolean;
	/** `:`-shortcode + Mod+e emoji typeahead. */
	emoji?: boolean;
	/** In-document find (Cmd+F). */
	find?: boolean;
	/** "Type ‘/’ for commands" ghost on the focused empty paragraph. */
	emptyHint?: boolean;
	/** Drag-rectangle multi-block selection. */
	marquee?: boolean;
	/** Floating selection formatting toolbar (B/I/U/S/code + colour + link).
	 *  Mention/emoji overflow rows follow the typeahead flags. */
	inlineToolbar?: boolean;
	/** Comment-on-selection (B11.9): adds the toolbar's "Comment" overflow row,
	 *  handing the selection's enclosing block id + quote to the host. */
	onComment?: (anchor: SelectionCommentAnchor) => void;
	/** Lone-URL paste → bookmark / embed / link chooser. */
	embed?: boolean;
	/** Media blocks: `/image` `/video` `/audio` `/file` slash commands,
	 *  drag-drop + paste of files, and the click-to-edit inspector. Needs a
	 *  host uploader wired via `setEditorHost({ uploadFile })` for durable
	 *  storage (images fall back to an inline data URL under 2 MiB). */
	media?: boolean;
	/** The host entity's id — enables `@`-mentions + `!@`-transclusion
	 *  (excluded from self-reference) and is the cycle-guard root for
	 *  transclusion. Pass `null` for a surface with no entity identity
	 *  (the typeaheads still mount but can't self-exclude). Omit entirely
	 *  to leave mentions/transclusion off. */
	currentEntityId?: string | null;
	/** Override: force `@`-mention typeahead on/off (defaults to on when
	 *  `currentEntityId` is provided). */
	mentions?: boolean;
	/** Override: force `!@`-transclusion typeahead on/off (defaults to on
	 *  when `currentEntityId` is provided). */
	transclusion?: boolean;
	/** Override: force the `/embed` entity-card command + picker on/off
	 *  (defaults to on when `currentEntityId` is provided — same host gate
	 *  as transclusion, F-070 embed parity). */
	entityEmbed?: boolean;
	/** Host-specific plugins/decorators rendered inside the selection
	 *  provider alongside the shared set (e.g. the app's AutosavePlugin,
	 *  TitlePlugin, mention/transclusion typeaheads). */
	children?: ReactNode;
};

export function FullEditorPlugins({
	scrollContainerSelector,
	autoFocus = false,
	extraCommands,
	palette,
	docId,
	code = true,
	emoji = true,
	find = true,
	emptyHint = true,
	marquee = true,
	embed = true,
	media = true,
	inlineToolbar = true,
	onComment,
	currentEntityId,
	mentions,
	transclusion,
	entityEmbed,
	children,
}: FullEditorPluginsProps): ReactNode {
	const hasEntity = currentEntityId !== undefined;
	const entityId = currentEntityId ?? null;
	const showMentions = mentions ?? hasEntity;
	const showTransclusion = transclusion ?? hasEntity;
	const showEntityEmbed = entityEmbed ?? hasEntity;
	const t = useEditorT();
	// When transclusion / entity-embed are on, the "Embed" command (opens the
	// anchored entity picker) and the "Reference" command (opens the `!@`
	// typeahead) join the slash menu — the shared affordances for embedding
	// another vault object in any app's editor, gated on the host providing
	// an entity context. Order mirrors Notes' catalogue: Embed before
	// Reference.
	const mergedCommands = useMemo<readonly BlockCommand[]>(() => {
		const extras = extraCommands ? [...extraCommands] : [];
		if (media) extras.push(...createMediaBlockCommands(t));
		if (showEntityEmbed) extras.push(createEntityEmbedCommand(t));
		if (showTransclusion) extras.push(createTransclusionCommand(t));
		return extras;
	}, [t, extraCommands, showTransclusion, showEntityEmbed, media]);
	return (
		<StandardEditingPlugins
			autoFocus={autoFocus}
			inlineToolbar={false}
			{...(scrollContainerSelector ? { scrollContainerSelector } : {})}
			{...(mergedCommands.length > 0 ? { extraCommands: mergedCommands } : {})}
			{...(palette ? { palette } : {})}
			{...(docId ? { docId } : {})}
		>
			{code ? (
				<>
					<CodeBlockPlugin />
					<CodeBlockToolbarPlugin />
					<CodeHighlightPlugin />
					<CodeLineNumbersPlugin />
				</>
			) : null}
			{emoji ? <EmojiTypeaheadPlugin /> : null}
			{find ? <FindPlugin /> : null}
			{emptyHint ? <EmptyParagraphHintPlugin /> : null}
			{marquee ? <MarqueePlugin /> : null}
			{inlineToolbar ? (
				<InlineToolbarPlugin
					mention={showMentions}
					emoji={emoji}
					{...(onComment ? { onComment } : {})}
				/>
			) : null}
			{embed ? <EmbedPlugin /> : null}
			{media ? (
				<>
					<MediaDropPlugin />
					<MediaInspectorPlugin />
				</>
			) : null}
			{showMentions ? <MentionTypeaheadPlugin currentNoteId={entityId} /> : null}
			{showTransclusion ? <TransclusionTypeaheadPlugin currentNoteId={entityId} /> : null}
			{showEntityEmbed ? <BlockEmbedPickerPlugin currentNoteId={entityId} /> : null}
			{children}
		</StandardEditingPlugins>
	);
}
