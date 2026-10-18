/**
 * The explicit completion picks (9.14.17) — the menu twins of the three-state
 * checkbox, so a user who doesn't want to click through the cycle can jump
 * straight to a state. The row for the CURRENT state is left out; every row
 * declares `writes`, so the shared object-menu builder disables them on a
 * locked task.
 */

import { IconName } from "@brainstorm-os/sdk/icon";
import type { ObjectMenuExtraItem } from "@brainstorm-os/sdk/object-menu";
import { type TranslationKey, t } from "../i18n/t";
import { CompletionState, completionStateOf } from "../logic/task-status";
import type { Task } from "../types/task";

const COMPLETION_ROWS: ReadonlyArray<{
	state: CompletionState;
	id: string;
	labelKey: TranslationKey;
	icon: IconName;
}> = [
	{
		state: CompletionState.Done,
		id: "mark-done",
		labelKey: "tasks.menu.markDone",
		icon: IconName.CheckCircle,
	},
	{
		state: CompletionState.WontDo,
		id: "mark-wont-do",
		labelKey: "tasks.menu.markWontDo",
		icon: IconName.Close,
	},
	{
		state: CompletionState.Open,
		id: "reopen",
		labelKey: "tasks.menu.reopen",
		icon: IconName.Reload,
	},
];

export function completionMenuItems(
	task: Task,
	setCompletion: (task: Task, state: CompletionState) => void,
): ObjectMenuExtraItem[] {
	const current = completionStateOf(task);
	return COMPLETION_ROWS.filter((row) => row.state !== current).map((row) => ({
		id: row.id,
		label: t(row.labelKey),
		icon: row.icon,
		writes: true,
		run: () => setCompletion(task, row.state),
	}));
}
