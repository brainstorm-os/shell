/**
 * Task properties bridge (interim, pre-property-backed entity). A task's
 * first-class attributes — status, priority, schedule, project, assignee,
 * estimate/logged, tags, timestamps — are surfaced AND edited through the
 * shared property-value cells (`@brainstorm/sdk/property-ui`) rather than
 * hand-rolled chips / menus / inputs ([[feedback-no-hand-rolled-property-panels]]),
 * exactly like the Bookmarks detail.
 *
 * Tasks still store these as first-class `Task` fields, so this module
 * BRIDGES: it synthesises a `PropertyDef` list + a `ValuesMap` from the typed
 * fields for the detail's properties inspector, and the matching write-back
 * parsers map each cell's edited value back to the typed field. Status /
 * priority / tags are `text + vocabulary` (the dictionaries in `task-vocab.ts`,
 * whose item ids ARE the `Priority` enum / `statusKey` / tag id), project /
 * assignee are entity-refs, estimate/logged are Duration numbers. When the
 * OQ-DM-1 property-backed migration lands (a task becomes a property-bearing
 * entity with a real `values` map) the synthesis drops out and the same cells
 * render the entity's own values — zero UI change. The defs are transient
 * (not registered in the vault catalog) so the global Properties list isn't
 * polluted with field-bridge entries.
 */

import {
	CARDINALITY_HARD_MAX,
	DateGranularity,
	type DateValue,
	type LabeledValue,
	type PropertyDef,
	PropertyFormat,
	ValueType,
} from "@brainstorm/sdk-types";
import type { PropertiesPanelRow } from "@brainstorm/sdk/properties-panel";
import { type ValuesMap, readValue } from "@brainstorm/sdk/property-ui";
import { t } from "../i18n/t";
import { Priority } from "../types/task";
import type { Task } from "../types/task";
import { PRIORITY_DICT_ID, STATUS_DICT_ID, TAGS_DICT_ID } from "./task-vocab";

/** The vault type the assignee picker is scoped to — the same people the
 *  Contacts app holds. */
export const PERSON_ENTITY_TYPE = "brainstorm/Person/v1";

/** The vault type the project picker is scoped to — the Tasks-app-owned
 *  `Project/v1` entities (entity id === `Task.projectId`). */
export const PROJECT_ENTITY_TYPE = "brainstorm/Project/v1";

export const TASK_PROP_KEY = {
	status: "io.brainstorm.tasks/status",
	priority: "io.brainstorm.tasks/priority",
	scheduled: "io.brainstorm.tasks/scheduled",
	due: "io.brainstorm.tasks/due",
	project: "io.brainstorm.tasks/project",
	assignee: "io.brainstorm.tasks/assignee",
	estimate: "io.brainstorm.tasks/estimate",
	logged: "io.brainstorm.tasks/logged",
	tags: "io.brainstorm.tasks/tags",
	created: "io.brainstorm.tasks/created",
	updated: "io.brainstorm.tasks/updated",
} as const;

/** Render order for the detail's properties inspector. Every field is edited
 *  in-place through its shared property cell — status / priority / tags via the
 *  vocabulary-backed TagCell, scheduled / due via the DateCell, project /
 *  assignee via the EntityRef Link cell, estimate / logged via the Duration
 *  Number cell. Created / updated stay read-only (no stored field to write). */
export const TASK_PROPERTY_DEFS: readonly PropertyDef[] = [
	{
		key: TASK_PROP_KEY.status,
		name: t("tasks.prop.status"),
		icon: null,
		valueType: ValueType.Text,
		vocabulary: { dictionaryId: STATUS_DICT_ID },
		count: { min: 0, max: 1 },
	},
	{
		key: TASK_PROP_KEY.priority,
		name: t("tasks.prop.priority"),
		icon: null,
		valueType: ValueType.Text,
		vocabulary: { dictionaryId: PRIORITY_DICT_ID },
		count: { min: 0, max: 1 },
	},
	{
		key: TASK_PROP_KEY.scheduled,
		name: t("tasks.prop.scheduled"),
		icon: null,
		valueType: ValueType.Date,
		granularity: DateGranularity.Date,
	},
	{
		key: TASK_PROP_KEY.due,
		name: t("tasks.prop.due"),
		icon: null,
		valueType: ValueType.Date,
		granularity: DateGranularity.Date,
	},
	{
		key: TASK_PROP_KEY.project,
		name: t("tasks.prop.project"),
		icon: null,
		valueType: ValueType.EntityRef,
		allowedTypes: [PROJECT_ENTITY_TYPE],
		count: { min: 0, max: 1 },
	},
	{
		key: TASK_PROP_KEY.assignee,
		name: t("tasks.prop.assignee"),
		icon: null,
		valueType: ValueType.EntityRef,
		allowedTypes: [PERSON_ENTITY_TYPE],
		count: { min: 0, max: 1 },
	},
	{
		key: TASK_PROP_KEY.estimate,
		name: t("tasks.prop.estimate"),
		icon: null,
		valueType: ValueType.Number,
		format: PropertyFormat.Duration,
	},
	{
		key: TASK_PROP_KEY.logged,
		name: t("tasks.prop.logged"),
		icon: null,
		valueType: ValueType.Number,
		format: PropertyFormat.Duration,
	},
	{
		key: TASK_PROP_KEY.tags,
		name: t("tasks.prop.tags"),
		icon: null,
		valueType: ValueType.Text,
		vocabulary: { dictionaryId: TAGS_DICT_ID },
		count: { min: 0, max: CARDINALITY_HARD_MAX },
	},
	{
		key: TASK_PROP_KEY.created,
		name: t("tasks.prop.created"),
		icon: null,
		valueType: ValueType.Date,
		granularity: DateGranularity.Date,
	},
	{
		key: TASK_PROP_KEY.updated,
		name: t("tasks.prop.updated"),
		icon: null,
		valueType: ValueType.Date,
		granularity: DateGranularity.Date,
	},
];

