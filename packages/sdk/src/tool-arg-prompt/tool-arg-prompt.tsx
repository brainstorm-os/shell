/**
 * `<ToolArgumentPrompt>` + `useToolArgumentPrompt` — the argument prompt
 * (Tool-8b, doc 78): the reason a tool declaring a required input can be a
 * menu row at all.
 *
 * The prompt renders the tool's declared `AppToolInput`s (Tool-3's
 * PropertyDef-derived typing) through the shared faces — `<SelectMenu>` /
 * `<MultiSelectMenu>` for a closed choice set, `<Checkbox>` for a boolean,
 * the shared `parseDateInput` (with live preview) for a date, `.bs-input`
 * text faces for the rest — inside the shared `<Popover>`. No bespoke chrome,
 * no native `<select>`.
 *
 * Trust rules:
 *   - the title / provider attribution / description are the already-screened
 *     DECLARATION fields (registry-validated, length-capped, invisible-text
 *     screened) — nothing here renders a call result;
 *   - submit forwards `validateAppToolArgs`' own returned bag — the broker
 *     revalidates anyway (the prompt is UX, not a trust boundary), but the
 *     checked value and the forwarded value are the same value;
 *   - a wrong or missing input renders a NAMED field error and the form stays
 *     open — never a call that will hang or refuse.
 */

import {
	type AppToolInput,
	type AppToolRecord,
	DateGranularity,
	ValueType,
	isMultiValued,
	sanitizeAppLabel,
} from "@brainstorm-os/sdk-types";
import { type ReactElement, useCallback, useState } from "react";
import { Checkbox } from "../checkbox/checkbox";
import { humanizeKey } from "../humanize-key";
import { Popover } from "../popover/popover";
import { PopoverSize } from "../popover/popover-shared";
import { formatDate, parseDateInput } from "../property-ui/cells/format";
import { MultiSelectMenu } from "../select-menu/multi-select-menu";
import { SelectMenu } from "../select-menu/select-menu";
import {
	TOOL_ARG_FORM_ERROR,
	type ToolArgDraft,
	ToolArgFieldError,
	type ToolArgPromptTarget,
	buildToolArgs,
	initialToolArgDraft,
	promptedInputs,
} from "./arg-prompt-logic";

export type ToolArgPromptTranslate = (
	key: string,
	params?: Record<string, string | number>,
) => string;

const FIELD_ERROR_KEY: Readonly<Record<ToolArgFieldError, string>> = {
	[ToolArgFieldError.Required]: "tool.args.error.required",
	[ToolArgFieldError.NotANumber]: "tool.args.error.notANumber",
	[ToolArgFieldError.NotADate]: "tool.args.error.notADate",
	[ToolArgFieldError.Invalid]: "tool.args.error.invalid",
};

function FieldError({
	error,
	t,
}: {
	error: ToolArgFieldError | undefined;
	t: ToolArgPromptTranslate;
}) {
	if (error === undefined) return null;
	return (
		<span className="bs-tool-args__error" role="alert">
			{t(FIELD_ERROR_KEY[error])}
		</span>
	);
}

function ArgField({
	input,
	value,
	error,
	onChange,
	t,
}: {
	input: AppToolInput;
	value: string | boolean | readonly string[];
	error: ToolArgFieldError | undefined;
	onChange: (next: string | boolean | readonly string[]) => void;
	t: ToolArgPromptTranslate;
}) {
	const label = humanizeKey(input.name);
	const name = input.required ? t("tool.args.requiredField", { label }) : label;

	if (input.valueType === ValueType.Boolean) {
		return (
			<div className="bs-tool-args__field">
				<Checkbox
					label={label}
					checked={value === true}
					onChange={(checked) => onChange(checked)}
					testId={`tool-arg-${input.name}`}
				/>
				<span className="bs-tool-args__description">{input.description}</span>
				<FieldError error={error} t={t} />
			</div>
		);
	}

	if (input.choices !== undefined && isMultiValued(input.count)) {
		return (
			<div className="bs-tool-args__field">
				<span className="bs-tool-args__label">{label}</span>
				<MultiSelectMenu
					selected={Array.isArray(value) ? value : []}
					options={input.choices.map((c) => ({ id: c, label: c }))}
					onChange={(next) => onChange(next)}
					ariaLabel={name}
					placeholder={t("tool.args.pick")}
					data-testid={`tool-arg-${input.name}`}
				/>
				<span className="bs-tool-args__description">{input.description}</span>
				<FieldError error={error} t={t} />
			</div>
		);
	}

	if (input.choices !== undefined) {
		const current = typeof value === "string" && value.length > 0 ? value : null;
		return (
			<div className="bs-tool-args__field">
				<span className="bs-tool-args__label">{label}</span>
				<SelectMenu
					value={current}
					options={input.choices.map((c) => ({ value: c, label: c }))}
					onChange={(next) => onChange(next)}
					ariaLabel={name}
					placeholder={t("tool.args.pick")}
					data-testid={`tool-arg-${input.name}`}
				/>
				<span className="bs-tool-args__description">{input.description}</span>
				<FieldError error={error} t={t} />
			</div>
		);
	}

	const text = typeof value === "string" ? value : "";
	const preview =
		input.valueType === ValueType.Date && text.trim().length > 0
			? formatDate(parseDateInput(text, input.granularity ?? DateGranularity.Date))
			: null;
	return (
		<div className="bs-tool-args__field">
			<label className="bs-tool-args__label" htmlFor={`tool-arg-${input.name}`}>
				{label}
			</label>
			<input
				id={`tool-arg-${input.name}`}
				type="text"
				className="bs-input"
				value={text}
				aria-label={name}
				aria-required={input.required}
				aria-invalid={error !== undefined}
				{...(input.valueType === ValueType.Number ? { inputMode: "decimal" as const } : {})}
				onChange={(e) => onChange(e.target.value)}
				data-testid={`tool-arg-${input.name}`}
			/>
			{preview !== null ? (
				<span className="bs-tool-args__preview" data-testid={`tool-arg-${input.name}-preview`}>
					{preview.length > 0 ? preview : t("tool.args.error.notADate")}
				</span>
			) : null}
			<span className="bs-tool-args__description">{input.description}</span>
			<FieldError error={error} t={t} />
		</div>
	);
}

