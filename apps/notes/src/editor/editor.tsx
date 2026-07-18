/**
 * Editor — the Yjs-bound Lexical composer that is THE Notes editor
 * (9.3.5.N2 — the legacy storage-blob composer + transport flag died
 * here; 9.3.5.N3 reconciled selection/IME/autosave parity on top).
 * Lexical state is bound to the entity's Y.Doc via the universal body
 * root (`Y.XmlText` named `"root"`, per
 *  §Universal rich-text body)
 * through the shared `<BrainstormEditor>` wrapper from
 * `@brainstorm/editor`. Persistence flows through the 9.3.2b
 * `loadDoc`/`applyDoc` resolver, not the per-note kv silo.
 *
 * Initial state (9.3.5.N3): title seeding rides
 * `<BrainstormEditor initialEditorState>`, which forwards to
 * `<CollaborationPlugin>` — the seeder runs once on the first client
 * to attach to an empty root XmlText, never again on that doc. A
 * non-empty `storedTitle` (legacy migration / compose-intent / journal
 * date-key) populates the TitleNode; an empty one leaves the TitleNode
 * blank and the TitlePlugin's RootNode transform fills the
 * "root.firstChild is a TitleNode" invariant.
 *
 * Undo/redo (9.3.5.N3): `CollaborationPlugin` already mounts the Yjs
 * `UndoManager` (`useYjsHistory` → `createUndoManager(binding,
 * binding.root.getSharedType())`) and wires `UNDO_COMMAND` /
 * `REDO_COMMAND`. We deliberately do NOT mount Lexical's
 * `HistoryPlugin` on top — that would stack two undo stacks and
 * double-apply on Mod+Z.
 *
 * Autosave: `AutosavePlugin` still calls `onChange` with the
 * `SerializedEditorState` so the caller can derive the denormalised
 * title + a sidebar/local-search snippet without re-resolving the
 * Y.Doc. The body content itself is NOT written via this callback —
 * the Y.Doc resolver owns canonical persistence. The first-real-
 * interaction gate (per [[project_notes_autosave_swallows_first_edit]])
 * survives the rewrite: a programmatic Y.Doc update does NOT fire
 * `onChange`; only a real KEY_DOWN/PASTE/CUT/DROP arms the next
 * commit.
 *
 * Plugins NOT mounted (intentional):
 *  - `HistoryPlugin` — Yjs UndoManager owns undo/redo under collab.
 *  - `ListPlugin` / `LinkPlugin` — already mounted by `<BrainstormEditor>`.
 *
 * Plugins that ARE mounted (parity-tested via the plugin smoke harness):
 *  - The whole Notes-specific plugin tree (Title / Slash / TurnInto /
 *    Tables / Toggle / Embed / Columns / Mention / BlockEmbedPicker /
 *    LinkMarkup / Find / Autosave / BlockGutter / BlockSelection /
 *    Inline-toolbar / Marquee / Media / context-menu / hint / etc.).
 *  - Theme + node set match the prior legacy editor exactly (single
 *    source — `nodes.ts` BASELINE_NODES is a strict subset of Notes' node
 *    array).
 */