/** Synthesise the cell values for a task, keyed by property def. Each value is
 *  in the shape its cell reads/writes: priority/status as the dictionary item
 *  id (which IS the `Priority` enum value / `statusKey`), tags as a
 *  `LabeledValue[]` of item ids, project/assignee as the raw entity id, dates
 *  as `DateValue | null`, estimate/logged as a number of HOURS (the Duration
 *  formatter is hours-based; the stored fields are minutes). */
export function taskToValues(task: Task): ValuesMap {
	return {
		[TASK_PROP_KEY.status]: task.statusKey,
		[TASK_PROP_KEY.priority]: task.priority,
		[TASK_PROP_KEY.scheduled]:
			task.scheduledAt !== null ? { at: task.scheduledAt, granularity: DateGranularity.Date } : null,
		[TASK_PROP_KEY.due]:
			task.dueAt !== null ? { at: task.dueAt, granularity: DateGranularity.Date } : null,
		[TASK_PROP_KEY.project]: task.projectId ?? "",
		[TASK_PROP_KEY.assignee]: task.assigneeId ?? "",
		[TASK_PROP_KEY.estimate]: task.estimateMinutes !== undefined ? task.estimateMinutes / 60 : null,
		[TASK_PROP_KEY.logged]: task.loggedMinutes !== undefined ? task.loggedMinutes / 60 : null,
		[TASK_PROP_KEY.tags]: (task.tags ?? []).map(
			(id) => ({ value: id }) satisfies LabeledValue<string>,
		),
		[TASK_PROP_KEY.created]: { at: task.createdAt, granularity: DateGranularity.Date },
		[TASK_PROP_KEY.updated]: { at: task.updatedAt, granularity: DateGranularity.Date },
	};
}

/** An entity-ref scalar cell emits the picked entity id, or an empty/null
 *  clear. Shared by assignee and project. */
export function parseEntityRefValue(next: unknown): string | null {
	return typeof next === "string" && next.length > 0 ? next : null;
}

/** Assignee/project both store a nullable entity id. */
export const parseAssigneeValue = parseEntityRefValue;
export const parseProjectValue = parseEntityRefValue;

const PRIORITY_VALUES: readonly Priority[] = Object.values(Priority);

/** Map the priority cell's edited dict id back to the `Priority` enum — the id
 *  space IS the enum, so an unknown / cleared value falls back to `None`. */
export function parsePriorityValue(next: unknown): Priority {
	if (typeof next === "string" && (PRIORITY_VALUES as readonly string[]).includes(next)) {
		return next as Priority;
	}
	return Priority.None;
}

/** Map the status cell's edited dict id back to `Task.statusKey` (same id
 *  space; the cell emits null on clear). */
export function parseStatusValue(next: unknown): string | null {
	return typeof next === "string" && next.length > 0 ? next : null;
}

/** Read the epoch-ms out of a DateCell value, or null when cleared. */
export function parseDateValue(next: unknown): number | null {
	return next && typeof next === "object" && typeof (next as DateValue).at === "number"
		? (next as DateValue).at
		: null;
}

