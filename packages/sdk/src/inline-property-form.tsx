/**
 * `<InlinePropertyForm>` — the shared light-touch property constructor.
 *
 * Used wherever an app surface needs to mint a fresh `PropertyDef`
 * inline: Notes' "+ Create new property" entry in the AddPropertyMenu,
 * the upcoming Database column-add flow, the future Graph
 * subject-property picker. The shell's Settings → Data tab keeps its
 * own richer constructor (icons, descriptions, vocabulary editing) —
 * this one is the trimmed in-app version: name + kind tile + (text
 * format | multi toggle) + Create.
 *
 * Consumers wire two seams:
 *   - `labels`: every user-visible string in the chrome. The host
 *     wraps each one in its own `t()` helper and passes the result.
 *   - `onCommit`: receives the validated `{ def, dictionary }` pair.
 *     The host writes them to the vault stores (or the SDK service)
 *     in whatever order it prefers (typically dictionary → def so the
 *     def's `vocabulary.dictionaryId` resolves), then attaches the
 *     new property to whichever entity / block triggered the open.
 *
 * Styling is self-contained: a single `<style>` block is injected
 * into the host document on first mount and dedup'd via a `data-bs`
 * marker. Class names are prefixed `bs-inline-property-form__*` to
 * stay out of the host's namespace. The component reads design tokens
 * from `:root` (apps inherit the shell's flattened tokens per the
 * `apps_inherit_shell_theme` convention) so theming "just works".
 */

