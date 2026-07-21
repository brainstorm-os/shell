/**
 * Re-export shim — the recurrence-edit helpers moved to the shared
 * `@brainstorm-os/sdk/recurrence-edit` when Tasks (9.14.12) became the second
 * consumer of the recurrence editor. Calendar's import sites stay unchanged.
 */

export {
	RepeatKind,
	REPEAT_KINDS,
	clampInterval,
	coerceRecurrence,
	defaultRecurrenceForKind,
	normalizeWeekdays,
	repeatKindOf,
	weekdayForDate,
} from "@brainstorm-os/sdk/recurrence-edit";
