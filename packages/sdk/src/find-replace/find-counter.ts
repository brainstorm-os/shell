import type { FindLabels } from "../i18n/common-labels";
import { type FindControllerState, FindStatus } from "./find-controller";
import { FindPatternError } from "./find-pattern";

function fill(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

/** The match-counter text both find bars (React + DOM) show. */
export function findCounterText(state: FindControllerState, labels: FindLabels): string {
	switch (state.status) {
		case FindStatus.InvalidPattern:
			return state.patternError === FindPatternError.Unsafe
				? labels.unsafePattern
				: labels.invalidPattern;
		case FindStatus.NoMatches:
			return labels.noResults;
		case FindStatus.Matches:
			return fill(state.truncated ? labels.matchCountTruncated : labels.matchCount, {
				current: state.activeIndex + 1,
				total: state.matchCount,
			});
		default:
			return "";
	}
}