import type { Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import { CaretLeft } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { InlinePropertyFormLabels } from "./i18n/common-labels";
import {
	DEFAULT_CURRENCY_CODE,
	INLINE_CURRENCY_CODES,
	INLINE_NUMBER_FORMAT_ORDER,
	INLINE_PRIMARY_KIND_ORDER,
	INLINE_TEXT_FORMAT_ORDER,
	InlineNumberFormat,
	InlinePrimaryKind,
	InlineTextFormat,
	type RelationTargetType,
	draftInlineProperty,
	parseSelectOptions,
	supportsMultiToggle,
	supportsNumberFormat,
	supportsTextFormat,
} from "./inline-property-form-logic";
import { SelectMenu } from "./select-menu";

export type { InlinePropertyFormLabels } from "./i18n/common-labels";

export type InlinePropertyFormCommit = {
	def: PropertyDef;
	dictionary: Dictionary | null;
};

export type InlinePropertyFormProps = {
	labels: InlinePropertyFormLabels;
	onCommit: (commit: InlinePropertyFormCommit) => void | Promise<void>;
	onCancel: () => void;
	/** Auto-focus the name input on mount (the typical menu-popover
	 *  case). Default `true`; tests + composite surfaces pass `false`
	 *  if they own focus management. */
	autoFocus?: boolean;
	/** Entity types a Relation can target. When supplied, the Relation kind
	 *  surfaces a "Links to" picker (Any + each type) that pins the def's
	 *  `allowedTypes`. Hosts pass their own vault types; omitting the prop
	 *  keeps the prior link-to-anything behaviour (no picker shown). */
	relationTargetTypes?: readonly RelationTargetType[];
};

export function InlinePropertyForm({
	labels,
	onCommit,
	onCancel,
	autoFocus = true,
	relationTargetTypes,
}: InlinePropertyFormProps): ReactNode {
	useInjectedStyles();

	const nameRef = useRef<HTMLInputElement | null>(null);
	const [name, setName] = useState("");
	const [primary, setPrimary] = useState<InlinePrimaryKind>(InlinePrimaryKind.Text);
	const [textFormat, setTextFormat] = useState<InlineTextFormat>(InlineTextFormat.Plain);
	const [numberFormat, setNumberFormat] = useState<InlineNumberFormat>(InlineNumberFormat.Plain);
	const [currency, setCurrency] = useState<string>(DEFAULT_CURRENCY_CODE);
	const [optionsText, setOptionsText] = useState("");
	const [formulaExpression, setFormulaExpression] = useState("");
	// "" = link to anything (no allowedTypes); a type string pins the relation.
	const [targetType, setTargetType] = useState<string>("");
	const [multi, setMulti] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const errorId = useId();

	useEffect(() => {
		if (autoFocus) {
			nameRef.current?.focus();
		}
	}, [autoFocus]);

	const KIND_LABEL: Record<InlinePrimaryKind, string> = useMemo(
		() => ({
			[InlinePrimaryKind.Text]: labels.kindText,
			[InlinePrimaryKind.Number]: labels.kindNumber,
			[InlinePrimaryKind.Boolean]: labels.kindBoolean,
			[InlinePrimaryKind.Date]: labels.kindDate,
			[InlinePrimaryKind.Select]: labels.kindSelect,
			[InlinePrimaryKind.Relation]: labels.kindRelation,
			[InlinePrimaryKind.File]: labels.kindFile,
			[InlinePrimaryKind.Formula]: labels.kindFormula,
		}),
		[labels],
	);

	const FORMAT_LABEL: Record<InlineTextFormat, string> = useMemo(
		() => ({
			[InlineTextFormat.Plain]: labels.formatPlain,
			[InlineTextFormat.Url]: labels.formatUrl,
			[InlineTextFormat.Email]: labels.formatEmail,
			[InlineTextFormat.Phone]: labels.formatPhone,
		}),
		[labels],
	);

	const NUMBER_FORMAT_LABEL: Record<InlineNumberFormat, string> = useMemo(
		() => ({
			[InlineNumberFormat.Plain]: labels.formatPlain,
			[InlineNumberFormat.Currency]: labels.formatCurrency,
			[InlineNumberFormat.Percent]: labels.formatPercent,
			[InlineNumberFormat.Duration]: labels.formatDuration,
		}),
		[labels],
	);

	const showRelationTarget =
		primary === InlinePrimaryKind.Relation &&
		relationTargetTypes !== undefined &&
		relationTargetTypes.length > 0;

	const submit = async (): Promise<void> => {
		if (submitting) return;
		const result = draftInlineProperty({
			name,
			primary,
			textFormat,
			multi,
			numberFormat,
			currency,
			options: parseSelectOptions(optionsText),
			allowedTypes: targetType.length > 0 ? [targetType] : [],
			formulaExpression,
		});
		if (!result.ok) {
			setError(result.errors[0] ?? "invalid property");
			return;
		}
		setError(null);
		setSubmitting(true);
		try {
			await onCommit(result.value);
		} catch (err) {
			setSubmitting(false);
			setError(err instanceof Error ? err.message : String(err));
			return;
		}
	};

	return (
		<form
			className="bs-inline-property-form"
			role="region"
			aria-label={labels.region}
			onMouseDown={(event) => event.preventDefault()}
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div className="bs-inline-property-form__header">
				<button
					type="button"
					className="bs-inline-property-form__back"
					aria-label={labels.back}
					onClick={onCancel}
				>
					<BackGlyph />
				</button>
				<div className="bs-inline-property-form__title">{labels.region}</div>
			</div>

			<label className="bs-inline-property-form__field">
				<span className="bs-inline-property-form__field-label">{labels.nameLabel}</span>
				<input
					ref={nameRef}
					type="text"
					className="bs-inline-property-form__name"
					value={name}
					placeholder={labels.namePlaceholder}
					aria-invalid={error !== null}
					aria-describedby={error ? errorId : undefined}
					onChange={(event) => {
						setName(event.target.value);
						if (error) setError(null);
					}}
				/>
			</label>

			<fieldset className="bs-inline-property-form__field">
				<legend className="bs-inline-property-form__field-label">{labels.kindLabel}</legend>
				<div className="bs-inline-property-form__tiles">
					{INLINE_PRIMARY_KIND_ORDER.map((kind) => {
						const active = kind === primary;
						return (
							<button
								key={kind}
								type="button"
								className={
									active
										? "bs-inline-property-form__tile bs-inline-property-form__tile--active"
										: "bs-inline-property-form__tile"
								}
								aria-pressed={active}
								onClick={() => setPrimary(kind)}
							>
								{KIND_LABEL[kind]}
							</button>
						);
					})}
				</div>
			</fieldset>

			{supportsTextFormat(primary) && (
				<fieldset className="bs-inline-property-form__field">
					<legend className="bs-inline-property-form__field-label">{labels.formatLabel}</legend>
					<div className="bs-inline-property-form__formats">
						{INLINE_TEXT_FORMAT_ORDER.map((fmt) => {
							const active = fmt === textFormat;
							return (
								<button
									key={fmt}
									type="button"
									className={
										active
											? "bs-inline-property-form__tile bs-inline-property-form__tile--active"
											: "bs-inline-property-form__tile"
									}
									aria-pressed={active}
									onClick={() => setTextFormat(fmt)}
								>
									{FORMAT_LABEL[fmt]}
								</button>
							);
						})}
					</div>
				</fieldset>
			)}

			{supportsNumberFormat(primary) && (
				<fieldset className="bs-inline-property-form__field">
					<legend className="bs-inline-property-form__field-label">{labels.formatLabel}</legend>
					<div className="bs-inline-property-form__formats bs-inline-property-form__formats--three">
						{INLINE_NUMBER_FORMAT_ORDER.map((fmt) => {
							const active = fmt === numberFormat;
							return (
								<button
									key={fmt}
									type="button"
									className={
										active
											? "bs-inline-property-form__tile bs-inline-property-form__tile--active"
											: "bs-inline-property-form__tile"
									}
									aria-pressed={active}
									onClick={() => setNumberFormat(fmt)}
								>
									{NUMBER_FORMAT_LABEL[fmt]}
								</button>
							);
						})}
					</div>
					{numberFormat === InlineNumberFormat.Currency && (
						<div className="bs-inline-property-form__field">
							<span className="bs-inline-property-form__field-label">{labels.currencyLabel}</span>
							<SelectMenu
								className="bs-inline-property-form__select"
								ariaLabel={labels.currencyLabel}
								value={currency}
								options={INLINE_CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
								onChange={setCurrency}
							/>
						</div>
					)}
				</fieldset>
			)}

			{primary === InlinePrimaryKind.Select && (
				<label className="bs-inline-property-form__field">
					<span className="bs-inline-property-form__field-label">{labels.optionsLabel}</span>
					<textarea
						className="bs-inline-property-form__options"
						value={optionsText}
						placeholder={labels.optionsPlaceholder}
						rows={3}
						onChange={(event) => setOptionsText(event.target.value)}
					/>
					<span className="bs-inline-property-form__hint">{labels.optionsHint}</span>
				</label>
			)}

			{primary === InlinePrimaryKind.Formula && (
				<label className="bs-inline-property-form__field">
					<span className="bs-inline-property-form__field-label">{labels.formulaLabel}</span>
					<textarea
						className="bs-inline-property-form__options bs-inline-property-form__formula"
						value={formulaExpression}
						placeholder={labels.formulaPlaceholder}
						rows={2}
						spellCheck={false}
						onChange={(event) => setFormulaExpression(event.target.value)}
					/>
					<span className="bs-inline-property-form__hint">{labels.formulaHint}</span>
				</label>
			)}

			{showRelationTarget && relationTargetTypes && (
				<div className="bs-inline-property-form__field">
					<span className="bs-inline-property-form__field-label">{labels.relationTargetLabel}</span>
					<SelectMenu
						className="bs-inline-property-form__select"
						ariaLabel={labels.relationTargetLabel}
						value={targetType}
						options={[
							{ value: "", label: labels.relationTargetAny },
							...relationTargetTypes.map((opt) => ({ value: opt.type, label: opt.label })),
						]}
						onChange={setTargetType}
					/>
				</div>
			)}

			{supportsMultiToggle(primary) && (
				<label className="bs-inline-property-form__multi">
					<input type="checkbox" checked={multi} onChange={(event) => setMulti(event.target.checked)} />
					<span>{labels.multiLabel}</span>
				</label>
			)}

			{error && (
				<div id={errorId} className="bs-inline-property-form__error" role="alert">
					{error}
				</div>
			)}

			{labels.moreOptionsHint && (
				<div className="bs-inline-property-form__hint">{labels.moreOptionsHint}</div>
			)}

			<div className="bs-inline-property-form__actions">
				<button
					type="button"
					className="bs-inline-property-form__action"
					onClick={onCancel}
					disabled={submitting}
				>
					{labels.cancel}
				</button>
				<button
					type="submit"
					className="bs-inline-property-form__action bs-inline-property-form__action--primary"
					disabled={submitting || name.trim().length === 0}
				>
					{labels.submit}
				</button>
			</div>
		</form>
	);
}

function BackGlyph(): ReactNode {
	return <CaretLeft size={14} />;
}

const STYLE_ELEMENT_ID = "bs-inline-property-form-styles";

const STYLES = `
.bs-inline-property-form {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 10px;
	min-width: 0;
	box-sizing: border-box;
}
.bs-inline-property-form *, .bs-inline-property-form *::before, .bs-inline-property-form *::after {
	box-sizing: border-box;
}
.bs-inline-property-form__header {
	display: grid;
	grid-template-columns: 24px 1fr;
	align-items: center;
	gap: 6px;
}
.bs-inline-property-form__back {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	border: 0;
	border-radius: 6px;
	background: transparent;
	color: var(--text-dim, #888);
	cursor: pointer;
}
.bs-inline-property-form__back:hover {
	background: var(--hover, rgba(127,127,127,0.1));
	color: var(--color-text-primary, var(--text, inherit));
}
.bs-inline-property-form__title {
	font-size: var(--text-size-md, 14px);
	font-weight: 600;
	color: var(--text-dim, #666);
}
.bs-inline-property-form__field {
	display: flex;
	flex-direction: column;
	gap: 4px;
	border: 0;
	padding: 0;
	margin: 0;
}
.bs-inline-property-form__field-label {
	font-size: var(--text-size-xs, 12px);
	color: var(--text-faint, #999);
	text-transform: uppercase;
	letter-spacing: 0.04em;
	padding: 0;
}
.bs-inline-property-form__name {
	width: 100%;
	height: 28px;
	padding: 0 8px;
	border: 1px solid var(--color-border-subtle, var(--border, rgba(127,127,127,0.25)));
	border-radius: 6px;
	background: var(--bg-elev, transparent);
	color: var(--color-text-primary, var(--text, inherit));
	font: inherit;
	font-size: var(--text-size-md, 14px);
	outline: none;
	transition: border-color 100ms ease, background 100ms ease;
}
.bs-inline-property-form__name:focus {
	border-color: transparent;
	outline: 2px solid color-mix(in srgb, var(--color-focus-ring) 60%, transparent);
	outline-offset: -1px;
	background: var(--bg, transparent);
}
.bs-inline-property-form__name::placeholder {
	color: var(--text-faint, #999);
}
.bs-inline-property-form__options {
	width: 100%;
	min-height: 56px;
	padding: 6px 8px;
	border: 1px solid var(--color-border-subtle, var(--border, rgba(127,127,127,0.25)));
	border-radius: 6px;
	background: var(--bg-elev, transparent);
	color: var(--color-text-primary, var(--text, inherit));
	font: inherit;
	font-size: var(--text-size-md, 14px);
	line-height: 1.4;
	resize: vertical;
	outline: none;
	transition: border-color 100ms ease, background 100ms ease;
}
.bs-inline-property-form__options:focus {
	border-color: transparent;
	outline: 2px solid color-mix(in srgb, var(--color-focus-ring) 60%, transparent);
	outline-offset: -1px;
	background: var(--bg, transparent);
}
.bs-inline-property-form__options::placeholder {
	color: var(--text-faint, #999);
}
.bs-inline-property-form__formula {
	font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
	min-height: 40px;
}
.bs-inline-property-form__tiles {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 4px;
}
.bs-inline-property-form__formats {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: 4px;
}
.bs-inline-property-form__formats--three {
	grid-template-columns: repeat(3, 1fr);
}
/* Face (border / background / caret / focus) comes from the shared
   .bs-select control — only the form's width + 28px density live here. */
.bs-inline-property-form__select {
	width: 100%;
	height: 28px;
}
.bs-inline-property-form__tile {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 28px;
	padding: 0 6px;
	border: 1px solid var(--color-border-subtle, var(--border, rgba(127,127,127,0.25)));
	border-radius: 6px;
	background: var(--bg-elev, transparent);
	color: var(--color-text-primary, var(--text, inherit));
	font: inherit;
	font-size: var(--text-size-md, 14px);
	cursor: pointer;
	transition: background 100ms ease, border-color 100ms ease;
}
.bs-inline-property-form__tile:hover {
	background: var(--hover, rgba(127,127,127,0.1));
}
.bs-inline-property-form__tile--active {
	border-color: transparent;
	background: color-mix(in srgb, var(--color-accent-default, var(--accent, #6b73f0)) 18%, var(--bg-elev, transparent));
	color: var(--color-accent-on-surface, var(--accent, #6b73f0));
	outline: 1px solid color-mix(in srgb, var(--color-accent-default, var(--accent, #6b73f0)) 60%, transparent);
	outline-offset: -1px;
}
.bs-inline-property-form__multi {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: var(--text-size-md, 14px);
	color: var(--color-text-primary, var(--text, inherit));
	cursor: pointer;
}
.bs-inline-property-form__multi input {
	cursor: pointer;
}
.bs-inline-property-form__error {
	font-size: var(--text-size-xs, 12px);
	color: var(--color-state-warning, #c2410c);
}
.bs-inline-property-form__hint {
	font-size: var(--text-size-xs, 12px);
	color: var(--text-faint, #999);
	line-height: 1.4;
}
.bs-inline-property-form__actions {
	display: flex;
	justify-content: flex-end;
	gap: 6px;
	padding-top: 4px;
	border-top: 1px solid var(--color-border-subtle, var(--border, rgba(127,127,127,0.25)));
}
.bs-inline-property-form__action {
	height: 26px;
	padding: 0 10px;
	border: 1px solid var(--color-border-subtle, var(--border, rgba(127,127,127,0.25)));
	border-radius: 6px;
	background: var(--bg-elev, transparent);
	color: var(--color-text-primary, var(--text, inherit));
	font: inherit;
	font-size: var(--text-size-md, 14px);
	cursor: pointer;
}
.bs-inline-property-form__action:hover:not([disabled]) {
	background: var(--hover, rgba(127,127,127,0.1));
}
.bs-inline-property-form__action--primary {
	border-color: transparent;
	background: var(--color-accent-default, var(--accent, #6b73f0));
	color: var(--accent-fg, #fff);
}
.bs-inline-property-form__action--primary:hover:not([disabled]) {
	background: color-mix(in srgb, var(--color-accent-default, var(--accent, #6b73f0)) 88%, black);
}
.bs-inline-property-form__action[disabled] {
	cursor: not-allowed;
	opacity: 0.5;
}
`;

function useInjectedStyles(): void {
	useEffect(() => {
		if (typeof document === "undefined") return;
		if (document.getElementById(STYLE_ELEMENT_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ELEMENT_ID;
		style.textContent = STYLES;
		document.head.appendChild(style);
		// Intentionally don't remove on unmount — the styles are static
		// and the next consumer mount would have to re-inject. Cheap +
		// idempotent via the id check above.
	}, []);
}
