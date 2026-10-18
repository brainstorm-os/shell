/**
 * Inline tasks (B11.24). `/task` asks for a name, creates a real
 * `brainstorm/Task/v1` entity (client-minted id, so the chip lands in the same
 * update as the command) and drops an `@`-mention of it at the caret. A task
 * is therefore just a mention — the persisted `mention` node the shared
 * reference walker already reads — so the note → task edge (the task's
 * backlink to this note), Graph edges, copy/paste and Markdown export all
 * come for free, and every `@`-mention of a task anywhere gets the same live
 * checkbox.
 *
 * The chip's live checkbox is `task-checkbox.tsx`.
 */

import { type SearchPickerItem, openSearchPicker } from "@brainstorm-os/sdk/menus";
import {
	$createTextNode,
	$getNodeByKey,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	type LexicalEditor,
	type NodeKey,
} from "lexical";
import { type BlockCommand, CommandCategory } from "./block-command";
import type { EditorT } from "./i18n";
import { TaskIcon } from "./icons";
import { $createMentionNode } from "./nodes/mention-node";
import { getEditorHost } from "./plugins/editor-host";
import { TASK_ENTITY_TYPE, newTaskProperties } from "./task-entity";

const TASK_NAME_MAX = 500;
const CREATE_ROW_ID = "task:create";
const EMPTY_ROW_ID = "task:empty";

export function newTaskId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `task-${crypto.randomUUID()}`;
	}
	return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Insert a task mention into `blockKey` (or at the caret), then persist the
 *  task. A failed create removes the chip so the note never links to a task
 *  that doesn't exist. Returns the new task id, or `null` when nothing was
 *  inserted (no host, no target block, empty name). */
export function insertTaskMention(
	editor: LexicalEditor,
	rawName: string,
	blockKey: NodeKey | null,
): string | null {
	const name = rawName.trim().slice(0, TASK_NAME_MAX);
	const entities = getEditorHost().entities;
	if (!entities || name.length === 0) return null;
	const id = newTaskId();
	let chipKey: NodeKey | null = null;
	editor.update(
		() => {
			const chip = $createMentionNode(id, TASK_ENTITY_TYPE, name);
			const block = blockKey ? $getNodeByKey(blockKey) : null;
			if ($isElementNode(block)) {
				const trailing = $createTextNode(" ");
				block.append(chip, trailing);
				trailing.select(1, 1);
			} else {
				const selection = $getSelection();
				if (!$isRangeSelection(selection)) return;
				selection.insertNodes([chip, $createTextNode(" ")]);
			}
			chipKey = chip.getKey();
		},
		{ discrete: true },
	);
	if (chipKey === null) return null;
	const insertedKey: NodeKey = chipKey;
	void entities.create(TASK_ENTITY_TYPE, newTaskProperties(name), id).catch((error) => {
		console.warn("[editor/task] task create failed:", error);
		editor.update(() => {
			$getNodeByKey(insertedKey)?.remove();
		});
	});
	return id;
}

export function taskPickerRows(t: EditorT, query: string): readonly SearchPickerItem[] {
	const name = query.trim();
	if (name.length === 0)
		return [{ id: EMPTY_ROW_ID, label: t("editor.task.picker.empty"), disabled: true }];
	return [
		{
			id: CREATE_ROW_ID,
			label: t("editor.task.picker.create", { name }),
			icon: <TaskIcon />,
		},
	];
}

function caretBlock(editor: LexicalEditor): { key: NodeKey; rect: DOMRect | null } | null {
	let key: NodeKey | null = null;
	editor.getEditorState().read(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		try {
			key = selection.anchor.getNode().getTopLevelElementOrThrow().getKey();
		} catch {
			key = null;
		}
	});
	if (key === null) return null;
	return { key, rect: editor.getElementByKey(key)?.getBoundingClientRect() ?? null };
}

/** `/task`: name the task in the shared search picker, Enter creates it. */
export function createTaskCommand(t: EditorT): BlockCommand {
	return {
		id: "block.task",
		category: CommandCategory.Lists,
		label: t("editor.block.task"),
		description: t("editor.block.task.description"),
		icon: <TaskIcon />,
		keywords: ["task", "todo", "to-do", "action", "assign", "checkbox"],
		run: ({ editor }) => {
			if (!getEditorHost().entities) {
				console.info("[editor/task] no entities host wired — /task needs entities.create.");
				return;
			}
			const target = caretBlock(editor);
			let query = "";
			openSearchPicker({
				placeholder: t("editor.task.picker.placeholder"),
				ariaLabel: t("editor.task.picker.region"),
				filter: (next) => {
					query = next;
					return taskPickerRows(t, next);
				},
				onSelect: (id) => {
					if (id !== CREATE_ROW_ID) return;
					const name = query;
					setTimeout(() => {
						insertTaskMention(editor, name, target?.key ?? null);
						editor.getRootElement()?.focus({ preventScroll: true });
					}, 0);
				},
				...(target?.rect ? { rect: target.rect } : {}),
			});
		},
	};
}
