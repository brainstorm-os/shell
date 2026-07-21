/**
 * Multi-select action bar (React) — floats over the view while one or more
 * owned events are selected (Cmd/Ctrl-click a chip). "Reschedule…" opens the
 * bulk-move popover; "Clear" drops the selection. Roving cursor across the
 * two actions via the shared composite toolbar binding.
 */

import { Orientation, SelectionAttribute, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { useState } from "react";
import { t } from "../../i18n/t";

export type SelectionBarProps = {
	count: number;
	onReschedule(): void;
	onClear(): void;
};

export function SelectionBar({ count, onReschedule, onClear }: SelectionBarProps) {
	const [cursor, setCursor] = useState(0);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		role: "toolbar",
		selectionAttribute: SelectionAttribute.None,
		count: 2,
		activeIndex: cursor,
		onActiveIndexChange: setCursor,
	});

	return (
		<div className="cal-selection-bar glass--strong" {...containerProps}>
			<span className="cal-selection-bar__count">{t("calendar.selection.count", { count })}</span>
			<button
				type="button"
				className="cal-selection-bar__action"
				data-bs-primary=""
				onClick={onReschedule}
				{...getItemProps(0)}
			>
				{t("calendar.selection.reschedule")}
			</button>
			<button
				type="button"
				className="cal-selection-bar__action cal-selection-bar__action--ghost"
				onClick={onClear}
				{...getItemProps(1)}
			>
				{t("calendar.selection.clear")}
			</button>
		</div>
	);
}
