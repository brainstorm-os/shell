/**
 * Nested transclusion body (B6.4b render-half, B11.22 edit-in-place).
 *
 * Mounts a real `<BrainstormEditor>` bound to the target entity's replica
 * Y.Doc (resolved through `useYDoc(entityId)`), so the transcluded content
 * paints with full fidelity — mentions, embeds, images, tables and *nested*
 * transclusions all render through the same node set the primary editor uses
 * (the cycle/depth guard bounds the recursion).
 *
 * Read-only by default. "Edit here" switches the body into an explicit edit
 * mode: the nested editor becomes editable and mounts the Notes editing
 * plugins, so every keystroke writes straight into the SOURCE's Y.Doc (the
 * same doc the source's own editor binds), with a visible boundary + the
 * source card as its chip. The nested editor carries its own block gutter,
 * block selection (with its keyboard chords) and block context menu, scoped
 * to the source's blocks: the host gutter yields inside the editing body
 * (`gutterOwnsPointer`) and host chords skip keystrokes from it. Guarantees:
 *   - a locked source, a source Notes hasn't loaded, or a read-only host keeps
 *     the body read-only (the toggle is disabled with a hint, never hidden);
 *     a lock that lands mid-edit drops the body back to read-only live;
 *   - undo is the SOURCE's: the nested `CollaborationPlugin` owns its own
 *     Yjs `UndoManager` over the source doc, and Lexical marks a nested
 *     editor's key events handled so the host never also undoes;
 *   - editing a source from within itself can't happen: such a body is
 *     cycle-elided before it mounts (`decideTransclusionRender`);
 *   - the source's denormalised title / snippet / refs follow the edit
 *     through the host's `onSourceChange` (the open note's autosave path).
 *
 * `renderTransclusionBody` is injected into `TransclusionRenderContext` by the
 * primary editor and re-injected here, so a `TransclusionNode` inside the
 * mounted body resolves the SAME renderer — without `transclusion-node.tsx`
 * importing this heavy module (which would cycle through
 * `NOTES_ADDITIONAL_NODES`).
 */

import {
	AutosavePlugin,
	BLOCK_MARKDOWN_TRANSFORMERS,
	BlockEmbedPickerPlugin,
	BlockGutterPlugin,
	BlockSelectionPlugin,
	BrainstormEditor,
	CodeBlockPlugin,
	ColumnsPlugin,
	EditablePlugin,
	EmbedPlugin,
	InlineToolbarPlugin,
	ListMarkdownShortcutsPlugin,
	MentionTypeaheadPlugin,
	SlashMenuPlugin,
	TablesPlugin,
	TitlePlugin,
	TogglePlugin,
	TransclusionTypeaheadPlugin,
	TurnIntoPlugin,
	useTransclusionRender,
} from "@brainstorm-os/editor";
import {
	useUniversalBody,
	useYDoc,
	useYDocApplyPending,
	useYDocLoaded,
} from "@brainstorm-os/react-yjs";
import { TRANSFORMERS } from "@lexical/markdown";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import type { SerializedEditorState } from "lexical";
import { useCallback, useMemo, useState } from "react";
import { t } from "../i18n/t";
import { BLOCK_ACTIONS, BLOCK_COMMANDS } from "./commands";
import { BlockContextMenuPlugin } from "./context-menu-plugin";
import { LinkMarkupPlugin } from "./link-markup-plugin";
import { NOTES_ADDITIONAL_NODES } from "./notes-nodes";
import { editorTheme } from "./theme";
import { useTransclusionEditHost } from "./transclusion-edit-host";
import {
	type TransclusionBodyRenderer,
	TransclusionRenderProvider,
} from "./transclusion-render-context";

const EDIT_TRANSFORMERS = [...BLOCK_MARKDOWN_TRANSFORMERS, ...TRANSFORMERS];

export enum TransclusionEditState {
	/** Host read-only or the source isn't held by Notes — no toggle at all. */
	Unavailable = "unavailable",
	/** Editable in principle, but the source is locked. */
	Locked = "locked",
	ReadOnly = "read-only",
	Editing = "editing",
}

/** Pure decision for the body's edit state (unit-tested). */
export function resolveTransclusionEditState(args: {
	hostEditable: boolean;
	canEdit: boolean;
	locked: boolean;
	requested: boolean;
}): TransclusionEditState {
	if (!args.hostEditable || !args.canEdit) return TransclusionEditState.Unavailable;
	if (args.locked) return TransclusionEditState.Locked;
	return args.requested ? TransclusionEditState.Editing : TransclusionEditState.ReadOnly;
}

