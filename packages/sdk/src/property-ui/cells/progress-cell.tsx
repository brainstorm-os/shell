/**
 * ProgressBarCell — Number value rendered as a filled track. Min / max
 * come from the def's `range` modifier (default 0..100). Click to edit
 * the raw number inline; the bar reflects the clamped fraction.
 */

import { type CellProps, ValueType } from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { coerceValue } from "../../properties-validate";
import { usePropertyUiSeams } from "../use-properties";
import { formatNumber, parseNumberInput } from "./format";
import { useInlineEditKeyDown } from "./inline-edit-keys";
import { useCellAutoEdit } from "./use-cell-auto-edit";

export function ProgressBarCell(props: CellProps): JSX.Element {
	const { property, value, onChange, readOnly, autoEdit, onAutoEditHandled } = props;
	const { labels } = usePropertyUiSeams();
	if (property.valueType !== ValueType.Number) {
		throw new Error(`ProgressBarCell registered against ${property.valueType}; expected Number`);
	}
	const [editing, setEditing] = useState(false);
	useCellAutoEdit(autoEdit, readOnly, () => setEditing(true), onAutoEditHandled);
	const min = property.range?.min ?? 0;
	const max = property.range?.max ?? 100;
	const num = typeof value === "number" ? value : null;
	const fraction =
		num === null || max <= min ? 0 : Math.max(0, Math.min(1, (num - min) / (max - min)));
	const display = formatNumber(num, property);

	const onCommit = useCallback(
		(raw: string) => {
			onChange(coerceValue(property, parseNumberInput(raw)) as never);
			setEditing(false);
		},
		[property, onChange],
	);

	if (editing && !readOnly) {
		return (
			<ProgressInput
				initial={num === null ? "" : String(num)}
				ariaLabel={labels.cellEditValueFor(property.name)}
				onCommit={onCommit}
				onCancel={() => setEditing(false)}
			/>
		);
	}

	return (
		<button
			type="button"
			className="bs-cell-progress"
			onClick={() => !readOnly && setEditing(true)}
			disabled={readOnly}
			aria-label={labels.cellEditValueFor(property.name)}
		>
			<span
				className="bs-cell-progress-track"
				role="progressbar"
				tabIndex={-1}
				aria-valuemin={min}
				aria-valuemax={max}
				aria-valuenow={num ?? undefined}
			>
				<span className="bs-cell-progress-fill" style={{ transform: `scaleX(${fraction})` }} />
			</span>
			<span className="bs-cell-progress-text">{num === null ? labels.cellEmpty : display}</span>
		</button>
	);
}

function ProgressInput({
	initial,
	ariaLabel,
	onCommit,
	onCancel,
}: {
	initial: string;
	ariaLabel: string;
	onCommit: (raw: string) => void;
	onCancel: () => void;
}): JSX.Element {
	const [draft, setDraft] = useState(initial);
	const ref = useRef<HTMLInputElement>(null);
	const onKeyDown = useInlineEditKeyDown(() => onCommit(draft), onCancel);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	return (
		<input
			ref={ref}
			className="bs-cell-input"
			type="number"
			value={draft}
			aria-label={ariaLabel}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => onCommit(draft)}
			onKeyDown={onKeyDown}
		/>
	);
}
