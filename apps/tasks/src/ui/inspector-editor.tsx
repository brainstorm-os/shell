/**
 * TaskInspectorEditor — the React island mounted inside the Tasks
 * inspector's plain-DOM body slot (9.14.6). The rest of the Tasks app
 * stays imperative DOM; only the task body needs the Lexical stack, so
 * (like Journal's day-body editor) we mount a single React root whose
 * tree wraps `<BrainstormEditor>` in the shell-installed
 * `<YDocProvider>`.
 *
 * The body lives in the task's per-entity Y.Doc (resolved through
 * `useYDoc(taskId)`), persisted via the same `services.entities.applyDoc`
 * transport Notes + Journal use — so a task's notes are real rich text
 * (paragraphs, sub-checklists, links, code) rather than a flat string.
 *
 * First-open seeding: a task created before the inspector existed
 * carries its content in `seedNotes` (the legacy `notes` string). When
 * present we pass an `initialEditorState` initialiser to
 * `<BrainstormEditor>`; `CollaborationPlugin` calls it exactly once —
 * when its sync settles on an empty doc — so the plant is automatic,
 * deterministic, and idempotent across opens. `onFirstEdit` fires the
 * first time the user actually edits, letting the app clear the legacy
 * `notes` field so the body becomes the single source of truth.
 */

import {
	AutosavePlugin,
	BrainstormEditor,
	FULL_EDITOR_NODES,
	FullEditorPlugins,
	richTextTheme,
} from "@brainstorm-os/editor";
import {
	useUniversalBody,
	useYDoc,
	useYDocApplyPending,
	useYDocLoaded,
} from "@brainstorm-os/react-yjs";
import { $getRoot, type LexicalEditor, type SerializedEditorState } from "lexical";
import { useMemo } from "react";
import { createTaskEmbedCommand } from "../editor/task-embed-command";
import { TaskEmbedNode } from "../editor/task-embed-node";
import { TaskEmbedPickerPlugin } from "../editor/task-embed-picker-plugin";
import { notesStringToSerializedState } from "../logic/seed-body";

/** The shared full-editor node set plus the app-local `TaskEmbedNode` the
 *  `/task` slash command inserts (9.14.3). Frozen at module scope so
 *  `<BrainstormEditor>` gets a stable `additionalNodes` reference. */
const EDITOR_NODES = [...FULL_EDITOR_NODES, TaskEmbedNode];

export type TaskInspectorEditorProps = {
	/** The task's stable entity id — resolved through the shell-installed
	 *  YDocResolver. */
	taskId: string;
	/** Legacy `notes` string to seed the body from on first open. Empty /
	 *  undefined when the task has no legacy notes (or was already
	 *  migrated). */
	seedNotes?: string;
	/** Fires the first time the body changes from a real user edit (the
	 *  AutosavePlugin only calls back after genuine interaction). The app
	 *  uses this to clear the legacy `notes` string once.
	 *
	 *  Per the shared editor save contract (`@brainstorm-os/editor`'s
	 *  `denormalizeBody`), the rich body persists via the Y.Doc resolver;
	 *  Tasks deliberately does NOT denormalise a `title`/`body` snippet —
	 *  a task's title and status are first-class properties edited
	 *  elsewhere, and the body is the free-form "notes" field with no list
	 *  row / preview that reads back a snippet. The gated AutosavePlugin is
	 *  still the right primitive (no mount-settle write); we only use its
	 *  interaction signal, not its payload. */
	onFirstEdit?(): void;
	/** When `false`, the task is locked (read-only) — the body editor rejects
	 *  edits. Defaults to editable. */
	editable?: boolean;
};

export function TaskInspectorEditor({
	taskId,
	seedNotes,
	onFirstEdit,
	editable,
}: TaskInspectorEditorProps) {
	const doc = useYDoc(taskId);
	const whenLoaded = useYDocLoaded(taskId);
	const applyPending = useYDocApplyPending(taskId);
	useUniversalBody(doc);

	// Build the seed initialiser once per seedNotes value (the component is
	// keyed by taskId, so a task switch remounts and recomputes anyway).
	// The callback no-ops against a non-empty doc, so re-opening a task
	// whose body already has content never re-plants the legacy string.
	const initialEditorState = useMemo(() => {
		const text = seedNotes?.trim();
		if (!text) return undefined;
		const state = notesStringToSerializedState(seedNotes ?? "");
		return (editor: LexicalEditor) => {
			const root = $getRoot();
			if (!root.isEmpty()) return;
			try {
				editor.setEditorState(editor.parseEditorState(state));
			} catch (error) {
				console.warn("[tasks/inspector-editor] seed plant failed:", error);
			}
		};
	}, [seedNotes]);

	const onChange = useMemo(() => {
		if (!onFirstEdit) return undefined;
		return (_state: SerializedEditorState) => onFirstEdit();
	}, [onFirstEdit]);

	// `/task` slash command — embeds a live task inline (9.14.3). Rebuilt only
	// when the command's labels would change (i.e. never within a session, so
	// once); `createTaskEmbedCommand` reads `t()` at call time.
	const extraCommands = useMemo(() => [createTaskEmbedCommand()], []);

	return (
		<BrainstormEditor
			doc={doc}
			docId={taskId}
			editable={editable ?? true}
			namespace="tasks"
			theme={richTextTheme}
			contentClassName="notes__contenteditable tasks-detail__editor"
			additionalNodes={EDITOR_NODES}
			{...(initialEditorState ? { initialEditorState } : {})}
			{...(whenLoaded ? { whenLoaded } : {})}
			{...(applyPending ? { applyPending } : {})}
			onError={(error) => {
				console.error("[tasks/inspector-editor]", error);
			}}
		>
			<FullEditorPlugins
				docId={taskId}
				currentEntityId={taskId}
				scrollContainerSelector=".tasks-detail__editor"
				extraCommands={extraCommands}
			>
				<TaskEmbedPickerPlugin currentTaskId={taskId} />
				{onChange ? <AutosavePlugin onChange={onChange} /> : null}
			</FullEditorPlugins>
		</BrainstormEditor>
	);
}
