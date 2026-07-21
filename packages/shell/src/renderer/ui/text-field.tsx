/**
 * TextField / TextArea / Select — the design-system primitives for every
 * bordered text-entry / dropdown surface in the shell. Mirrors `Button` /
 * `IconButton`: every consumer goes through this primitive so that the
 * focus, border, hint, and counter chrome stay consistent.
 *
 * Why these exist: focus styles on bordered inputs were rolled per panel
 * (`network-egress-panel`, `feedback-dialog`, `settings`, `welcome`,
 * `cheatsheet`, `help`) and drifted — `:focus` vs `:focus-visible`,
 * `--color-accent` vs `--color-focus-ring` vs `--color-border-focus`, no
 * rule at all in some places. The result: focused inputs lost their
 * border with no visible ring to replace it.
 *
 * Canonical pattern (per `feedback_focus_outline_replaces_border` memory
 * and):
 *   - `:focus-visible` triggers the focus chrome.
 *   - `outline: 2px solid var(--color-focus-ring); outline-offset: -1px;
 *     border-color: transparent;` — ring SITS where the border was,
 *     never stacks outside it ("sandwich" anti-pattern).
 *
 * Size: a single bordered chrome height (28px Sm / 32px Md) used everywhere;
 * adding a one-off size requires a new variant, not a per-panel override.
 */

import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import { forwardRef, useId } from "react";
import { Icon, type IconName } from "./icon";
import "./text-field.css";

export enum TextFieldSize {
	Sm = "sm",
	Md = "md",
	/** 40px — the onboarding/hero scale (pairs with `ButtonSize.Lg`). */
	Lg = "lg",
}

type CommonProps = {
	/** Visible label rendered above the field. Omit to render the field
	 *  bare (e.g. embedded in a custom row). Required for accessibility
	 *  when no `aria-label` is given. */
	readonly label?: ReactNode;
	/** Right-aligned counter on the label row (e.g. `123 / 200`). Pass
	 *  the *whole* string the caller wants displayed; the primitive does
	 *  not derive it. */
	readonly counter?: ReactNode;
	/** Small hint below the field. */
	readonly hint?: ReactNode;
	/** Inline error below the field. Takes precedence over `hint`. */
	readonly error?: ReactNode;
	readonly size?: TextFieldSize;
	readonly disabled?: boolean;
	readonly required?: boolean;
	readonly name?: string;
	readonly id?: string;
	readonly "aria-label"?: string;
	readonly "data-testid"?: string;
};

export type TextFieldProps = CommonProps & {
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly type?: "text" | "email" | "search" | "url" | "tel" | "password" | "number" | "time";
	/** Numeric bounds/step, forwarded to the underlying `<input>`. Only
	 *  meaningful with `type="number"` — they let a constrained numeric field
	 *  (e.g. "keep the last N days") ride the shared face instead of dropping to
	 *  a hand-rolled `<input type=number>` just to get `min`/`max`. */
	readonly min?: number;
	readonly max?: number;
	readonly step?: number;
	readonly placeholder?: string;
	readonly maxLength?: number;
	readonly autoFocus?: boolean;
	readonly autoComplete?: string;
	readonly inputMode?: "text" | "search" | "email" | "url" | "tel" | "numeric" | "decimal";
	/** Opt out of spellcheck for non-prose content (commands, keys, origins) —
	 *  lets those fields ride the shared face instead of dropping to a raw
	 *  `<input>` just to silence the squiggles. */
	readonly spellCheck?: boolean;
	readonly onBlur?: () => void;
	/** Forwarded to the underlying `<input>` — e.g. a launcher search box that
	 *  hands focus into a results list on ArrowDown / launches on Enter. */
	readonly onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
	/** Optional leading icon (e.g. `Search` for filter inputs). */
	readonly iconLeft?: IconName;
};

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
	{
		label,
		counter,
		hint,
		error,
		size = TextFieldSize.Md,
		disabled,
		required,
		name,
		id,
		"aria-label": ariaLabel,
		"data-testid": dataTestId,
		value,
		onChange,
		type = "text",
		min,
		max,
		step,
		placeholder,
		maxLength,
		autoFocus,
		autoComplete,
		inputMode,
		spellCheck,
		onBlur,
		onKeyDown,
		iconLeft,
	},
	ref,
) {
	const reactId = useId();
	const fieldId = id ?? reactId;
	const hintId = hint || error ? `${fieldId}-hint` : undefined;
	const inputClass = iconLeft
		? "text-field__input text-field__input--with-icon"
		: "text-field__input";

	return (
		<div className={`text-field text-field--${size}`}>
			{(label !== undefined || counter !== undefined) && (
				<div className="text-field__label-row">
					{label !== undefined && (
						<label className="text-field__label" htmlFor={fieldId}>
							{label}
						</label>
					)}
					{counter !== undefined && (
						<span className="text-field__counter" aria-live="polite">
							{counter}
						</span>
					)}
				</div>
			)}
			<div className="text-field__control">
				{iconLeft && (
					<span className="text-field__icon" aria-hidden="true">
						<Icon name={iconLeft} size={14} />
					</span>
				)}
				<input
					ref={ref}
					id={fieldId}
					className={inputClass}
					type={type}
					value={value}
					aria-label={ariaLabel}
					onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
					// biome-ignore lint/a11y/noAutofocus: opt-in per consumer (e.g. a launcher search box)
					autoFocus={autoFocus ?? false}
					{...(onKeyDown ? { onKeyDown } : {})}
					{...(placeholder !== undefined ? { placeholder } : {})}
					{...(maxLength !== undefined ? { maxLength } : {})}
					{...(min !== undefined ? { min } : {})}
					{...(max !== undefined ? { max } : {})}
					{...(step !== undefined ? { step } : {})}
					{...(autoComplete !== undefined ? { autoComplete } : {})}
					{...(inputMode !== undefined ? { inputMode } : {})}
					{...(spellCheck !== undefined ? { spellCheck } : {})}
					{...(name !== undefined ? { name } : {})}
					{...(hintId ? { "aria-describedby": hintId } : {})}
					{...(error !== undefined ? { "aria-invalid": true } : {})}
					{...(dataTestId !== undefined ? { "data-testid": dataTestId } : {})}
					disabled={disabled ?? false}
					required={required ?? false}
					{...(onBlur ? { onBlur } : {})}
				/>
			</div>
			{error !== undefined ? (
				<small id={hintId} className="text-field__error">
					{error}
				</small>
			) : hint !== undefined ? (
				<small id={hintId} className="text-field__hint">
					{hint}
				</small>
			) : null}
		</div>
	);
});