import {
	AutosavePlugin,
	BLOCK_ANCHORS_MAP_NAME,
	BLOCK_MARKDOWN_TRANSFORMERS,
	BlankRecoveryPlugin,
	type BlockAnchorReveal,
	BlockAnchorsPlugin,
	BlockEmbedPickerPlugin,
	BlockGutterPlugin,
	BlockSelectionPlugin,
	BrainstormEditor,
	CodeBlockPlugin,
	CodeBlockToolbarPlugin,
	CodeHighlightPlugin,
	CodeLineNumbersPlugin,
	ColumnsPlugin,
	EditablePlugin,
	EditorHandlePlugin,
	EmbedPlugin,
	EmojiTypeaheadPlugin,
	EmptyParagraphHintPlugin,
	FindPlugin,
	InitialFocusPlugin,
	MarqueePlugin,
	MentionTypeaheadPlugin,
	SlashMenuPlugin,
	TableColumnResizePlugin,
	TablesPlugin,
	TitlePlugin,
	TogglePlugin,
	TransclusionTypeaheadPlugin,
	TurnIntoPlugin,
	createMapBlockAnchorStore,
} from "@brainstorm/editor";
import {
	useUniversalBody,
	useYDoc,
	useYDocApplyPending,
	useYDocLoaded,
} from "@brainstorm/react-yjs";
import { TRANSFORMERS } from "@lexical/markdown";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import type { LexicalEditor, SerializedEditorState } from "lexical";
import { type MutableRefObject, useMemo, useRef } from "react";
import { AddPropertyMenuPlugin } from "./add-property-menu-plugin";
import { BacklinksPlugin } from "./backlinks-plugin";
import { BookmarkSuggestPlugin } from "./bookmark-suggest-plugin";
import { BLOCK_ACTIONS, BLOCK_COMMANDS } from "./commands";
import { CommentHighlightPlugin } from "./comment-highlight-plugin";
import { BlockContextMenuPlugin } from "./context-menu-plugin";
import { DevBenchPlugin } from "./dev-bench-plugin";
import { EMOJI_SHORTCODE_TRANSFORMER } from "./emoji-transformer";
import { EntityDropPlugin } from "./entity-drop-plugin";
import { EQUATION_TRANSFORMER } from "./equation-transformer";
import { FormatChordsPlugin } from "./format-chords-plugin";
import { InlineToolbarPlugin } from "./inline-toolbar-plugin";
import { InsertAtEndPlugin, type InsertAtEndRequest } from "./insert-at-end-plugin";
import { LinkMarkupPlugin } from "./link-markup-plugin";
import { MediaDropPlugin } from "./media-drop-plugin";
import { MediaInspectorPlugin } from "./media-inspector-plugin";
import { NormalizeEmptyDocPlugin } from "./normalize-empty-plugin";
import { NoteContextProvider, type NoteContextValue } from "./note-context";
import { NOTES_ADDITIONAL_NODES } from "./notes-nodes";
import { localPresence } from "./presence";
import { makeNoteBootstrap } from "./seed-title";
import { editorTheme } from "./theme";
import { TOGGLE_HEADING_TRANSFORMER } from "./toggle-heading-transformer";
import { renderTransclusionBody } from "./transclusion-body";
import { TransclusionRenderProvider } from "./transclusion-render-context";
import { UNICODE_SHORTCUT_TRANSFORMERS } from "./typing-shortcuts";

export type EditorProps = {
	/** Stable id for the open document. Changing this prop remounts the
	 *  composer (via `key={noteId}` in the caller). */
	noteId: string;
	/** Title the sidebar currently shows. Forwarded to the bootstrap
	 *  seeder (see `seed-title.ts`) — the FIRST client to attach to an
	 *  empty Y.Doc seeds it into a TitleNode; subsequent opens see a
	 *  non-empty root and skip bootstrap (idempotent by construction). */
	storedTitle: string;
	/** Called whenever Lexical emits a debounced post-user-edit commit.
	 *  Carries the SerializedEditorState the caller uses to derive the
	 *  denormalised title + sidebar/local-search snippet — the body
	 *  itself persists through the Y.Doc resolver, not through this
	 *  callback. */
	onChange: (state: SerializedEditorState) => void;
	/** Current note's property values + write callback. Threaded through
	 *  `<NoteContextProvider>` so PropertyBlockNode / PropertyListBlockNode
	 *  decorators can read + write without prop drilling. */
	noteContext: Omit<NoteContextValue, "noteId">;
	/** Called when the editor rendered blank while the Y.Doc has content — the
	 *  host remounts (key bump) to re-bind through the resolver's revival path.
	 *  Capped host-side so an unhydratable doc can't loop. */
	onRecoverBlank?: () => void;
	/** Called when the doc hydrated cleanly — the host releases this note's
	 *  spent remount budget so a later session-race can recover again. */
	onRecoverReset?: () => void;
	/** Ref the host reads to serialise the live editor state on demand (the
	 *  header's Export… entries). Captured by `EditorHandlePlugin`. */
	editorHandleRef?: MutableRefObject<LexicalEditor | null>;
	/** Page-level lock (B11.11). When true the whole document is read-only;
	 *  toggled live (no remount) via `EditablePlugin`. */
	locked?: boolean;
	/** Pending inbound `#block-<id>` anchor (B11.13) — the editor scrolls
	 *  to + flashes the block once resolvable, then calls `onAnchorDone`
	 *  (also called on timeout, so the host always clears the request). */
	anchorReveal?: BlockAnchorReveal | null;
	onAnchorDone?: () => void;
	/** Pending validated `insert` intent (F-241 / doc 75) — appended at the
	 *  end of the document once the Y.Doc hydrates, then `onInsertDone`
	 *  fires (the host clears the request + refreshes the denormalised
	 *  snippet/refs). Only ever passed for the open, unlocked target note. */
	insertRequest?: InsertAtEndRequest | null;
	onInsertDone?: (applied: boolean) => void;
};

