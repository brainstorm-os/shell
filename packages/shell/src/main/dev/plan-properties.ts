/**
 * Vault PropertyDefs + Dictionaries for the BrainstormProject task/plan
 * fields, so they appear in shell Settings → Data Property management and
 * render through the composable property model (typed Date cells,
 * vocabulary-coloured Select chips) instead of as raw strings.
 *
 * Seeded **shell-side** (not via the standalone MCP seed CLI): the vault
 * properties store is a Yjs doc the CLI can't write without reaching into
 * shell internals (a layering breach). `seedPlanProperties` runs on the
 * vault-session hook, through the live vault session's `PropertiesStore`
 * — a throwaway dev hook. Its companion content seed (the BrainstormProject
 * scope) is run manually via `tools/mcp-server/src/seed/seed-cli.ts`.
 *
 * Keys are **stable + semantic** (`statusKey`, `priority`, …) rather than
 * the random `prop_<…>` generator form, because entities store values
 * under these names and the Database app joins a column's `propertyId`
 * straight to the PropertyDef. Idempotent: `setProperty` overwrites by key.
 *
 * NOTE (2026-05-15): this models today's per-app `Task/v1` shape. The
 * single-object-space / collections remodel (see the implementation plan
 * §collections OQ) will fold these into a collection schema — the
 * PropertyDefs themselves are forward-compatible (properties are already
 * vault-level); only who *owns* the schema changes.
 */

import {
	DateGranularity,
	type Dictionary,
	type DictionaryItem,
	type PropertyDef,
	ValueType,
} from "@brainstorm-os/sdk-types";

export const PLAN_DICT_STATUS_ID = "dict-task-status";
export const PLAN_DICT_PRIORITY_ID = "dict-task-priority";

type Vocab = { label: string; colour: string };

const STATUS_VOCAB: ReadonlyArray<Vocab> = [
	{ label: "done", colour: "#16a34a" },
	{ label: "in-flight", colour: "#3b82f6" },
	{ label: "partial", colour: "#f59e0b" },
	{ label: "pending", colour: "#94a3b8" },
	{ label: "reverted", colour: "#dc2626" },
	{ label: "todo", colour: "#64748b" },
];

const PRIORITY_VOCAB: ReadonlyArray<Vocab> = [
	{ label: "none", colour: "#94a3b8" },
	{ label: "low", colour: "#38bdf8" },
	{ label: "medium", colour: "#f59e0b" },
	{ label: "high", colour: "#f97316" },
	{ label: "critical", colour: "#dc2626" },
];

function dictionary(id: string, name: string, vocab: ReadonlyArray<Vocab>): Dictionary {
	// A seeded/system option's id IS its semantic key (the slug-form label) —
	// select values store the option id, and for system vocabularies that id is
	// the stable key (`done`, `high`), so seeded entity data (`statusKey:"done"`),
	// the Tasks enums, and a filter built from this dictionary all agree on one
	// string. User-added options instead get an opaque generated id
	// (`newDictionaryItemId`), which is fine — they're filtered by that id too.
	const items: DictionaryItem[] = vocab.map((v, i) => ({
		id: v.label,
		label: v.label,
		icon: null,
		colour: v.colour,
		sortIndex: i,
	}));
	return { id, name, items };
}

export type PlanProperties = {
	properties: PropertyDef[];
	dictionaries: Dictionary[];
};

export function buildPlanProperties(): PlanProperties {
	const dictionaries: Dictionary[] = [
		dictionary(PLAN_DICT_STATUS_ID, "Task status", STATUS_VOCAB),
		dictionary(PLAN_DICT_PRIORITY_ID, "Priority", PRIORITY_VOCAB),
	];

	const properties: PropertyDef[] = [
		{ key: "name", name: "Name", icon: null, valueType: ValueType.Text },
		{
			key: "statusKey",
			name: "Status",
			icon: null,
			valueType: ValueType.Text,
			vocabulary: { dictionaryId: PLAN_DICT_STATUS_ID },
			count: { min: 0, max: 1 },
		},
		{
			key: "priority",
			name: "Priority",
			icon: null,
			valueType: ValueType.Text,
			vocabulary: { dictionaryId: PLAN_DICT_PRIORITY_ID },
			count: { min: 0, max: 1 },
		},
		{
			key: "projectId",
			name: "Project",
			icon: null,
			valueType: ValueType.EntityRef,
			allowedTypes: ["brainstorm/Project/v1"],
			count: { min: 0, max: 1 },
		},
		{
			key: "assigneeId",
			name: "Assignee",
			icon: null,
			valueType: ValueType.EntityRef,
			allowedTypes: ["brainstorm/Person/v1"],
			count: { min: 0, max: 1 },
		},
		{
			key: "completedAt",
			name: "Completed",
			icon: null,
			valueType: ValueType.Date,
			granularity: DateGranularity.DateTime,
		},
		{
			key: "scheduledAt",
			name: "Scheduled",
			icon: null,
			valueType: ValueType.Date,
			granularity: DateGranularity.Date,
		},
		{
			key: "dueAt",
			name: "Due",
			icon: null,
			valueType: ValueType.Date,
			granularity: DateGranularity.Date,
		},
	];

	return { properties, dictionaries };
}

/** Minimal slice of the vault session the seeder needs. */
export type PlanPropertiesStore = {
	setProperty(def: PropertyDef): void;
	setDictionary(dict: Dictionary): void;
};
export type PlanPropertiesSession = {
	propertiesStore(): Promise<PlanPropertiesStore>;
};

export type SeedPlanPropertiesResult =
	| { ok: true; properties: number; dictionaries: number }
	| { ok: false; reason: string };

export async function seedPlanProperties(
	session: PlanPropertiesSession,
): Promise<SeedPlanPropertiesResult> {
	try {
		const store = await session.propertiesStore();
		const { properties, dictionaries } = buildPlanProperties();
		// Dictionaries first so a Tag picker resolves the vocabulary the
		// moment the property lands.
		for (const dict of dictionaries) store.setDictionary(dict);
		for (const def of properties) store.setProperty(def);
		return { ok: true, properties: properties.length, dictionaries: dictionaries.length };
	} catch (error) {
		return { ok: false, reason: (error as Error).message };
	}
}
