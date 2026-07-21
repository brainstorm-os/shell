/**
 * Re-export shim — the live-rolling relative-date resolver (9.12.20) is now
 * canonical in `@brainstorm-os/sdk/predicate-eval` (promoted at 9.12.3 so the
 * shell's `ListSource` query path resolves "$relativeDate" identically).
 * In-app import sites are untouched.
 */

export {
	ALL_RELATIVE_DATE_RANGES,
	type DateWindow,
	RelativeDateRange,
	isInRelativeRange,
	isRelativeDateRange,
	relativeRangeLabel,
	resolveRelativeRange,
	toTimestamp,
} from "@brainstorm-os/sdk/predicate-eval";