export function Editor({
	noteId,
	storedTitle,
	onChange,
	noteContext,
	onRecoverBlank,
	onRecoverReset,
	editorHandleRef,
	locked = false,
	anchorReveal = null,
	onAnchorDone,
	insertRequest = null,
	onInsertDone,
}: EditorProps) {
	const doc = useYDoc(noteId);
	const whenLoaded = useYDocLoaded(noteId);
	const applyPending = useYDocApplyPending(noteId);
	useUniversalBody(doc);
	// `<CollaborationPlugin initialEditorState>` lists the seeder in its
	// effect deps — passing a freshly-built closure on every render would
	// tear down + reconnect the provider mid-typing, since `storedTitle`
	// updates on every title autosave. The seeder only fires on the first
	// empty-doc attach, so the initial-mount `storedTitle` is the only
	// value that ever matters: a `useRef` captures it once for the life of
	// this component instance. The caller's `key={noteId}` remount discipline
	// gets us a fresh seeder per note switch.
	const bootstrapRef = useRef<((editor: LexicalEditor) => void) | null>(null);
	if (bootstrapRef.current === null) {
		bootstrapRef.current = makeNoteBootstrap(storedTitle);
	}
	// Root of the transclusion render chain (B6.4b): the open note. A
	// transclusion in this body decides against `[noteId]`, so a self-embed
	// or a body that transcludes back to the host collapses instead of
	// recursing. Provider sits ABOVE `<BrainstormEditor>` so it reaches the
	// decorator nodes (see `transclusion-render-context.tsx`).
	const ancestorChain = useMemo(() => [noteId], [noteId]);
	// Publish this client's presence (caret colour + label) into the doc's
	// awareness channel so a synced peer renders our remote cursor (B11.9).
	const presence = useMemo(() => localPresence(doc.clientID), [doc]);
	// Durable block anchors (B11.13) persist in a sibling Y.Map on the body
	// doc, so "Copy link to block" links sync with the note's content and
	// survive reload cross-device.
	const anchorStore = useMemo(
		() => createMapBlockAnchorStore(doc.getMap(BLOCK_ANCHORS_MAP_NAME)),
		[doc],
	);
	return (
		<TransclusionRenderProvider ancestorChain={ancestorChain} renderBody={renderTransclusionBody}>
			<BrainstormEditor
				doc={doc}
				docId={noteId}
				namespace="notes"
				theme={editorTheme}
				contentClassName="notes__contenteditable"
				additionalNodes={NOTES_ADDITIONAL_NODES}
				editable={!locked}
				presence={presence}
				initialEditorState={bootstrapRef.current}
				{...(whenLoaded ? { whenLoaded } : {})}
				{...(applyPending ? { applyPending } : {})}
				onError={(error) => {
					console.error("[notes/editor]", error);
				}}
			>
				{/* Forward the WHOLE context object — cherry-picking fields here is
				    what silently dropped the comment wiring (F-163): the app passed
				    onCommentSelection/commentedBlockIds/onCommentBlockClick and this
				    mount forwarded only values+setValue, so the toolbar Comment row,
				    the block highlight and the click-to-thread chip never reached a
				    real shell. */}
				<NoteContextProvider noteId={noteId} {...noteContext}>
					<BlockSelectionPlugin selectionPreservingSelector=".notes__media-inspector">
						<TitlePlugin />
						<EditablePlugin editable={!locked} />
						<NormalizeEmptyDocPlugin
							doc={doc}
							storedTitle={storedTitle}
							{...(whenLoaded ? { whenLoaded } : {})}
						/>
						{onRecoverBlank && (
							<BlankRecoveryPlugin
								doc={doc}
								onRecover={onRecoverBlank}
								{...(onRecoverReset ? { onHydrated: onRecoverReset } : {})}
								{...(whenLoaded ? { whenLoaded } : {})}
							/>
						)}
						<CheckListPlugin />
						<HorizontalRulePlugin />
						<MarkdownShortcutPlugin
							transformers={[
								...BLOCK_MARKDOWN_TRANSFORMERS,
								TOGGLE_HEADING_TRANSFORMER,
								...TRANSFORMERS,
								EQUATION_TRANSFORMER,
								EMOJI_SHORTCODE_TRANSFORMER,
								...UNICODE_SHORTCUT_TRANSFORMERS,
							]}
						/>
						<TabIndentationPlugin />
						<TurnIntoPlugin />
						<SlashMenuPlugin commands={BLOCK_COMMANDS} />
						<TablesPlugin />
						<TableColumnResizePlugin />
						<TogglePlugin docId={noteId} />
						<EmbedPlugin />
						<ColumnsPlugin />
						<MentionTypeaheadPlugin currentNoteId={noteId} />
						<TransclusionTypeaheadPlugin currentNoteId={noteId} />
						<BlockEmbedPickerPlugin currentNoteId={noteId} />
						<LinkMarkupPlugin currentNoteId={noteId} />
						<BlockGutterPlugin
							commands={BLOCK_ACTIONS}
							scrollContainerSelector=".notes__main"
							documentId={noteId}
						/>
						<BlockAnchorsPlugin
							store={anchorStore}
							reveal={anchorReveal}
							{...(onAnchorDone ? { onRevealDone: onAnchorDone } : {})}
						/>
						{onInsertDone && (
							<InsertAtEndPlugin
								request={insertRequest}
								{...(whenLoaded ? { whenLoaded } : {})}
								onDone={onInsertDone}
							/>
						)}
						<FindPlugin />
						<BlockContextMenuPlugin />
						<MarqueePlugin />
						<CodeBlockPlugin />
						<CodeBlockToolbarPlugin />
						<CodeHighlightPlugin />
						<CodeLineNumbersPlugin />
						<MediaDropPlugin />
						<BookmarkSuggestPlugin currentNoteId={noteId} />
						<EntityDropPlugin currentNoteId={noteId} />
						<MediaInspectorPlugin />
						<AddPropertyMenuPlugin />
						{editorHandleRef && <EditorHandlePlugin handleRef={editorHandleRef} />}
						<EmojiTypeaheadPlugin />
						<FormatChordsPlugin />
						<InlineToolbarPlugin />
						<CommentHighlightPlugin />
						<EmptyParagraphHintPlugin />
						<BacklinksPlugin currentNoteId={noteId} />
						<AutosavePlugin onChange={onChange} />
						<InitialFocusPlugin />
						{/* Unconditional mount — rationale in dev-bench-plugin.tsx header. */}
						<DevBenchPlugin noteId={noteId} />
					</BlockSelectionPlugin>
				</NoteContextProvider>
			</BrainstormEditor>
		</TransclusionRenderProvider>
	);
}
