/**
 * PillCell — chip-style render for the text-family value types
 * (Text / Number / Date / EntityRef) at scalar cardinality. Click to
 * edit inline through the shared `InlineEditInput`; commit on blur or
 * Enter, revert on Escape.
 */

import { type CellProps, ValueType } from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback, useState } from "react";
import { coerceValue } from "../../properties-validate";
import { usePropertyUiSeams } from "../use-properties";
import { editScalar, formatScalar, parseScalar } from "./format";
import { InlineEditInput } from "./inline-edit-input";
import { useCellAutoEdit } from "./use-cell-auto-edit";

export function PillCell(props: CellProps): JSX.Element {
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
			<InlineEditInput
				initialValue={editScalar(property, value)}
				inputType={property.valueType === ValueType.Number ? "number" : "text"}
				className="bs-cell-input"
				ariaLabel={labels.cellEditValueFor(property.name)}
				onCommit={onCommit}
				onCancel={() => setEditing(false)}
			/>
		);
	}

	return (
		<button
			type="button"
			className={display.length === 0 ? "bs-cell-pill bs-cell-pill--empty" : "bs-cell-pill"}
			onClick={() => !readOnly && setEditing(true)}
			disabled={readOnly}
			aria-label={labels.cellEditValueFor(property.name)}
		>
			<span className="bs-cell-pill-text">{display.length === 0 ? labels.cellEmpty : display}</span>
		</button>
	);
}