function TransclusionEditingPlugins({
	entityId,
	onChange,
}: {
	entityId: string;
	onChange: (state: SerializedEditorState) => void;
}) {
	return (
		<BlockSelectionPlugin>
			<TitlePlugin />
			<CheckListPlugin />
			<HorizontalRulePlugin />
			<MarkdownShortcutPlugin transformers={EDIT_TRANSFORMERS} />
			<ListMarkdownShortcutsPlugin />
			<TabIndentationPlugin />
			<TurnIntoPlugin />
			<SlashMenuPlugin commands={BLOCK_COMMANDS} />
			<TablesPlugin />
			<TogglePlugin docId={entityId} />
			<EmbedPlugin />
			<ColumnsPlugin />
			<CodeBlockPlugin />
			<MentionTypeaheadPlugin currentNoteId={entityId} />
			<TransclusionTypeaheadPlugin currentNoteId={entityId} />
			<BlockEmbedPickerPlugin currentNoteId={entityId} />
			<LinkMarkupPlugin currentNoteId={entityId} />
			<BlockGutterPlugin
				commands={BLOCK_ACTIONS}
				insertCommands={BLOCK_COMMANDS}
				scrollContainerSelector=".notes__main"
				documentId={entityId}
			/>
			<BlockContextMenuPlugin documentId={entityId} />
			<InlineToolbarPlugin />
			<AutosavePlugin onChange={onChange} />
		</BlockSelectionPlugin>
	);
}

function TransclusionBodyMount({
	entityId,
	chain,
}: {
	entityId: string;
	chain: readonly string[];
}) {
	const doc = useYDoc(entityId);
	const whenLoaded = useYDocLoaded(entityId);
	const applyPending = useYDocApplyPending(entityId);
	useUniversalBody(doc);
	const { editable: hostEditable = false } = useTransclusionRender();
	const host = useTransclusionEditHost();
	const [requested, setRequested] = useState(false);
	const state = resolveTransclusionEditState({
		hostEditable,
		canEdit: host?.canEdit(entityId) ?? false,
		locked: host?.isLocked(entityId) ?? false,
		requested,
	});
	const editing = state === TransclusionEditState.Editing;
	const nestedChain = useMemo(() => [...chain, entityId], [chain, entityId]);
	const onSourceChange = useCallback(
		(next: SerializedEditorState) => host?.onSourceChange(entityId, next),
		[host, entityId],
	);
	const toggleLabel = editing
		? t("notes.transclusion.doneEditing")
		: t("notes.transclusion.editHere");
	const toggleHint =
		state === TransclusionEditState.Locked
			? t("notes.transclusion.lockedHint")
			: editing
				? t("notes.transclusion.doneHint")
				: t("notes.transclusion.editHint");
	return (
		<div
			className={
				editing
					? "notes__transclusion-edit notes__transclusion-edit--active"
					: "notes__transclusion-edit"
			}
			data-edit-state={state}
		>
			{state !== TransclusionEditState.Unavailable && (
				<div className="notes__transclusion-edit-bar">
					{editing && (
						<span className="notes__transclusion-edit-badge">{t("notes.transclusion.editingBadge")}</span>
					)}
					<button
						type="button"
						className="bs-btn notes__transclusion-edit-toggle"
						aria-pressed={editing}
						disabled={state === TransclusionEditState.Locked}
						title={toggleHint}
						aria-label={toggleHint}
						onClick={() => setRequested((on) => !on)}
					>
						{toggleLabel}
					</button>
				</div>
			)}
			<TransclusionRenderProvider
				ancestorChain={nestedChain}
				renderBody={renderTransclusionBody}
				editable={editing}
			>
				<BrainstormEditor
					doc={doc}
					docId={entityId}
					namespace="notes"
					theme={editorTheme}
					contentClassName="notes__transclusion-body-content"
					additionalNodes={NOTES_ADDITIONAL_NODES}
					editable={editing}
					{...(whenLoaded ? { whenLoaded } : {})}
					{...(applyPending ? { applyPending } : {})}
					onError={(error) => {
						console.error("[notes/transclusion-body]", error);
					}}
				>
					<EditablePlugin editable={editing} />
					{editing && <TransclusionEditingPlugins entityId={entityId} onChange={onSourceChange} />}
				</BrainstormEditor>
			</TransclusionRenderProvider>
		</div>
	);
}

/** Stable module-level renderer wired into `TransclusionRenderContext`. Keyed
 *  by `entityId` so switching the transcluded target rebinds `@lexical/yjs`
 *  cleanly (the `key={noteId}` discipline the primary editor uses on note
 *  switch). */
export const renderTransclusionBody: TransclusionBodyRenderer = ({ entityId, chain }) => (
	<TransclusionBodyMount key={entityId} entityId={entityId} chain={chain} />
);
