/**
 * MultilineCell — Text value rendered as wrapping, multi-line content
 * (the `PropertyView.Multiline` view). Resting render preserves the
 * value's own line breaks; click-to-edit opens the auto-growing
 * `InlineEditTextarea` (Enter commits, Shift+Enter inserts a break,
 * blur commits, Escape reverts). Scalar Text only.
 */

import type { CellProps } from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback, useState } from "react";
import { coerceValue } from "../../properties-validate";
import { usePropertyUiSeams } from "../use-properties";
import { formatScalar, parseScalar } from "./format";
import { InlineEditTextarea } from "./inline-edit-textarea";
import { useCellAutoEdit } from "./use-cell-auto-edit";

export function MultilineCell(props: CellProps): JSX.Element {
	const { property, value, onChange, readOnly, autoEdit, onAutoEditHandled } = props;
	const { labels } = usePropertyUiSeams();
	const [editing, setEditing] = useState(false);
	useCellAutoEdit(autoEdit, readOnly, () => setEditing(true), onAutoEditHandled);
	const display = formatScalar(property, value);

	const onCommit = useCallback(
		(raw: string) => {
			onChange(coerceValue(property, parseScalar(property, raw)) as never);
			setEditing(false);
		},
		[property, onChange],
	);

	if (editing && !readOnly) {
		return (
			<InlineEditTextarea
				initialValue={display}
				className="bs-cell-multiline-input"
				ariaLabel={labels.cellEditValueFor(property.name)}
				onCommit={onCommit}
				onCancel={() => setEditing(false)}
			/>
		);
	}

	return (
		<button
			type="button"
			className={
				display.length === 0 ? "bs-cell-multiline bs-cell-multiline--empty" : "bs-cell-multiline"
			}
			onClick={() => !readOnly && setEditing(true)}
			disabled={readOnly}
			aria-label={labels.cellEditValueFor(property.name)}
		>
			{display.length === 0 ? labels.cellEmpty : display}
		</button>
	);
}
