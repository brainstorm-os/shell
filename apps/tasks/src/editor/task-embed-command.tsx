/**
 * The `/task` slash command for the Tasks inspector body editor — embeds a
 * live task inline (9.14.3). Mirrors Notes' `block.embed.entity` command
 * (9.4.1): it opens the anchored task picker against the host paragraph; the
 * chosen task becomes a `TaskEmbedNode` that mounts the app's own
 * `io.brainstorm.tasks/inline-task` BP block.
 *
 * Exposed as a single `extraCommands` entry the inspector passes to the
 * shared `<FullEditorPlugins>` — the editor package owns the slash-menu
 * chrome; the command catalogue stays app-local (per `block-command.ts`).
 */

import { type BlockCommand, CommandCategory, TodoListIcon } from "@brainstorm-os/editor";
import { $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";
import { t } from "../i18n/t";
import { taskEmbedPickerStore } from "./task-embed-picker-store";

function openTaskEmbedPicker(editor: LexicalEditor): void {
	let paragraphKey: string | null = null;
	editor.getEditorState().read(() => {
		const sel = $getSelection();
		if (!$isRangeSelection(sel)) return;
		try {
			paragraphKey = sel.anchor.getNode().getTopLevelElementOrThrow().getKey();
		} catch {
			paragraphKey = null;
		}
	});
	if (!paragraphKey) return;
	const el = editor.getElementByKey(paragraphKey);
	if (!el) return;
	const rect = el.getBoundingClientRect();
	taskEmbedPickerStore.open({
		paragraphKey,
		anchor: { top: rect.top, left: rect.left, bottom: rect.bottom },
	});
}

export function createTaskEmbedCommand(): BlockCommand {
	return {
		id: "tasks.embed.task",
		category: CommandCategory.Embed,
		label: t("tasks.embed.command.label"),
		description: t("tasks.embed.command.description"),
		icon: <TodoListIcon />,
		keywords: ["task", "embed", "inline", "todo", "reference", "card", "insert"],
		run: ({ editor }) => {
			openTaskEmbedPicker(editor);
		},
	};
}
