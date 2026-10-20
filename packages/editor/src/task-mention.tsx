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
	$createRangeSelection,
	$createTextNode,
	$getNodeByKey,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	$setSelection,
	type LexicalEditor,
	type NodeKey,
	type RangeSelection,
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

/** Where `/task` was typed — the collapsed caret captured before the picker
 *  takes focus, restored on Enter so the chip lands exactly there (inside the
 *  list item, mid-paragraph), not at the end of the top-level block. */
export type TaskCaret = { key: NodeKey; offset: number; type: "text" | "element" };

function $restoreCaret(caret: TaskCaret | null): RangeSelection | null {
	if (caret) {
		const node = $getNodeByKey(caret.key);
		const size =
			caret.type === "text"
				? $isTextNode(node)
					? node.getTextContentSize()
					: null
				: $isElementNode(node)
					? node.getChildrenSize()
					: null;
		if (size !== null) {
			const offset = Math.min(caret.offset, size);
			const selection = $createRangeSelection();
			selection.anchor.set(caret.key, offset, caret.type);
			selection.focus.set(caret.key, offset, caret.type);
			$setSelection(selection);
			return selection;
		}
	}
	const current = $getSelection();
	return $isRangeSelection(current) ? current : null;
}

/** Insert a task mention at `caret` (or the live selection when the caret is
 *  gone), then persist the task. A failed create removes the chip so the note
 *  never links to a task that doesn't exist. Returns the new task id, or
 *  `null` when nothing was inserted (no host, no caret, empty name). */
export function insertTaskMention(
	editor: LexicalEditor,
	rawName: string,
	caret: TaskCaret | null,
): string | null {
	const name = rawName.trim().slice(0, TASK_NAME_MAX);
	const entities = getEditorHost().entities;
	if (!entities || name.length === 0) return null;
	const id = newTaskId();
	let chipKey: NodeKey | null = null;
	editor.update(
		() => {
			const selection = $restoreCaret(caret);
			if (!selection) return;
			const chip = $createMentionNode(id, TASK_ENTITY_TYPE, name);
			const trailing = $createTextNode(" ");
			selection.insertNodes([chip, trailing]);
			trailing.select(1, 1);
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

function captureCaret(editor: LexicalEditor): { caret: TaskCaret; rect: DOMRect | null } | null {
	let caret: TaskCaret | null = null;
	let blockKey: NodeKey | null = null;
	editor.getEditorState().read(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const { anchor } = selection;
		caret = { key: anchor.key, offset: anchor.offset, type: anchor.type };
		const block = anchor.getNode();
		blockKey = ($isElementNode(block) ? block : block.getParent())?.getKey() ?? null;
	});
	if (caret === null) return null;
	const rect = blockKey ? (editor.getElementByKey(blockKey)?.getBoundingClientRect() ?? null) : null;
	return { caret, rect };
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
			const target = captureCaret(editor);
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
						insertTaskMention(editor, name, target?.caret ?? null);
						editor.getRootElement()?.focus({ preventScroll: true });
					}, 0);
				},
				...(target?.rect ? { rect: target.rect } : {}),
			});
		},
	};
}
