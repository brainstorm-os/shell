/**
 * The live done checkbox inside a task mention chip (B11.24). Reads the task's
 * done state from the shared entity index, writes completion through the
 * host's entities service, and stays disabled for a locked task, a read-only
 * editor, or an unwired host. Optimistic until the snapshot catches up.
 */

import { Checkbox } from "@brainstorm-os/sdk/checkbox";
import { isLockedProperties } from "@brainstorm-os/sdk/entity-lock";
import { LexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { useEditorT } from "./i18n";
import { getEditorHost } from "./plugins/editor-host";
import {
	entityIconsSnapshot,
	getEntityProperties,
	subscribeEntityIcons,
} from "./plugins/entity-index";
import { TASK_CHECK_ATTR, isTaskDone, taskCompletionPatch } from "./task-entity";

function useEditorEditable(): boolean {
	const composer = useContext(LexicalComposerContext);
	const editor = composer?.[0] ?? null;
	const [editable, setEditable] = useState(() => editor?.isEditable() ?? false);
	useEffect(() => {
		if (!editor) return;
		setEditable(editor.isEditable());
		return editor.registerEditableListener(setEditable);
	}, [editor]);
	return editable;
}

/** The live done checkbox inside a task mention chip. */
export function TaskCheckbox({ entityId, label }: { entityId: string; label: string }) {
	const t = useEditorT();
	useSyncExternalStore(subscribeEntityIcons, entityIconsSnapshot);
	const properties = getEntityProperties(entityId);
	const liveDone = isTaskDone(properties);
	const [pending, setPending] = useState<boolean | null>(null);
	useEffect(() => {
		if (pending !== null && pending === liveDone) setPending(null);
	}, [pending, liveDone]);
	const done = pending ?? liveDone;
	const editable = useEditorEditable();
	const entities = getEditorHost().entities;
	const disabled = !editable || !entities || isLockedProperties(properties);
	return (
		<span
			className="bs-editor__task-check"
			{...{ [TASK_CHECK_ATTR]: "" }}
			onMouseDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
		>
			<Checkbox
				checked={done}
				disabled={disabled}
				ariaLabel={t(done ? "editor.task.markOpen" : "editor.task.markDone", { name: label })}
				onChange={(next) => {
					if (!entities) return;
					setPending(next);
					void entities.update(entityId, taskCompletionPatch(next)).catch((error) => {
						console.warn("[editor/task] completion write failed:", error);
						setPending(null);
					});
				}}
			/>
		</span>
	);
}
