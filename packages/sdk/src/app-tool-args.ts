/**
 * App-tool argument validation + JSON-Schema projection (Tool-3, doc 78).
 *
 * OQ-TOOL-1 resolved to **`PropertyDef`, not raw JSON Schema**. The payoff
 * lives here: `validateAppToolArgs` runs at the BROKER, before a call reaches
 * the providing app's sandbox, which is precisely what MCP's deliberately
 * opaque `inputSchema` cannot offer. The model still gets JSON Schema — via
 * `appToolInputsJsonSchema`, projected from the same declaration, so the two
 * views cannot drift APART: anything the schema states, the broker enforces.
 * They are not identical, and the asymmetry only ever runs one way — the
 * broker is the stricter of the two. `format: phone` / `markdown` / `code` are
 * enforced here and unprojectable (JSON Schema has no name for them), so the
 * model is told less than is checked, never more.
 *
 * Two honest boundaries on what "validated" means:
 *
 *  1. `validateValue` (the shared property validator this reuses) is a SHAPE
 *     check — it does not enforce `pattern` / `range` / `choices` / `format`.
 *     Those are layered on here rather than pushed into the shared validator,
 *     because tightening the shared one would retroactively reject stored
 *     property values across the vault. So a tool argument is checked STRICTLY
 *     and a stored property is not; that asymmetry is deliberate.
 *  2. `allowedTypes` on an `entityRef` cannot be checked without reading the
 *     entity store, which this pure module has no business doing. It projects
 *     into the schema for the model and is enforced at dispatch (Tool-4).
 */

import {
	type AppToolInput,
	type Cardinality,
	DEFAULT_CARDINALITY,
	type DateValue,
	type PropertyDef,
	PropertyFormat,
	ValueType,
	isMultiValued,
} from "@brainstorm-os/sdk-types";
import { validateValue } from "./properties-validate";
import { isValidFormatted } from "./property-ui/cells/format";

export type AppToolArgsValidation =
	| { ok: true; args: Readonly<Record<string, unknown>> }
	| { ok: false; errors: readonly string[] };

/** JSON Schema (draft 2020-12 subset) — the shape an LLM tool definition
 *  wants. Deliberately a plain record: nothing in this repo consumes JSON
 *  Schema as anything richer, and typing it as such would imply a validator we
 *  do not have. */
export type JsonSchema = Record<string, unknown>;

/** Build the real `PropertyDef` the shared validator expects. `key` / `name` /
 *  `icon` are the record-shaped fields an argument has no use for; they are
 *  synthesized rather than declared (see `AppToolInput`'s note). The result is
 *  always SINGLE-valued: a multi-valued tool argument is a plain array, so
 *  arity is handled here and each element validated as a scalar. */
function defForInput(input: AppToolInput): PropertyDef {
	const def: PropertyDef = {
		key: input.name,
		name: input.name,
		icon: null,
		valueType: input.valueType,
	};
	if (input.format !== undefined) def.format = input.format;
	if (input.granularity !== undefined) def.granularity = input.granularity;
	if (input.allowedTypes !== undefined) def.allowedTypes = input.allowedTypes;
	return def;
}

/** Whole-string match, always. An unanchored author-supplied `pattern` would
 *  otherwise pass on any string that merely CONTAINS a match — the classic
 *  way a validation regex turns out to validate nothing. */
function matchesPattern(pattern: string, value: string): boolean {
	try {
		return new RegExp(`^(?:${pattern})$`, "u").test(value);
	} catch {
		// A declaration that got this far was compile-checked; a throw here means
		// a corrupt registry row. Fail closed.
		return false;
	}
}