/** Map the multi-valued TagCell envelope back to a flat id array. */
export function parseTagsValue(next: unknown): string[] {
	if (!Array.isArray(next)) return [];
	return (next as readonly LabeledValue<string>[])
		.map((el) => el.value)
		.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Map the Duration Number cell's edited value (HOURS) back to whole stored
 *  minutes, or null when cleared / zero. */
export function parseDurationValue(next: unknown): number | null {
	if (typeof next !== "number" || !Number.isFinite(next) || next <= 0) return null;
	return Math.round(next * 60);
}

/** Per-field persisters supplied by the host. An absent handler leaves that
 *  row read-only — created / updated have none by design. Shared by the
 *  slide-over inspector panel and the inline detail property block so both
 *  build the bridged rows identically. */
export type TaskFieldHandlers = {
	onStatusChange?: (statusKey: string | null) => void;
	onPriorityChange?: (priority: Priority) => void;
	onScheduledChange?: (at: number | null) => void;
	onDueChange?: (at: number | null) => void;
	onProjectChange?: (projectId: string | null) => void;
	onAssigneeChange?: (assigneeId: string | null) => void;
	onEstimateChange?: (minutes: number | null) => void;
	onLoggedChange?: (minutes: number | null) => void;
	onTagsChange?: (tags: string[]) => void;
};

/** Build the bridged property rows for a task — each field's cell value plus an
 *  `onChange` that maps the edited value back through its parser to the typed
 *  `Task` patch. An optional `only` set restricts the rows (the inline detail
 *  block shows a subset; the inspector panel shows all). */
export function bridgedTaskRows(
	task: Task,
	handlers: TaskFieldHandlers,
	only?: ReadonlySet<string>,
): PropertiesPanelRow[] {
	const values = taskToValues(task);
	const {
		onStatusChange,
		onPriorityChange,
		onScheduledChange,
		onDueChange,
		onProjectChange,
		onAssigneeChange,
		onEstimateChange,
		onLoggedChange,
		onTagsChange,
	} = handlers;
	const editable: Record<string, ((next: unknown) => void) | undefined> = {
		[TASK_PROP_KEY.status]: onStatusChange && ((n) => onStatusChange(parseStatusValue(n))),
		[TASK_PROP_KEY.priority]: onPriorityChange && ((n) => onPriorityChange(parsePriorityValue(n))),
		[TASK_PROP_KEY.scheduled]: onScheduledChange && ((n) => onScheduledChange(parseDateValue(n))),
		[TASK_PROP_KEY.due]: onDueChange && ((n) => onDueChange(parseDateValue(n))),
		[TASK_PROP_KEY.project]: onProjectChange && ((n) => onProjectChange(parseProjectValue(n))),
		[TASK_PROP_KEY.assignee]: onAssigneeChange && ((n) => onAssigneeChange(parseAssigneeValue(n))),
		[TASK_PROP_KEY.estimate]: onEstimateChange && ((n) => onEstimateChange(parseDurationValue(n))),
		[TASK_PROP_KEY.logged]: onLoggedChange && ((n) => onLoggedChange(parseDurationValue(n))),
		[TASK_PROP_KEY.tags]: onTagsChange && ((n) => onTagsChange(parseTagsValue(n))),
	};
	return TASK_PROPERTY_DEFS.filter((def) => !only || only.has(def.key)).map((def) => {
		const onChange = editable[def.key];
		return onChange
			? { def, value: readValue(values, def), onChange }
			: { def, value: readValue(values, def), readOnly: true };
	});
}

/** Catalog defs bound on the task (a key in `values` that resolves in the
 *  vault catalog), name-sorted — the editable custom rows (9.14.16). A key
 *  whose def was deleted from the catalog renders nothing (the value stays
 *  in the bag untouched). */
export function boundCustomDefs(
	values: ValuesMap | undefined,
	catalog: ReadonlyMap<string, PropertyDef>,
): PropertyDef[] {
	if (!values) return [];
	const out: PropertyDef[] = [];
	for (const key of Object.keys(values)) {
		const def = catalog.get(key);
		if (def) out.push(def);
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/** Catalog defs not yet bound on the task — the add-property menu's
 *  candidates, name-sorted. Excludes keys already in `values` AND the
 *  fixed/bridged catalog keys shown as their own dedicated rows: `assigneeId`
 *  is the F-152 catalog def the app ensures at boot, and binding it into
 *  `values` would create a second, divergent "Assignee" the chip / group-by /
 *  Graph edge ignore (they read `task.assigneeId`). */
export function unboundCustomDefs(
	values: ValuesMap | undefined,
	catalog: ReadonlyMap<string, PropertyDef>,
): PropertyDef[] {
	const bound = new Set(Object.keys(values ?? {}));
	const fixed = new Set([ASSIGNEE_CATALOG_DEF.key]);
	const out: PropertyDef[] = [];
	for (const def of catalog.values()) {
		if (!bound.has(def.key) && !fixed.has(def.key)) out.push(def);
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/** The vault-catalog EntityRef def for `Task.assigneeId` (F-152) — the def
 *  the shell's catalog-driven derivation reads to project the Task→Person
 *  "Assignee" edge into the Graph. Key + shape mirror the dev seeder
 *  (`plan-properties.ts`), but the app ensures it itself at boot because the
 *  seeder only runs under AUTO_SEED (never in a production vault). The name
 *  is catalog data (persisted), not UI chrome — deliberately not t()'d,
 *  matching every other catalog def. */
export const ASSIGNEE_CATALOG_DEF: PropertyDef = {
	key: "assigneeId",
	name: "Assignee",
	icon: null,
	valueType: ValueType.EntityRef,
	allowedTypes: [PERSON_ENTITY_TYPE],
	count: { min: 0, max: 1 },
};
