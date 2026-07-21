/**
 * Time estimates / logged effort (9.14.13) — pure parse + format helpers.
 *
 * A task carries an optional planned `estimateMinutes` and a logged
 * `loggedMinutes`; both are entered as a free-typed duration ("2h30m", "90m",
 * "1.5h", or a bare minute count) and displayed via the shared `formatDuration`
 * (B5.12), which takes hours — so minutes round-trip through `/ 60`.
 */

import { formatDuration } from "@brainstorm-os/sdk/property-ui/pure";

/** Format a minute count as a duration ("2h 30m" / "45m" / "0h"); null/blank
 *  → "". Delegates to the shared `formatDuration` (hours in). */
export function formatMinutes(minutes: number | null): string {
	if (minutes === null || !Number.isFinite(minutes)) return "";
	return formatDuration(minutes / 60);
}

const HM_RE = /^\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*$/i;

/**
 * Parse a free-typed duration into whole minutes, or null when blank/invalid.
 * Accepts `2h`, `30m`, `2h30m`, `2h 30m`, `1.5h`, and a bare number (minutes).
 * Negative / non-finite → null. A lone `0` (or `0h`/`0m`) parses to 0.
 */
export function parseDurationToMinutes(input: string): number | null {
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;

	// Bare number → minutes.
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		const n = Number(trimmed);
		return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
	}

	const match = HM_RE.exec(trimmed);
	if (!match) return null;
	const hours = match[1] !== undefined ? Number(match[1]) : 0;
	const mins = match[2] !== undefined ? Number(match[2]) : 0;
	// Reject a string that matched the shape but carried no h/m token at all.
	if (match[1] === undefined && match[2] === undefined) return null;
	if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
	const total = Math.round(hours * 60 + mins);
	return total >= 0 ? total : null;
}
