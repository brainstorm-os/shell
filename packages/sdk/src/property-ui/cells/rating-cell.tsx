/**
 * RatingCell — Number rendered as a row of stars (the
 * `PropertyView.Rating` view). The star count comes from the def's
 * `range.max` (default 5). Clicking star N sets the value to N; clicking
 * the current top star clears it. Each star is a real `<button>` so
 * keyboard + AT come for free (Tab between stars, Space/Enter to set) —
 * no edit mode, the click commits.
 */

import { type CellProps, ValueType } from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback } from "react";
import { coerceValue } from "../../properties-validate";
import { usePropertyUiSeams } from "../use-properties";

const DEFAULT_MAX_STARS = 5;

export function RatingCell(props: CellProps): JSX.Element {
	const { property, value, onChange, readOnly } = props;
	const { labels } = usePropertyUiSeams();
	if (property.valueType !== ValueType.Number) {
		throw new Error(`RatingCell registered against ${property.valueType}; expected Number`);
	}
	const max = Math.max(1, Math.round(property.range?.max ?? DEFAULT_MAX_STARS));
	const current =
		typeof value === "number" && Number.isFinite(value)
			? Math.max(0, Math.min(max, Math.round(value)))
			: 0;

	const set = useCallback(
		(star: number) => {
			if (readOnly) return;
			// Re-clicking the current top star clears the rating.
			onChange(coerceValue(property, star === current ? null : star) as never);
		},
		[current, onChange, property, readOnly],
	);

	const stars = [];
	for (let i = 1; i <= max; i += 1) {
		const filled = i <= current;
		stars.push(
			<button
				key={i}
				type="button"
				className={filled ? "bs-cell-star bs-cell-star--on" : "bs-cell-star"}
				disabled={readOnly}
				aria-pressed={filled}
				aria-label={labels.cellRateValueFor?.(property.name, i, max) ?? `${i} / ${max}`}
				onClick={() => set(i)}
			>
				<span aria-hidden="true">{filled ? "★" : "☆"}</span>
			</button>,
		);
	}

	return (
		<span className="bs-cell-rating" role="group" aria-label={labels.cellEditValueFor(property.name)}>
			{stars}
			{current === 0 ? (
				<span className="bs-cell-rating-empty">{labels.ratingEmpty ?? labels.cellEmpty}</span>
			) : null}
		</span>
	);
}
