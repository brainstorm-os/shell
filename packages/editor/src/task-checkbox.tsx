/**
 * The live done checkbox inside a task mention chip (B11.24). Reads the task's
 * done state from the shared entity index, writes completion through the
 * host's entities service, and stays disabled for a locked task, a read-only
 * editor, an unwired host, or an id that does not resolve to a Task. A
 * won't-do task reads closed (indeterminate); clicking it reopens. Optimistic until the snapshot catches up.
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
	getEntityType,
	subscribeEntityIcons,
} from "./plugins/entity-index";
import {
	TASK_CHECK_ATTR,
	TASK_ENTITY_TYPE,
	isTaskClosed,
	isTaskWontDo,
	taskCompletionPatch,
} from "./task-entity";

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
	// The chip's stored type is whatever a paste or a peer wrote, so the write
	// is gated on the entity the id ACTUALLY resolves to being a Task —
	// otherwise a forged chip would stamp task fields onto any object.
	const isRealTask = getEntityType(entityId) === TASK_ENTITY_TYPE;
	const properties = isRealTask ? getEntityProperties(entityId) : undefined;
	const liveClosed = isTaskClosed(properties);
	const wontDo = isTaskWontDo(properties);
	const [pending, setPending] = useState<boolean | null>(null);
	useEffect(() => {
		if (pending !== null && pending === liveClosed) setPending(null);
	}, [pending, liveClosed]);
	const closed = pending ?? liveClosed;
	const done = closed && !(pending === null && wontDo);
	const editable = useEditorEditable();
	const entities = getEditorHost().entities;
	const disabled = !isRealTask || !editable || !entities || isLockedProperties(properties);
	const ariaKey = !closed
		? "editor.task.markDone"
		: done
			? "editor.task.markOpen"
			: "editor.task.reopenWontDo";
	return (
		<span
			className="bs-editor__task-check"
			{...{ [TASK_CHECK_ATTR]: "" }}
			onMouseDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
		>
			<Checkbox
				checked={done}
				indeterminate={closed && !done}
				disabled={disabled}
				ariaLabel={t(ariaKey, { name: label })}
				onChange={() => {
					if (!entities || !isRealTask) return;
					const next = !closed;
					setPending(next);
					const patch = taskCompletionPatch(next, Date.now(), properties?.statusKey);
					void entities.update(entityId, patch).catch((error) => {
						console.warn("[editor/task] completion write failed:", error);
						setPending(null);
					});
				}}
			/>
		</span>
	);
}
