/**
 * Inline detail property block — a React island that renders the task's
 * first-class fields as the SHARED property cells (status / priority via the
 * vocabulary TagCell, scheduled / due via the DateCell, project via the
 * entity-ref Link cell, estimate / logged via the Duration Number cell, tags
 * via the multi TagCell), editable in place.
 *
 * This replaces the detail's hand-rolled chips / tags section / time inputs.
 * `apps/tasks` is a plain-DOM scaffold, so — like `inspector-editor-mount` —
 * this mounts ONE persistent `createRoot()` whose tree wraps the cells in a
 * single `<PropertiesProvider>` (one store, not one per field). The full
 * property list incl. custom props + comments still lives in the slide-over
 * inspector panel; this is the always-visible inline editor for the core
 * fields the chips used to show. Absent in preview (no properties service) —
 * the caller simply skips the block.
 */

import type { PropertiesService } from "@brainstorm/sdk-types";
import { PropertiesPanel } from "@brainstorm/sdk/properties-panel";
import { type EntityTitleSource, PropertiesProvider } from "@brainstorm/sdk/property-ui";
import { type Root, createRoot } from "react-dom/client";
import { t } from "../i18n/t";
import {
	TASK_PROP_KEY,
	type TaskFieldHandlers,
	bridgedTaskRows,
} from "../properties/task-properties";
import type { Task } from "../types/task";

/** The fields shown inline in the detail (the chips + tags + time the block
 *  replaces, plus status). Assignee / created / updated stay in the slide-over
 *  inspector to keep the inline block focused. */
const INLINE_FIELDS: ReadonlySet<string> = new Set([
	TASK_PROP_KEY.status,
	TASK_PROP_KEY.priority,
	TASK_PROP_KEY.scheduled,
	TASK_PROP_KEY.due,
	TASK_PROP_KEY.project,
	TASK_PROP_KEY.estimate,
	TASK_PROP_KEY.logged,
	TASK_PROP_KEY.tags,
]);

export type TaskDetailPropertiesHandle = {
	/** Re-render against the (possibly updated) task — cheap, React diffs. */
	update(task: Task): void;
	dispose(): void;
};

export type TaskDetailPropertiesDeps = {
	properties: PropertiesService;
	entityTitleSource: EntityTitleSource;
	/** Build the field persisters bound to a task id (the same factory the
	 *  slide-over inspector uses, so both edit through one code path). */
	makeHandlers: (taskId: string) => TaskFieldHandlers;
};

export function mountTaskDetailProperties(
	host: HTMLElement,
	task: Task,
	deps: TaskDetailPropertiesDeps,
): TaskDetailPropertiesHandle {
	const root: Root = createRoot(host);
	const render = (next: Task): void => {
		root.render(
			<PropertiesProvider
				runtime={{ services: { properties: deps.properties } }}
				entityTitleSource={deps.entityTitleSource}
			>
				<PropertiesPanel
					title={t("tasks.detail.properties")}
					rows={bridgedTaskRows(next, deps.makeHandlers(next.id), INLINE_FIELDS)}
					entityId={next.id}
					hideHeader
				/>
			</PropertiesProvider>,
		);
	};
	render(task);
	return {
		update: render,
		dispose: () => root.unmount(),
	};
}
