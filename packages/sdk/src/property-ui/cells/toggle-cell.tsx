/**
 * ToggleCell — Boolean rendered as a switch (the `PropertyView.Toggle`
 * view), the visual alternative to `CheckboxCell`. Same commit model:
 * click or Space/Enter flips the value immediately (no edit mode). The
 * switch is a `role="switch"` button so platform AT announces on/off.
 */

import { type CellProps, ValueType } from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback } from "react";
import { usePropertyUiSeams } from "../use-properties";
import { useCellAutoEdit } from "./use-cell-auto-edit";

export function ToggleCell(props: CellProps): JSX.Element {
	const { property, value, onChange, readOnly, autoEdit, onAutoEditHandled } = props;
	const { labels } = usePropertyUiSeams();
	if (property.valueType !== ValueType.Boolean) {
		throw new Error(`ToggleCell registered against ${property.valueType}; expected Boolean`);
	}
	const checked = value === true;

	const onToggle = useCallback(() => {
		if (!readOnly) onChange(!checked as never);
	}, [checked, onChange, readOnly]);

	// Keyboard Enter-to-edit (12.4): a Boolean cell has no editor to open — its
	// "begin editing" action IS the flip. Fires once per rising edge.
	useCellAutoEdit(autoEdit, readOnly, onToggle, onAutoEditHandled);

	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={readOnly}
			className={checked ? "bs-cell-toggle bs-cell-toggle--on" : "bs-cell-toggle"}
			onClick={onToggle}
			aria-label={labels.cellToggleValueFor(property.name)}
		>
			<span className="bs-cell-toggle-knob" aria-hidden="true" />
		</button>
	);
}
