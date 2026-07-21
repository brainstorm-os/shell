/**
 * Task vocabularies (Dictionaries) backing the property-cell editing path.
 *
 * Priority and status used to be edited through hand-rolled anchored menus and
 * tags through a bespoke text-input list; converging them onto the shared
 * property cells ([[feedback-no-hand-rolled-property-panels]]) means modelling
 * each as a `text + vocabulary` property whose options live in a vault
 * Dictionary, exactly like a page-database "Select" / "Multi-select".
 *
 * Item ids are NOT random: the priority item id IS the `Priority` enum value
 * and the status item id IS the `Task.statusKey` string, so the typed `Task`
 * fields and the cell write-back share one id space (and board-column drag,
 * which writes `statusKey` directly, stays in sync with the status cell). Tag
 * item ids are the normalised label itself, so existing `tags: string[]` values
 * need no per-task rewrite — only a one-time dictionary backfill so historical
 * tags appear in the picker.
 */

import type { Dictionary, DictionaryItem, PropertiesService } from "@brainstorm-os/sdk-types";
import { t } from "../i18n/t";
import { PRIORITIES, Priority, TaskStatus } from "../types/task";
import type { Task } from "../types/task";

export const PRIORITY_DICT_ID = "io.brainstorm.tasks/priority";
export const STATUS_DICT_ID = "io.brainstorm.tasks/status";
export const TAGS_DICT_ID = "io.brainstorm.tasks/tags";

/** Per-priority label key + tag accent. `None` carries no colour (neutral). */
const PRIORITY_META: Record<Priority, { labelKey: string; colour?: string }> = {
	[Priority.None]: { labelKey: "tasks.priority.none" },
	[Priority.Low]: { labelKey: "tasks.priority.low", colour: "#3b82f6" },
	[Priority.Medium]: { labelKey: "tasks.priority.medium", colour: "#f59e0b" },
	[Priority.High]: { labelKey: "tasks.priority.high", colour: "#f97316" },
	[Priority.Critical]: { labelKey: "tasks.priority.critical", colour: "#ef4444" },
};

/** Seeded status options, in display order. Item id === `Task.statusKey`. */
const STATUS_META: readonly { key: string; labelKey: string; colour: string }[] = [
	{ key: TaskStatus.Todo, labelKey: "tasks.status.todo", colour: "#94a3b8" },
	{ key: TaskStatus.InProgress, labelKey: "tasks.status.in-progress", colour: "#3b82f6" },
	{ key: TaskStatus.Active, labelKey: "tasks.status.active", colour: "#14b8a6" },
	{ key: TaskStatus.Done, labelKey: "tasks.status.done", colour: "#22c55e" },
	{ key: TaskStatus.Cancelled, labelKey: "tasks.status.cancelled", colour: "#64748b" },
];

function item(id: string, label: string, sortIndex: number, colour?: string): DictionaryItem {
	return { id, label, icon: null, sortIndex, ...(colour ? { colour } : {}) };
}

/** The seeded priority vocabulary — item ids are `Priority` enum values. */
export function priorityDictionary(): Dictionary {
	return {
		id: PRIORITY_DICT_ID,
		name: t("tasks.prop.priority"),
		items: PRIORITIES.map((p, i) =>
			item(p, t(PRIORITY_META[p].labelKey), i, PRIORITY_META[p].colour),
		),
	};
}

/** The seeded status vocabulary — item ids are `Task.statusKey` strings. */
export function statusDictionary(): Dictionary {
	return {
		id: STATUS_DICT_ID,
		name: t("tasks.prop.status"),
		items: STATUS_META.map((s, i) => item(s.key, t(s.labelKey), i, s.colour)),
	};
}

/** The tag vocabulary seed — empty; items author themselves via the picker's
 *  inline-create and the one-time `backfillTagDictionary` migration. */
export function tagsDictionary(): Dictionary {
	return { id: TAGS_DICT_ID, name: t("tasks.tags.heading"), items: [] };
}

/** Seed the priority / status / tags vocabularies into the vault catalog,
 *  idempotently — each is written only when absent so a user's renamed /
 *  recoloured / custom options survive a restart. Mirrors the assignee
 *  catalog-def ensure in `main.tsx`. */
export async function ensureTaskVocab(properties: PropertiesService): Promise<void> {
	for (const dict of [priorityDictionary(), statusDictionary(), tagsDictionary()]) {
		const existing = await properties.getDictionary(dict.id);
		if (!existing) await properties.setDictionary(dict);
	}
}

/** Union every task's existing `tags` labels into the dictionary as
 *  identity-id items, so historical free-text tags show up in the picker.
 *  Returns an updated Dictionary when new tags were found, else `null`
 *  (idempotent — nothing to persist). */
export function backfillTagDictionary(
	existing: Dictionary,
	tasks: readonly Task[],
): Dictionary | null {
	const known = new Set(existing.items.map((it) => it.id));
	let nextSortIndex = existing.items.reduce((max, it) => Math.max(max, it.sortIndex + 1), 0);
	const additions: DictionaryItem[] = [];
	for (const task of tasks) {
		for (const tag of task.tags ?? []) {
			if (known.has(tag)) continue;
			known.add(tag);
			additions.push(item(tag, tag, nextSortIndex));
			nextSortIndex += 1;
		}
	}
	if (additions.length === 0) return null;
	return { ...existing, items: [...existing.items, ...additions] };
}
