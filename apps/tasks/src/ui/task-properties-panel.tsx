/**
 * Task properties inspector — the shared `<EntityPropertiesPanel>` hosting
 * BOTH halves of the Tasks hybrid (Props-3):
 *
 *   - the bridged typed rows (status / priority / schedule / project /
 *     assignee / estimate / logged / tags / timestamps, see
 *     `task-properties.ts`) ride in as `extraRows` — same grid, host-owned
 *     per-field persisters, so a locked task (no handlers) freezes each row;
 *   - the task's real `task.values` bag renders as the panel's own editable
 *     rows, with remove + the shared rich add-property picker (search the
 *     vault catalog / create-new inline) replacing the old flat
 *     `openAnchoredMenu` list.
 *
 * `assigneeId` is excluded from the picker: it is the F-152 catalog def the
 * bridged Assignee row already edits — binding it into `values` would create
 * a second, divergent "Assignee" the chip / group-by / Graph edge ignore.
 */

import { EntityCommentsPanel } from "@brainstorm-os/editor";
import { EntityPropertiesPanel } from "@brainstorm-os/sdk/property-ui";
import type { ValuesMap } from "@brainstorm-os/sdk/property-ui";
import { t } from "../i18n/t";
import {
	ASSIGNEE_CATALOG_DEF,
	type TaskFieldHandlers,
	bridgedTaskRows,
} from "../properties/task-properties";
import { getBrainstorm } from "../storage/runtime";
import type { Task } from "../types/task";

/** Catalog keys shadowed by a bridged row — never offered by the picker. */
const PICKER_EXCLUDE_KEYS: ReadonlySet<string> = new Set([ASSIGNEE_CATALOG_DEF.key]);

export type TaskPropertiesPanelProps = {
	task: Task;
	open: boolean;
	onClose: () => void;
	/** Persists the task's custom vault-property bag (9.14.16). Absent
	 *  (preview / no repository / locked task) → custom rows render
	 *  read-only and the add-property affordance hides. */
	onValuesChange?: (next: ValuesMap) => void;
} & TaskFieldHandlers;

export function TaskPropertiesPanel({
	task,
	open,
	onClose,
	onValuesChange,
	...handlers
}: TaskPropertiesPanelProps): React.ReactElement {
	const services = getBrainstorm()?.services ?? null;
	return (
		<aside
			className={open ? "bs-props bs-props--open glass--strong" : "bs-props glass--strong"}
			aria-label={t("tasks.detail.properties")}
			aria-hidden={!open}
			{...(open ? {} : { inert: true })}
		>
			<EntityCommentsPanel
				services={services}
				documentId={task.id}
				properties={({ tabbed }) => (
					<EntityPropertiesPanel
						title={t("tasks.detail.properties")}
						entityId={task.id}
						values={task.values ?? {}}
						canMutate={Boolean(onValuesChange)}
						onWriteValues={(next) => onValuesChange?.(next)}
						addLabel={t("tasks.props.add")}
						removeLabel={(name) => t("tasks.props.remove", { name })}
						extraRows={bridgedTaskRows(task, handlers)}
						pickerExcludeKeys={PICKER_EXCLUDE_KEYS}
						{...(tabbed
							? { hideHeader: true }
							: { onClose, closeLabel: t("tasks.header.inspector.hide") })}
					/>
				)}
			/>
		</aside>
	);
}
