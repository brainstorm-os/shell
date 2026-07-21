/**
 * FormattedCell — the single Text scalar cell (Pill / Plain). For the
 * `text + format` kinds (Url / Email / Phone) an invalid value paints a
 * red border and exposes the reason via `title`. `mode` picks the
 * resting chrome: Pill (chip) or Plain (inline text).
 */

import { type CellProps, PropertyFormat } from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { coerceValue } from "../../properties-validate";
import type { PropertyUiLabels } from "../seams";
import { usePropertyUiSeams } from "../use-properties";
import { formatScalar, isValidFormatted, parseScalar } from "./format";
import { InlineEditInput } from "./inline-edit-input";
import { useCellAutoEdit } from "./use-cell-auto-edit";
import { closeValueCombobox, openValueCombobox } from "./value-combobox";

export enum FormattedMode {
	Pill = "pill",
	Plain = "plain",
}

function invalidMessage(
	format: PropertyFormat | undefined,
	labels: PropertyUiLabels,
): string | undefined {
	switch (format) {
		case PropertyFormat.Url:
			return labels.formatInvalidUrl;
		case PropertyFormat.Email:
			return labels.formatInvalidEmail;
		case PropertyFormat.Phone:
			return labels.formatInvalidPhone;
		default:
			return undefined;
	}
}

function makeFormattedCell(mode: FormattedMode) {
	return function FormattedCell(props: CellProps): JSX.Element {
		const { property, value, onChange, readOnly, autoEdit, onAutoEditHandled, suggestions } = props;
		const { labels } = usePropertyUiSeams();
		const [editing, setEditing] = useState(false);
		// Sticky: once a combobox open fails (no menu host mounted) this cell
		// falls back to the inline input for the rest of its life.
		const [comboUnavailable, setComboUnavailable] = useState(false);
		const buttonRef = useRef<HTMLButtonElement>(null);
		useCellAutoEdit(autoEdit, readOnly, () => setEditing(true), onAutoEditHandled);
		const display = formatScalar(property, value);
		const invalid = !isValidFormatted(property.format, display);
		const invalidMsg = invalid ? invalidMessage(property.format, labels) : undefined;

		const onCommit = useCallback(
			(raw: string) => {
				onChange(coerceValue(property, parseScalar(property, raw)) as never);
				setEditing(false);
			},
			[property, onChange],
		);

		// Select-like text column (existing distinct values, no catalog
		// vocabulary): edit as a type-or-pick combobox over those values instead
		// of a bare text field. Plain free-text columns get no suggestions and so
		// keep the inline input below.
		const hasSuggestions = !readOnly && (suggestions?.length ?? 0) > 0;
		const comboEditing = editing && hasSuggestions && !comboUnavailable;
		// The open-effect must depend ONLY on `comboEditing` (the open↔close
		// transition). `onCommit` is a fresh identity every render (the host's
		// `onChange` is an inline arrow) and `suggestions` is a fresh array every
		// view recompile, so listing them would re-run the effect on unrelated
		// re-renders — and its cleanup closes the picker (→ `onClose` →
		// `setEditing(false)`), aborting the edit mid-interaction (live vault data
		// re-renders the row constantly). Read the latest values through a ref so
		// the picker opens once per edit and only closes when editing truly ends.
		const comboRef = useRef({ display, suggestions, labels, property, onCommit });
		comboRef.current = { display, suggestions, labels, property, onCommit };
		useEffect(() => {
			if (!comboEditing) return;
			const anchor = buttonRef.current;
			if (!anchor) return;
			const c = comboRef.current;
			const opened = openValueCombobox({
				anchor,
				current: c.display,
				suggestions: c.suggestions ?? [],
				placeholder: c.labels.tagSearchPlaceholder,
				ariaLabel: c.labels.cellEditValueFor(c.property.name),
				useTypedLabel: (q) => c.labels.tagCreate?.(q) ?? `"${q}"`,
				onCommit: c.onCommit,
				onClose: () => setEditing(false),
			});
			if (!opened) {
				setComboUnavailable(true);
				return;
			}
			return () => closeValueCombobox();
		}, [comboEditing]);

		const base = mode === FormattedMode.Pill ? "bs-cell-pill" : "bs-cell-plain";

		if (editing && !readOnly && (!hasSuggestions || comboUnavailable)) {
			const inputClass = mode === FormattedMode.Pill ? "bs-cell-input" : "bs-cell-plain-input";
			return (
				<InlineEditInput
					initialValue={display}
					className={invalid ? `${inputClass} ${inputClass}--invalid` : inputClass}
					ariaLabel={labels.cellEditValueFor(property.name)}
					onCommit={onCommit}
					onCancel={() => setEditing(false)}
				/>
			);
		}

		const cls = [
			base,
			display.length === 0 ? `${base}--empty` : "",
			invalid ? `${base}--invalid` : "",
		]
			.filter(Boolean)
			.join(" ");

		return (
			<button
				ref={buttonRef}
				type="button"
				className={cls}
				onClick={() => !readOnly && setEditing(true)}
				disabled={readOnly}
				aria-invalid={invalid || undefined}
				aria-expanded={comboEditing || undefined}
				title={invalidMsg}
				aria-label={
					invalidMsg
						? `${labels.cellEditValueFor(property.name)} — ${invalidMsg}`
						: labels.cellEditValueFor(property.name)
				}
			>
				<span className={mode === FormattedMode.Pill ? "bs-cell-pill-text" : undefined}>
					{display.length === 0 ? labels.cellEmpty : display}
				</span>
			</button>
		);
	};
}

export const FormattedPillCell = makeFormattedCell(FormattedMode.Pill);
export const FormattedPlainCell = makeFormattedCell(FormattedMode.Plain);
