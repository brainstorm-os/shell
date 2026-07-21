/**
 * Tasks header object-menu contexts — the open-object menus the header ⋯
 * serves: the project surface's and the detail route's open task. Mirrors
 * Notes' `noteObjectMenuContext` so the cross-app contract (Open →
 * Pin/Unpin → Delete, same chrome) reads identically on the header title
 * as it does on a row.
 *
 * Unlike the sidebar/list rows (which go through the delegated container
 * binding), the header is a single stable element — `attachObjectMenuTrigger`
 * is the right primitive for it.
 */

import {
	type ObjectMenuChromeLabels,
	type ObjectMenuContext,
	type ObjectMenuExtraItem,
	type ObjectMenuRuntime,
	paintHeaderRight,
} from "@brainstorm-os/sdk/object-menu";
import { t } from "../i18n/t";
import { PROJECT_TYPE, TASK_TYPE } from "../storage/entities-repository";
import type { Project } from "../types/project";
import type { Task } from "../types/task";
import { createMoreButton } from "./delegated-object-menu";

function headerMenuLabels(): Partial<ObjectMenuChromeLabels> {
	return {
		open: t("tasks.menu.open"),
		pin: t("tasks.menu.pin"),
		unpin: t("tasks.menu.unpin"),
		remove: t("tasks.menu.remove"),
		moreActions: t("tasks.menu.more"),
	};
}

export type ProjectHeaderMenuInput = {
	project: Project;
	runtime: ObjectMenuRuntime;
	onRemove?: () => void | Promise<void>;
	/** App-supplied rows (e.g. the IE-8 "Export…" affordance) spliced before Remove. */
	extraItems?: ObjectMenuExtraItem[];
};

export function projectHeaderMenuContext({
	project,
	runtime,
	onRemove,
	extraItems,
}: ProjectHeaderMenuInput): ObjectMenuContext {
	if (!runtime) return null;
	return {
		target: { entityId: project.id, entityType: PROJECT_TYPE, label: project.name },
		runtime,
		labels: headerMenuLabels(),
		// The header ⋯ acts on the project this surface is ALREADY showing, so
		// "Open" would re-open the current view (a visible no-op) — drop it.
		omitOpen: true,
		...(extraItems && extraItems.length > 0 ? { extraItems } : {}),
		...(onRemove ? { onRemove } : {}),
	};
}

export type TaskHeaderMenuInput = {
	task: Task;
	runtime: ObjectMenuRuntime;
	onRemove?: () => void | Promise<void>;
	/** App-supplied rows (e.g. the IE-8 "Export…" affordance) spliced before Remove. */
	extraItems?: ObjectMenuExtraItem[];
};

/** Paint the header right group in the canonical cross-app order —
 *  content actions and panel toggles first, the object ⋯ LAST and never
 *  absent: surfaces with no object (built-in lists, no runtime) get a
 *  disabled ⋯ instead of a missing one. */
export function paintTasksHeaderRight(
	container: HTMLElement,
	children: ReadonlyArray<HTMLElement | null | undefined>,
	more: HTMLButtonElement | null,
): void {
	paintHeaderRight(container, children, more ?? createMoreButton({ disabled: true }));
}

/** The detail route's header menu — the open task IS the header object. */
export function taskHeaderMenuContext({
	task,
	runtime,
	onRemove,
	extraItems,
}: TaskHeaderMenuInput): ObjectMenuContext {
	if (!runtime) return null;
	return {
		target: { entityId: task.id, entityType: TASK_TYPE, label: task.name },
		runtime,
		labels: headerMenuLabels(),
		// The detail route's header ⋯ IS the open task — drop the no-op "Open".
		omitOpen: true,
		...(extraItems && extraItems.length > 0 ? { extraItems } : {}),
		...(onRemove ? { onRemove } : {}),
	};
}
