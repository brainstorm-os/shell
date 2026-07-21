/**
 * PlainCell — unstyled inline text. Same valueType support as PillCell
 * but without the chip chrome — meant for stamping a value into a
 * note's flow ("Author: Roman"). Click-to-edit inline through the shared
 * `InlineEditInput`; commit on blur / Enter, revert on Escape. Scalar
 * cardinality only (count.max = 1); multi values surface their own cells.
 */

import { type CellProps, ValueType } from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback, useState } from "react";
import { coerceValue } from "../../properties-validate";
import { TextSurfaceKind, spellcheckForSurface } from "../../spellcheck";
import { usePropertyUiSeams } from "../use-properties";
import { editScalar, formatScalar, parseScalar } from "./format";
import { InlineEditInput } from "./inline-edit-input";
import { useCellAutoEdit } from "./use-cell-auto-edit";

export function PlainCell(props: CellProps): JSX.Element {
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
				className="bs-cell-plain-input"
				spellCheck={spellcheckForSurface(
					property.valueType === ValueType.Number ? TextSurfaceKind.Code : TextSurfaceKind.Prose,
				)}
				ariaLabel={labels.cellEditValueFor(property.name)}
				onCommit={onCommit}
				onCancel={() => setEditing(false)}
			/>
		);
	}

	return (
		<button
			type="button"
			className={display.length === 0 ? "bs-cell-plain bs-cell-plain--empty" : "bs-cell-plain"}
			onClick={() => !readOnly && setEditing(true)}
			disabled={readOnly}
			aria-label={labels.cellEditValueFor(property.name)}
		>
			{display.length === 0 ? labels.cellEmpty : display}
		</button>
	);
}