export type ToolArgumentPromptProps = {
	tool: AppToolRecord;
	/** The menu's object, pre-filled into the first compatible entityRef
	 *  input. */
	target?: ToolArgPromptTarget;
	/** Receives `validateAppToolArgs`' validated bag — pass it to
	 *  `tools.call` as-is. */
	onSubmit: (args: Readonly<Record<string, unknown>>) => void;
	onCancel: () => void;
	t: ToolArgPromptTranslate;
};

export function ToolArgumentPrompt({
	tool,
	target,
	onSubmit,
	onCancel,
	t,
}: ToolArgumentPromptProps): ReactElement {
	const [draft, setDraft] = useState<ToolArgDraft>(() => initialToolArgDraft(tool.input, target));
	const [errors, setErrors] = useState<Readonly<Record<string, ToolArgFieldError>>>({});

	const submit = () => {
		const built = buildToolArgs(tool.input, draft);
		if (!built.ok) {
			setErrors(built.fieldErrors);
			return;
		}
		onSubmit(built.args);
	};

	return (
		<Popover
			title={`${tool.title} — ${sanitizeAppLabel(tool.appLabel) ?? tool.appId}`}
			onClose={onCancel}
			size={PopoverSize.Small}
			labels={{ close: t("tool.args.cancel") }}
			testId="tool-arg-prompt"
			footer={
				<div className="bs-tool-args__actions">
					<button type="button" className="bs-btn" onClick={onCancel} data-testid="tool-arg-cancel">
						{t("tool.args.cancel")}
					</button>
					<button
						type="button"
						className="bs-btn"
						data-bs-primary=""
						onClick={submit}
						data-testid="tool-arg-run"
					>
						{t("tool.args.run")}
					</button>
				</div>
			}
		>
			<div className="bs-tool-args">
				<p className="bs-tool-args__tool-description">{tool.description}</p>
				{promptedInputs(tool.input).map((input) => (
					<ArgField
						key={input.name}
						input={input}
						value={draft[input.name] ?? ""}
						error={errors[input.name]}
						onChange={(next) => setDraft((prev) => ({ ...prev, [input.name]: next }))}
						t={t}
					/>
				))}
				{errors[TOOL_ARG_FORM_ERROR] !== undefined ? (
					<p className="bs-tool-args__error" role="alert" data-testid="tool-arg-form-error">
						{t(FIELD_ERROR_KEY[errors[TOOL_ARG_FORM_ERROR]])}
					</p>
				) : null}
			</div>
		</Popover>
	);
}

type PendingArgRequest = {
	tool: AppToolRecord;
	target?: ToolArgPromptTarget;
	resolve: (args: Readonly<Record<string, unknown>> | null) => void;
};

/**
 * The prompt HOST: gives an app the `(tool) => Promise<args | null>` seam the
 * menu surfaces ask for (`onToolArguments` on `openObjectMenu`,
 * `promptForArgs` on `appToolCommands`) plus the element to mount. `null`
 * means the user cancelled — the surface then makes NO call and reports
 * nothing, exactly like backing out of a menu.
 */
export function useToolArgumentPrompt(t: ToolArgPromptTranslate): {
	promptForToolArgs: (
		tool: AppToolRecord,
		options?: { target?: ToolArgPromptTarget },
	) => Promise<Readonly<Record<string, unknown>> | null>;
	prompt: ReactElement | null;
} {
	const [pending, setPending] = useState<PendingArgRequest | null>(null);

	const promptForToolArgs = useCallback(
		(tool: AppToolRecord, options?: { target?: ToolArgPromptTarget }) =>
			new Promise<Readonly<Record<string, unknown>> | null>((resolve) => {
				setPending((prev) => {
					// A second request while one is open supersedes it; the first
					// caller gets a cancel, never a hang.
					prev?.resolve(null);
					return { tool, ...(options?.target ? { target: options.target } : {}), resolve };
				});
			}),
		[],
	);

	const settle = useCallback((args: Readonly<Record<string, unknown>> | null) => {
		setPending((prev) => {
			prev?.resolve(args);
			return null;
		});
	}, []);

	const prompt = pending ? (
		<ToolArgumentPrompt
			tool={pending.tool}
			{...(pending.target ? { target: pending.target } : {})}
			onSubmit={(args) => settle(args)}
			onCancel={() => settle(null)}
			t={t}
		/>
	) : null;

	return { promptForToolArgs, prompt };
}