/** The constraints the shared shape validator does not cover. */
function checkConstraints(input: AppToolInput, value: unknown): string | null {
	switch (input.valueType) {
		case ValueType.Text: {
			const text = value as string | null;
			if (text === null) return null;
			if (input.choices !== undefined && !input.choices.includes(text)) {
				return `${input.name}: must be one of ${input.choices.join(", ")}`;
			}
			if (input.pattern !== undefined && !matchesPattern(input.pattern, text)) {
				return `${input.name}: does not match the declared pattern`;
			}
			if (input.format !== undefined) {
				// `isValidFormatted` treats empty as valid — right for a stored
				// property (a blank cell is simply unset), wrong for an argument,
				// where `{ to: "   " }` would satisfy a `format: email` argument the
				// model was told is an email.
				if (text.trim().length === 0) return `${input.name}: expected a ${input.format}, got blank`;
				if (!isValidFormatted(input.format, text)) {
					return `${input.name}: not a valid ${input.format}`;
				}
			}
			return null;
		}
		case ValueType.Number: {
			const n = value as number | null;
			if (n === null || input.range === undefined) return null;
			if (input.range.min !== undefined && n < input.range.min) {
				return `${input.name}: must be >= ${input.range.min}`;
			}
			if (input.range.max !== undefined && n > input.range.max) {
				return `${input.name}: must be <= ${input.range.max}`;
			}
			return null;
		}
		case ValueType.Date: {
			const d = value as DateValue | null;
			if (d === null || input.granularity === undefined) return null;
			return d.granularity === input.granularity
				? null
				: `${input.name}: expected granularity ${input.granularity}`;
		}
		default:
			return null;
	}
}

function arity(input: AppToolInput): Cardinality {
	return input.count ?? DEFAULT_CARDINALITY;
}

/** Rebuild a validated value so only the declared shape crosses into the
 *  provider. Only `date` needs it — it is the one non-primitive wire value,
 *  and `isDateValueShape` ignores extra keys, so passing the caller's object
 *  through by reference would ferry undeclared fields into the sandbox while
 *  the projection says `additionalProperties: false`. */
function rebuild(input: AppToolInput, value: unknown): unknown {
	if (input.valueType !== ValueType.Date) return value;
	const d = value as DateValue;
	return { at: d.at, granularity: d.granularity };
}

/**
 * Validate a call's `args` against a tool's declared inputs.
 *
 * Fail-closed on every axis: an undeclared key is REJECTED rather than passed
 * through, because forwarding uninspected data into the provider's sandbox is
 * exactly the hole the declaration exists to close. The returned `args` is a
 * fresh object containing only declared keys — callers forward THAT, never the
 * caller's original object.
 */
export function validateAppToolArgs(
	inputs: readonly AppToolInput[],
	args: unknown,
): AppToolArgsValidation {
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return { ok: false, errors: ["args must be an object"] };
	}
	// Own enumerable keys only — an inherited `toString` must not read as a
	// supplied argument, and a `__proto__` key must not reach the provider.
	const supplied = new Map<string, unknown>(Object.entries(args as Record<string, unknown>));
	const declared = new Set(inputs.map((i) => i.name));
	const errors: string[] = [];

	for (const key of supplied.keys()) {
		if (!declared.has(key)) errors.push(`unknown argument "${key}"`);
	}

	const out: Record<string, unknown> = Object.create(null);
	for (const input of inputs) {
		if (!supplied.has(input.name)) {
			if (input.required) errors.push(`missing required argument "${input.name}"`);
			continue;
		}
		const value = supplied.get(input.name);
		const def = defForInput(input);

		// `PropertyDef`'s value types accept `null` as "no value" — right for a
		// STORED property, wrong for an argument. Every constraint below skips a
		// null, so `{ scope: null }` would satisfy a choice-constrained argument
		// and land in the provider, whose `default:` branch is usually the wide
		// one. Omitting the key is how a caller says "absent"; the projection
		// never offers `null` as a type, so accepting it would also be a case of
		// the broker enforcing something other than what the model was told.
		// (`boolean` already rejected null, so this also makes it uniform.)
		if (value === null) {
			errors.push(`${input.name}: may not be null — omit the key instead`);
			continue;
		}

		if (isMultiValued(input.count)) {
			if (!Array.isArray(value)) {
				errors.push(`${input.name}: expected an array`);
				continue;
			}
			const { min, max } = arity(input);
			if (value.length < min) errors.push(`${input.name}: expected at least ${min} item(s)`);
			if (value.length > max) errors.push(`${input.name}: expected at most ${max} item(s)`);
			let elementFailed = false;
			for (const element of value) {
				// A null ITEM is never meaningful — a list of values is a list of
				// values — and would skip the per-element constraints below.
				if (element === null) {
					errors.push(`${input.name}: list items may not be null`);
					elementFailed = true;
					break;
				}
				const shape = validateValue(def, element);
				if (!shape.ok) {
					errors.push(`${input.name}: ${shape.errors.join("; ")}`);
					elementFailed = true;
					break;
				}
				const constraint = checkConstraints(input, element);
				if (constraint) {
					errors.push(constraint);
					elementFailed = true;
					break;
				}
			}
			if (!elementFailed) out[input.name] = value.map((e) => rebuild(input, e));
			continue;
		}

		const shape = validateValue(def, value);
		if (!shape.ok) {
			errors.push(`${input.name}: ${shape.errors.join("; ")}`);
			continue;
		}
		const constraint = checkConstraints(input, value);
		if (constraint) {
			errors.push(constraint);
			continue;
		}
		out[input.name] = rebuild(input, value);
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, args: { ...out } };
}

