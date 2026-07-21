/**
 * Checkbox — the design-system primitive for a labelled checkbox. A visually
 * hidden native `<input>` carries semantics / keyboard / focus, while a painted
 * box (`CheckboxGlyph`) mirrors the state with a spring pop + an animated SVG
 * tick. State is prop-driven (not the input's `:checked` pseudo) so the same
 * glyph can render in a controlled / decorative context — e.g. the Bin's
 * listbox rows, where selection is announced by the option's `aria-selected`.
 *
 * Consolidates the previously per-panel chrome (`.feedback-dialog__check`,
 * `.network-egress__check`) so the label-row gap, alignment, and focus ring
 * stay consistent. Supports `indeterminate` (tri-state, e.g. a select-all).
 */

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
// Chrome is the shared SDK sheet (`@brainstorm-os/sdk/checkbox/checkbox.css`),
// imported once in `main.tsx` so the shell and every app share one definition.

export type CheckboxProps = {
	readonly checked: boolean;
	readonly onChange: (next: boolean) => void;
	/** Visible label. Omit for an icon-only checkbox (pair with `ariaLabel`). */
	readonly label?: ReactNode;
	/** Accessible name when there is no visible `label`. */
	readonly ariaLabel?: string;
	/** Id of an element describing this checkbox (e.g. a helper-text `<p>`), so
	 *  screen readers announce it alongside the label via `aria-describedby`. */
	readonly describedById?: string;
	/** Tri-state: paints the dash and sets the native input's `indeterminate`. */
	readonly indeterminate?: boolean;
	readonly disabled?: boolean;
	readonly tabIndex?: number;
	readonly "data-testid"?: string;
};

/** The painted box + tick / dash, driven purely by props. Decorative
 *  (`aria-hidden`) — the surrounding control owns the accessible state. */
export function CheckboxGlyph({
	checked,
	indeterminate = false,
}: {
	readonly checked: boolean;
	readonly indeterminate?: boolean;
}) {
	let className = "checkbox__box";
	if (indeterminate) className += " checkbox__box--indeterminate";
	else if (checked) className += " checkbox__box--checked";
	return (
		<span className={className} aria-hidden="true">
			<svg className="checkbox__check" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<path
					d="M5 13l4 4L19 7"
					stroke="currentColor"
					strokeWidth={3}
					strokeLinecap="round"
					strokeLinejoin="round"
					pathLength={1}
				/>
			</svg>
			<span className="checkbox__dash" />
		</span>
	);
}

export function Checkbox({
	checked,
	onChange,
	label,
	ariaLabel,
	describedById,
	indeterminate = false,
	disabled = false,
	tabIndex,
	"data-testid": testId,
}: CheckboxProps) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	// `indeterminate` is a DOM property, not an attribute — set it imperatively.
	useEffect(() => {
		if (inputRef.current) inputRef.current.indeterminate = indeterminate;
	}, [indeterminate]);

	// Reflect the click immediately rather than waiting for an async `onChange`
	// write to round-trip back through the prop. The prop stays the source of
	// truth — this local mirror reconciles to it whenever `checked` changes — but
	// the box no longer reads as "unclickable" while the write is in flight (or
	// when a stale, un-restarted main process never pushes the new value at all).
	const [optimistic, setOptimistic] = useState(checked);
	useEffect(() => setOptimistic(checked), [checked]);
	const toggle = (next: boolean) => {
		setOptimistic(next);
		onChange(next);
	};

	const className = disabled ? "checkbox checkbox--disabled" : "checkbox";
	return (
		<label className={className}>
			<input
				ref={inputRef}
				type="checkbox"
				className="checkbox__input"
				checked={optimistic}
				disabled={disabled}
				onChange={(event) => toggle(event.target.checked)}
				{...(ariaLabel ? { "aria-label": ariaLabel } : {})}
				{...(describedById ? { "aria-describedby": describedById } : {})}
				{...(tabIndex !== undefined ? { tabIndex } : {})}
				{...(testId ? { "data-testid": testId } : {})}
			/>
			<CheckboxGlyph checked={optimistic} indeterminate={indeterminate} />
			{label != null ? <span className="checkbox__label">{label}</span> : null}
		</label>
	);
}
