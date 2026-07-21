/**
 * Shared single-select radiogroup for the event-detail status + colour
 * pickers. Roving cursor across the options via the shared composite binding
 * (role: radiogroup / radio); standard radio behaviour — arrow moves AND
 * selects, Enter / click commits. The cursor starts on the selected option.
 * `aria-checked` reflects the selected value (owned here).
 */

import { Orientation, SelectionAttribute, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import type { ReactNode } from "react";
import { useState } from "react";

export type RadioOption<T> = {
	value: T;
	className: string;
	label: string;
	dataset?: Record<string, string>;
	style?: Record<string, string>;
	children?: ReactNode;
};

export type RadioGroupProps<T> = {
	className: string;
	ariaLabel: string;
	options: ReadonlyArray<RadioOption<T>>;
	value: T;
	onChange(value: T): void;
};

export function RadioGroup<T>({
	className,
	ariaLabel,
	options,
	value,
	onChange,
}: RadioGroupProps<T>) {
	const selectedIndex = Math.max(
		0,
		options.findIndex((o) => o.value === value),
	);
	const [cursor, setCursor] = useState(selectedIndex);

	const selectAt = (i: number): void => {
		const option = options[i];
		if (option) onChange(option.value);
	};

	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		role: "radiogroup",
		itemRole: "radio",
		selectionAttribute: SelectionAttribute.None,
		count: options.length,
		activeIndex: cursor,
		onActiveIndexChange: (i) => {
			setCursor(i);
			selectAt(i);
		},
		onActivate: (i) => {
			setCursor(i);
			selectAt(i);
		},
	});

	return (
		<div className={className} aria-label={ariaLabel} {...containerProps}>
			{options.map((option, index) => {
				const selected = option.value === value;
				return (
					<button
						key={String(option.value)}
						type="button"
						className={option.className}
						aria-checked={selected}
						data-selected={String(selected)}
						aria-label={option.label}
						title={option.label}
						{...(option.dataset ?? {})}
						style={option.style as React.CSSProperties | undefined}
						onClick={() => {
							setCursor(index);
							onChange(option.value);
						}}
						{...getItemProps(index)}
					>
						{option.children}
					</button>
				);
			})}
		</div>
	);
}
