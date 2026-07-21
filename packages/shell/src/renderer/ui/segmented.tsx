/**
 * Segmented control — the design-system primitive for a radio-group
 * rendered as a row of pill buttons (Privacy mode picker, Feedback kind /
 * sensitivity, future surface filters). Consolidates the previously
 * per-panel chrome (`.network-egress__segmented`, `.feedback-dialog__
 * segmented`) so focus, hover, and active state stay consistent.
 *
 * Pattern (per +):
 *   - A horizontal `radiogroup` via `useCompositeKeyboard` — ←/→/Home/End move
 *     the roving cursor and select (selection follows focus), `aria-checked`
 *     marks the active option. Roles flow through the hook, not literals.
 *   - `:focus-visible` triggers the focus chrome — outline replaces
 *     border ("sandwich" anti-pattern banned).
 */

import { Orientation, SelectionAttribute, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import type { ReactNode } from "react";
import "./segmented.css";

export type SegmentedOption<T extends string> = {
	readonly value: T;
	readonly label: ReactNode;
	readonly testId?: string;
};

export type SegmentedProps<T extends string> = {
	readonly value: T;
	readonly onChange: (next: T) => void;
	readonly options: readonly SegmentedOption<T>[];
	readonly "data-testid"?: string;
	readonly "aria-label"?: string;
};

export function Segmented<T extends string>({
	value,
	onChange,
	options,
	"data-testid": testId,
	"aria-label": ariaLabel,
}: SegmentedProps<T>) {
	// Horizontal radiogroup: ←/→/Home/End move + select (selection follows
	// focus), roving tabindex, `aria-checked` via the hook — so the role flows
	// through `useCompositeKeyboard` rather than a hand-written `role` literal.
	const selectIndex = (index: number) => {
		const option = options[index];
		if (option) onChange(option.value);
	};
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: options.length,
		activeIndex: options.findIndex((option) => option.value === value),
		onActiveIndexChange: selectIndex,
		onActivate: selectIndex,
		role: "radiogroup",
		itemRole: "radio",
		selectionAttribute: SelectionAttribute.AriaChecked,
	});
	return (
		<div
			className="segmented"
			{...containerProps}
			{...(testId ? { "data-testid": testId } : {})}
			{...(ariaLabel ? { "aria-label": ariaLabel } : {})}
		>
			{options.map((option, index) => {
				const active = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						{...getItemProps(index)}
						className={active ? "segmented__item segmented__item--active" : "segmented__item"}
						onClick={() => onChange(option.value)}
						{...(option.testId ? { "data-testid": option.testId } : {})}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