/** The scalar half of the projection. */
function scalarSchema(input: AppToolInput): JsonSchema {
	switch (input.valueType) {
		case ValueType.Text: {
			const schema: JsonSchema = { type: "string" };
			if (input.choices !== undefined) schema.enum = [...input.choices];
			if (input.pattern !== undefined) schema.pattern = `^(?:${input.pattern})$`;
			if (input.format === PropertyFormat.Email) schema.format = "email";
			if (input.format === PropertyFormat.Url) schema.format = "uri";
			// Mirrors the blank refusal in `checkConstraints` — only the two
			// formats JSON Schema can name carry `format`, but ALL of them reject
			// blank, and `minLength` is the one part of that the schema can say.
			if (input.format !== undefined) schema.minLength = 1;
			return schema;
		}
		case ValueType.Number: {
			const schema: JsonSchema = { type: "number" };
			if (input.range?.min !== undefined) schema.minimum = input.range.min;
			if (input.range?.max !== undefined) schema.maximum = input.range.max;
			return schema;
		}
		case ValueType.Boolean:
			return { type: "boolean" };
		case ValueType.Date:
			// The wire value is the repo's `DateValue`, not an ISO string — the
			// projection describes what the broker will actually accept, since a
			// schema that describes something else is worse than none.
			return {
				type: "object",
				properties: {
					at: { type: "number", description: "epoch milliseconds" },
					granularity: {
						type: "string",
						...(input.granularity !== undefined
							? { const: input.granularity }
							: { enum: ["date", "datetime", "time"] }),
					},
				},
				required: ["at", "granularity"],
				additionalProperties: false,
			};
		case ValueType.EntityRef: {
			const schema: JsonSchema = { type: "string", description: "entity id" };
			if (input.allowedTypes !== undefined && input.allowedTypes.length > 0) {
				schema.description = `entity id (types: ${input.allowedTypes.join(", ")})`;
			}
			return schema;
		}
	}
}

/** Project a tool's declared inputs into the JSON Schema an LLM tool
 *  definition carries. Generated, never hand-authored, so the model's view and
 *  the broker's enforcement stay the same declaration. */
export function appToolInputsJsonSchema(inputs: readonly AppToolInput[]): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];
	for (const input of inputs) {
		const scalar = scalarSchema(input);
		// MERGE, never overwrite: `scalarSchema` puts the entityRef type hint in
		// `description`, and assigning the author's description over it would
		// drop the hint for every single-valued ref — the exact case the hint is
		// for. (A multi-valued one kept it only by accident, the hint riding
		// along on `items`.)
		const hint = typeof scalar.description === "string" ? scalar.description : null;
		if (isMultiValued(input.count)) {
			properties[input.name] = {
				type: "array",
				items: scalar,
				minItems: arity(input).min,
				maxItems: arity(input).max,
				description: input.description,
			};
		} else {
			scalar.description = hint ? `${input.description} (${hint})` : input.description;
			properties[input.name] = scalar;
		}
		if (input.required) required.push(input.name);
	}
	return {
		type: "object",
		properties,
		required,
		// Mirrors the validator's undeclared-key rejection — a model told it may
		// add free-form keys would be told something untrue.
		additionalProperties: false,
	};
}
