/**
 * The pure half of the tool argument prompt (Tool-8b, doc 78).
 *
 * `Tool-7` excluded a tool with a REQUIRED input from menu surfaces outright,
 * because a menu activation carries no arguments and `tools.call` would
 * refuse it `Invalid` on every click. The prompt closes that: a host that can
 * ask renders the tool's declared `AppToolInput`s as a form, and the click
 * becomes click → fill → run.
 *
 * THE PROMPT IS UX, NOT A TRUST BOUNDARY. The draft is built and pre-checked
 * here with the exact validator the broker runs (`validateAppToolArgs`), so a
 * user gets field-level feedback instead of a post-hoc refusal — but the
 * broker validates again on every call, and ONLY the validator's returned bag
 * is forwarded (check and forward the same value).
 */

import {
	type AppToolInput,
	type DateValue,
	ValueType,
	isMultiValued,
} from "@brainstorm-os/sdk-types";
import { validateAppToolArgs } from "../app-tool-args";
import { parseDateInput } from "../property-ui/cells/format";

/** What the form edits, keyed by input name. `string` for text / number /
 *  date / entityRef (the raw typed text), `boolean` for a checkbox,
 *  `readonly string[]` for a multi-valued choice set. */
export type ToolArgDraft = Readonly<Record<string, string | boolean | readonly string[]>>;

export enum ToolArgFieldError {
	Required = "required",
	NotANumber = "notANumber",
	NotADate = "notADate",
	/** Failed the broker-grade validator (pattern / range / choices / format). */
	Invalid = "invalid",
}

/** Field-error key for a failure the validator reports without naming a
 *  field this form renders. */
export const TOOL_ARG_FORM_ERROR = "";

/** Can the prompt render this input at all? Every single-valued type has a
 *  face; a multi-valued input only when it is a closed choice set (the shared
 *  `MultiSelectMenu`). Free-form multi-valued entry is post-v1. */
export function promptableInput(input: AppToolInput): boolean {
	if (!isMultiValued(input.count)) return true;
	return input.valueType === ValueType.Text && input.choices !== undefined;
}

/** Can a prompt collect enough to call this tool? Every REQUIRED input must
 *  be promptable; an optional input the form cannot render is simply omitted
 *  (an omitted optional key is a legal call). */
export function canPromptForTool(inputs: readonly AppToolInput[]): boolean {
	return inputs.filter((i) => i.required).every(promptableInput);
}

/** The inputs the form renders, in declaration order. */
export function promptedInputs(inputs: readonly AppToolInput[]): AppToolInput[] {
	return inputs.filter(promptableInput);
}

export type ToolArgPromptTarget = {
	entityId: string;
	entityType?: string;
};

/** The name of the first entityRef input the menu's target can pre-fill —
 *  unconstrained, or whose `allowedTypes` admits the target's type. A
 *  constrained input is never pre-filled with an id of unknown type. */
function prefillableRefName(
	inputs: readonly AppToolInput[],
	target: ToolArgPromptTarget,
): string | null {
	for (const input of inputs) {
		if (input.valueType !== ValueType.EntityRef || isMultiValued(input.count)) continue;
		const types = input.allowedTypes ?? [];
		if (types.length === 0) return input.name;
		if (target.entityType !== undefined && types.includes(target.entityType)) return input.name;
	}
	return null;
}

/** The empty draft: `""` / `false` / `[]` per face, with the menu's target
 *  pre-filled into the first compatible entityRef input. */
export function initialToolArgDraft(
	inputs: readonly AppToolInput[],
	target?: ToolArgPromptTarget,
): ToolArgDraft {
	const draft: Record<string, string | boolean | readonly string[]> = {};
	const prefill = target ? prefillableRefName(inputs, target) : null;
	for (const input of promptedInputs(inputs)) {
		if (input.valueType === ValueType.Boolean) draft[input.name] = false;
		else if (isMultiValued(input.count)) draft[input.name] = [];
		else if (input.name === prefill && target) draft[input.name] = target.entityId;
		else draft[input.name] = "";
	}
	return draft;
}

export type ToolArgBuildResult =
	| { ok: true; args: Readonly<Record<string, unknown>> }
	| { ok: false; fieldErrors: Readonly<Record<string, ToolArgFieldError>> };

function scalarFromDraft(
	input: AppToolInput,
	raw: string,
): { value: unknown } | { error: ToolArgFieldError } | null {
	const text = input.valueType === ValueType.Text ? raw : raw.trim();
	if (text.length === 0) {
		return input.required ? { error: ToolArgFieldError.Required } : null;
	}
	switch (input.valueType) {
		case ValueType.Text:
		case ValueType.EntityRef:
			return { value: text };
		case ValueType.Number: {
			const n = Number(text);
			if (Number.isNaN(n)) return { error: ToolArgFieldError.NotANumber };
			return { value: n };
		}
		case ValueType.Date: {
			const parsed: DateValue | null = parseDateInput(text, input.granularity);
			if (parsed === null) return { error: ToolArgFieldError.NotADate };
			return { value: parsed };
		}
		default:
			return { error: ToolArgFieldError.Invalid };
	}
}

/** The input name a validator message points at (`"<name>: …"` /
 *  `missing required argument "<name>"`), if it is one this form knows. */
function fieldForValidatorError(message: string, names: ReadonlySet<string>): string {
	const quoted = message.match(/"([^"]+)"/);
	if (quoted?.[1] !== undefined && names.has(quoted[1])) return quoted[1];
	const colon = message.indexOf(":");
	if (colon > 0) {
		const head = message.slice(0, colon);
		if (names.has(head)) return head;
	}
	return TOOL_ARG_FORM_ERROR;
}

/**
 * Build the call's `args` from the form draft, or the per-field errors.
 *
 * Empty optional fields are OMITTED (an absent key is how a caller says
 * "absent" — `null` is refused at the broker); a boolean is always included,
 * since a checkbox's unchecked state is an explicit `false`. The returned bag
 * is `validateAppToolArgs`' own output — the same value the broker will
 * accept — never the draft re-assembled a second way.
 */
export function buildToolArgs(
	inputs: readonly AppToolInput[],
	draft: ToolArgDraft,
): ToolArgBuildResult {
	const fieldErrors: Record<string, ToolArgFieldError> = {};
	const candidate: Record<string, unknown> = {};
	for (const input of promptedInputs(inputs)) {
		const raw = draft[input.name];
		if (input.valueType === ValueType.Boolean) {
			candidate[input.name] = raw === true;
			continue;
		}
		if (isMultiValued(input.count)) {
			const list = Array.isArray(raw) ? raw : [];
			if (list.length === 0) {
				if (input.required) fieldErrors[input.name] = ToolArgFieldError.Required;
				continue;
			}
			candidate[input.name] = list;
			continue;
		}
		const scalar = scalarFromDraft(input, typeof raw === "string" ? raw : "");
		if (scalar === null) continue;
		if ("error" in scalar) {
			fieldErrors[input.name] = scalar.error;
			continue;
		}
		candidate[input.name] = scalar.value;
	}
	if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

	const validation = validateAppToolArgs(inputs, candidate);
	if (!validation.ok) {
		const names = new Set(inputs.map((i) => i.name));
		for (const message of validation.errors) {
			fieldErrors[fieldForValidatorError(message, names)] = ToolArgFieldError.Invalid;
		}
		return { ok: false, fieldErrors };
	}
	return { ok: true, args: validation.args };
}
