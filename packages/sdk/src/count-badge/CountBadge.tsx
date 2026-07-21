/**
 * `<CountBadge>` — the shared count pill (`.bs-count-badge`). Renders a
 * numeric badge that trails sidebar rows, list filters, board lanes, etc.
 * Every app uses this so the badges read as siblings instead of each app's
 * own hand-rolled `__count` span.
 *
 * Load the styles once per app: `import "@brainstorm-os/sdk/count-badge.css"`.
 */

import { CountBadgeTone, countBadgeClassName, formatCount } from "./format-count";

export interface CountBadgeProps {
	/** The number shown in the pill. */
	count: number;
	/** Resting (`Neutral`) vs accent-tinted (`Accent`, for an active row). */
	tone?: CountBadgeTone;
	/** Cap the displayed value (e.g. `99` → `"99+"`); the raw count still
	 *  lands in `data-count`. */
	max?: number;
	/** Extra layout/positioning classes (never re-skin the pill). */
	className?: string;
}

export function CountBadge({
	count,
	tone = CountBadgeTone.Neutral,
	max,
	className,
}: CountBadgeProps) {
	return (
		<span className={countBadgeClassName(tone, className)} data-count={count}>
			{formatCount(count, max)}
		</span>
	);
}

export { CountBadgeTone };