export type TextAreaProps = CommonProps & {
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly placeholder?: string;
	readonly maxLength?: number;
	readonly rows?: number;
	readonly autoComplete?: string;
	/** Opt out of spellcheck for non-prose content (argv lines, config). */
	readonly spellCheck?: boolean;
	readonly resize?: "none" | "vertical" | "both";
};

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
	{
		label,
		counter,
		hint,
		error,
		size = TextFieldSize.Md,
		disabled,
		required,
		name,
		id,
		"aria-label": ariaLabel,
		"data-testid": dataTestId,
		value,
		onChange,
		placeholder,
		maxLength,
		rows = 6,
		autoComplete,
		spellCheck,
		resize = "vertical",
	},
	ref,
) {
	const reactId = useId();
	const fieldId = id ?? reactId;
	const hintId = hint || error ? `${fieldId}-hint` : undefined;

	return (
		<div className={`text-field text-field--${size}`}>
			{(label !== undefined || counter !== undefined) && (
				<div className="text-field__label-row">
					{label !== undefined && (
						<label className="text-field__label" htmlFor={fieldId}>
							{label}
						</label>
					)}
					{counter !== undefined && (
						<span className="text-field__counter" aria-live="polite">
							{counter}
						</span>
					)}
				</div>
			)}
			<textarea
				ref={ref}
				id={fieldId}
				className={`text-field__input text-field__input--textarea text-field__input--resize-${resize}`}
				value={value}
				aria-label={ariaLabel}
				onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
				rows={rows}
				{...(placeholder !== undefined ? { placeholder } : {})}
				{...(maxLength !== undefined ? { maxLength } : {})}
				{...(autoComplete !== undefined ? { autoComplete } : {})}
				{...(spellCheck !== undefined ? { spellCheck } : {})}
				{...(name !== undefined ? { name } : {})}
				{...(hintId ? { "aria-describedby": hintId } : {})}
				{...(error !== undefined ? { "aria-invalid": true } : {})}
				{...(dataTestId !== undefined ? { "data-testid": dataTestId } : {})}
				disabled={disabled ?? false}
				required={required ?? false}
			/>
			{error !== undefined ? (
				<small id={hintId} className="text-field__error">
					{error}
				</small>
			) : hint !== undefined ? (
				<small id={hintId} className="text-field__hint">
					{hint}
				</small>
			) : null}
		</div>
	);
});

export type SelectOption = {
	readonly value: string;
	readonly label: string;
};

export type SelectProps = CommonProps & {
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly options: readonly SelectOption[];
};

export function Select({
	label,
	hint,
	error,
	size = TextFieldSize.Md,
	disabled,
	id,
	"aria-label": ariaLabel,
	"data-testid": dataTestId,
	value,
	onChange,
	options,
}: SelectProps) {
	const reactId = useId();
	const fieldId = id ?? reactId;
	const hintId = hint || error ? `${fieldId}-hint` : undefined;
	// The trigger is a button — `htmlFor` still associates via the shared id,
	// but the accessible name comes from `ariaLabel` (a button has no
	// label-derived name), so fall back to the string label.
	const menuLabel = ariaLabel ?? (typeof label === "string" ? label : "");

	return (
		<div className={`text-field text-field--${size}`}>
			{label !== undefined && (
				<div className="text-field__label-row">
					<label className="text-field__label" htmlFor={fieldId}>
						{label}
					</label>
				</div>
			)}
			<SelectMenu
				id={fieldId}
				{...(size === TextFieldSize.Sm ? { className: "bs-select--sm" } : {})}
				value={value}
				options={options}
				onChange={onChange}
				ariaLabel={menuLabel}
				disabled={disabled ?? false}
				{...(dataTestId !== undefined ? { "data-testid": dataTestId } : {})}
			/>
			{error !== undefined ? (
				<small id={hintId} className="text-field__error">
					{error}
				</small>
			) : hint !== undefined ? (
				<small id={hintId} className="text-field__hint">
					{hint}
				</small>
			) : null}
		</div>
	);
}
