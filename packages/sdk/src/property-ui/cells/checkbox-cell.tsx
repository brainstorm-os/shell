/**
 * CheckboxCell — Boolean default view.
 *
 * Native `<input type="checkbox">` so platform keyboard semantics
 * (Space toggles, focus indicators) are free. Click + Space both
 * commit; no separate edit mode.
 */

import { type CellProps, ValueType } from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback } from "react";
import { usePropertyUiSeams } from "../use-properties";
import { useCellAutoEdit } from "./use-cell-auto-edit";

export function CheckboxCell(props: CellProps): JSX.Element {
	const { property, value, onChange, readOnly, autoEdit, onAutoEditHandled } = props;
	const { labels } = usePropertyUiSeams();
	if (property.valueType !== ValueType.Boolean) {
		throw new Error(`CheckboxCell registered against ${property.valueType}; expected Boolean`);
	}
	const checked = value === true;

	const onToggle = useCallback(() => {
		onChange(!checked as never);
	}, [checked, onChange]);

	// Keyboard Enter-to-edit (12.4): a Boolean cell's "begin editing" action is
	// the flip itself (no editor to open). Fires once per rising edge.
	useCellAutoEdit(autoEdit, readOnly, onToggle, onAutoEditHandled);

	return (
		<label className="bs-cell-checkbox">
			<input
				type="checkbox"
				checked={checked}
				disabled={readOnly}
				onChange={onToggle}
				aria-label={labels.cellToggleValueFor(property.name)}
			/>
			<span className="bs-cell-checkbox-label">{property.name}</span>
		</label>
	);
}
