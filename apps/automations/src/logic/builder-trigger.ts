/**
 * 11b.11 — the builder's trigger model. A workflow is bound to its own
 * `Trigger/v1` entity (one trigger can fire many workflows); the builder
 * authors a minimal trigger for the engine-wired kinds (Time / EntityEvent
 * / Manual — `ENGINE_TRIGGER_KINDS`). The richer time recurrence + entity
 * filters stay the template / future-iteration surface; v1 offers a
 * sensible default per kind so an authored workflow actually fires once the
 * scheduler is live.
 */

import {
	ENGINE_TRIGGER_KINDS,
	EntityEventVerb,
	type Recurrence,
	RecurrenceKind,
	type TriggerDef,
	TriggerKind,
	Weekday,
	isEntityEventVerb,
	isTriggerKind,
} from "@brainstorm-os/sdk-types";

/** The trigger kinds the v1 builder palette offers — the engine-wired set. */
export const BUILDER_TRIGGER_KINDS = ENGINE_TRIGGER_KINDS;

/** Common user-facing types worth suggesting for an `EntityEvent` trigger so
 *  authoring (e.g. "when a new Email arrives, triage it") does not require
 *  memorising the exact `brainstorm/<T>/v1` URL (Mailbox-8). The field stays
 *  free-text — these are only `<datalist>` hints, unioned with whatever types
 *  the current vault actually holds. */
export const SUGGESTED_TRIGGER_TYPES: readonly string[] = Object.freeze([
	"brainstorm/Email/v1",
	"brainstorm/Task/v1",
	"brainstorm/Note/v1",
	"brainstorm/Event/v1",
	"brainstorm/Bookmark/v1",
	"brainstorm/Person/v1",
	"brainstorm/Highlight/v1",
	"brainstorm/File/v1",
]);

/** Merge the curated suggestions with the types the vault actually holds,
 *  deduped and sorted, so the picker surfaces both "things you could automate"
 *  and "things you have". Non-string / empty entries are dropped. */
export function triggerTypeSuggestions(vaultTypes: Iterable<string>): string[] {
	const seen = new Set<string>(SUGGESTED_TRIGGER_TYPES);
	for (const type of vaultTypes) {
		if (typeof type === "string" && type.length > 0) seen.add(type);
	}
	return [...seen].sort((a, b) => a.localeCompare(b));
}

/** A daily recurrence preset for a `Time` trigger (the safe default). */
export enum TimePreset {
	Daily = "daily",
	Weekdays = "weekdays",
	Weekly = "weekly",
	Monthly = "monthly",
}

export const TIME_PRESETS = Object.freeze([
	TimePreset.Daily,
	TimePreset.Weekdays,
	TimePreset.Weekly,
	TimePreset.Monthly,
]) as readonly TimePreset[];

/** The editable trigger half of builder state — kind plus the few fields
 *  the v1 builder exposes per kind. */
export type BuilderTrigger = {
	kind: TriggerKind;
	/** `Time`: the recurrence preset. */
	timePreset: TimePreset;
	/** `EntityEvent`: the watched type + lifecycle verb. */
	entityType: string;
	verb: EntityEventVerb;
};

export function emptyBuilderTrigger(): BuilderTrigger {
	return {
		kind: TriggerKind.Manual,
		timePreset: TimePreset.Daily,
		entityType: "",
		verb: EntityEventVerb.Create,
	};
}

const WEEKDAYS: readonly Weekday[] = [
	Weekday.Mon,
	Weekday.Tue,
	Weekday.Wed,
	Weekday.Thu,
	Weekday.Fri,
];

function recurrenceForPreset(preset: TimePreset): Recurrence {
	switch (preset) {
		case TimePreset.Weekdays:
			return { kind: RecurrenceKind.Weekly, every: 1, days: [...WEEKDAYS] };
		case TimePreset.Weekly:
			return { kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Mon] };
		case TimePreset.Monthly:
			return { kind: RecurrenceKind.Monthly, every: 1 };
		default:
			return { kind: RecurrenceKind.Daily, every: 1 };
	}
}

/** Freeze the builder trigger into a `Trigger/v1` def the scheduler reads. */
export function builderTriggerToDef(trigger: BuilderTrigger): TriggerDef {
	switch (trigger.kind) {
		case TriggerKind.Time:
			return {
				kind: TriggerKind.Time,
				config: { recurrence: recurrenceForPreset(trigger.timePreset) },
				enabled: true,
			};
		case TriggerKind.EntityEvent:
			return {
				kind: TriggerKind.EntityEvent,
				config: { entityType: trigger.entityType.trim(), verb: trigger.verb },
				enabled: true,
			};
		default:
			return { kind: TriggerKind.Manual, config: {}, enabled: true };
	}
}

/** Recover an editable builder trigger from a persisted `Trigger/v1` def —
 *  best-effort, defaulting unknown / missing fields (Edit flow). */
export function builderTriggerFromDef(def: TriggerDef): BuilderTrigger {
	const base = emptyBuilderTrigger();
	if (isTriggerKind(def.kind)) base.kind = def.kind;
	const config = def.config ?? {};
	if (def.kind === TriggerKind.EntityEvent) {
		if (typeof config.entityType === "string") base.entityType = config.entityType;
		if (isEntityEventVerb(config.verb)) base.verb = config.verb;
	}
	if (def.kind === TriggerKind.Time) {
		const recurrence = config.recurrence as Recurrence | undefined;
		base.timePreset = presetFromRecurrence(recurrence);
	}
	return base;
}

function presetFromRecurrence(recurrence: Recurrence | undefined): TimePreset {
	if (!recurrence) return TimePreset.Daily;
	if (recurrence.kind === RecurrenceKind.Monthly) return TimePreset.Monthly;
	if (recurrence.kind === RecurrenceKind.Weekly) {
		return recurrence.days && recurrence.days.length > 1 ? TimePreset.Weekdays : TimePreset.Weekly;
	}
	return TimePreset.Daily;
}
