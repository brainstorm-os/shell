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
 * broker is the stricter of the two. `format: phone` is enforced here and
 * unprojectable (JSON Schema has no name for it), so the model is told less
 * than is checked, never more. `markdown` / `code` carry no syntactic rule at
 * all beyond the blank + control-character screens — the shared formatter
 * returns true for them — so they are a labelling convention, not a check.
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

/** Control + line characters, refused in any formatted argument. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** Scheme allowlist for a `format: url` ARGUMENT.
 *
 * `isValidFormatted` is a DISPLAY validator — its job is to decide whether a
 * property cell shows a red border, so it accepts anything `new URL()` parses.
 * That is far too generous for a value the broker is telling a provider it
 * checked: `javascript:`, `file:`, `data:` and `vbscript:` all parse. The
 * model is told `format: "uri"`, so a caller sending `javascript://%0aalert(1)`
 * would be handing the provider something neither party expects. (Found by
 * this rung's pentest, dispatched end to end.) */
const URL_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

function isSafeUrl(value: string): boolean {
	try {
		// No bare-host coercion here either: `isValidFormatted` prepends
		// `https://` to a schemeless string, which would let the scheme check be
		// skipped by a value that is not actually a URL.
		return URL_SCHEMES.has(new URL(value).protocol);
	} catch {
		return false;
	}
}

/** The canonical form of a url — what the provider will actually receive.
 *
 * EVERYTHING about a url argument is decided on this form: the scheme check,
 * `choices`, `pattern`, and the `enum` the model is shown. Checking the raw
 * string and forwarding the canonical one is a divergence, and a real one —
 * `https://api.example.com/v1/../admin` satisfies a `pattern` pinned to
 * `/v1/` and arrives at the provider as `/admin`. (Found by this rung's third
 * pentest pass, in a fix the second one had asked for.) Returns null when the
 * value is not a url at all; the scheme check then refuses it. */
function canonicalUrl(value: string): string | null {
	try {
		return new URL(value).href;
	} catch {
		return null;
	}
}

/** `choices` for a url argument compare canonically too, or a caller sending
 *  exactly the declared choice would be refused for the trailing slash the URL
 *  parser adds. */
function choiceMatches(input: AppToolInput, text: string): boolean {
	const choices = input.choices ?? [];
	if (input.format !== PropertyFormat.Url) return choices.includes(text);
	return choices.some((c) => canonicalUrl(c) === text || c === text);
}

/** The constraints the shared shape validator does not cover. */
function checkConstraints(input: AppToolInput, value: unknown): string | null {
	switch (input.valueType) {
		case ValueType.Text: {
			const text = value as string | null;
			if (text === null) return null;
			if (input.choices !== undefined && !choiceMatches(input, text)) {
				return `${input.name}: must be one of ${input.choices.join(", ")}`;
			}
			if (input.pattern !== undefined && !matchesPattern(input.pattern, text)) {
				return `${input.name}: does not match the declared pattern`;
			}
			// Control characters are refused for ANY formatted argument: a NUL or
			// a newline passes `[^\s@]+`-style checks while turning the value into
			// something else entirely wherever it lands.
			if (input.format !== undefined && CONTROL_CHARS.test(text)) {
				return `${input.name}: control characters are not allowed in a ${input.format}`;
			}
			if (input.format !== undefined) {
				// `isValidFormatted` treats empty as valid — right for a stored
				// property (a blank cell is simply unset), wrong for an argument,
				// where `{ to: "   " }` would satisfy a `format: email` argument the
				// model was told is an email.
				if (text.trim().length === 0) return `${input.name}: expected a ${input.format}, got blank`;
				if (input.format === PropertyFormat.Url && !isSafeUrl(text)) {
					return `${input.name}: only http(s) and mailto URLs are allowed`;
				}
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

/** Snapshot a value to plain data BEFORE it is validated, so validation and
 *  dispatch cannot read two different things.
 *
 * Everything below validates the snapshot and forwards the snapshot. Without
 * this, a value whose fields are getters (or an array whose `Symbol.iterator`
 * is overridden) is validated as one thing and dispatched as another — the
 * validator reads it once, `rebuild`/`.map` reads it again, and the second read
 * can answer differently. Freezing the OUTPUT bag does not help: the bypass is
 * in the contents, not the container. Structured-clone IPC happens to flatten
 * this today, so it is only reachable from an in-process caller — which is
 * exactly what the agent will be. (Found by this rung's pentest.) */
function snapshotScalar(input: AppToolInput, value: unknown): unknown {
	if (
		input.valueType === ValueType.Text &&
		input.format === PropertyFormat.Url &&
		typeof value === "string"
	) {
		// Canonicalise BEFORE validation so the checked bytes and the forwarded
		// bytes are the same bytes — the same rule this whole helper exists for.
		return canonicalUrl(value) ?? value;
	}
	if (input.valueType === ValueType.Date && value !== null && typeof value === "object") {
		const d = value as DateValue;
		return { at: d.at, granularity: d.granularity };
	}
	return value;
}

function snapshot(input: AppToolInput, value: unknown): unknown {
	if (!isMultiValued(input.count)) return snapshotScalar(input, value);
	if (!Array.isArray(value)) return value;
	// Materialize the array AND each element: an overridden `Symbol.iterator`
	// makes `for…of` and `.map` disagree, and a date element's getters would
	// still be re-read by `rebuild`.
	return Array.prototype.slice.call(value).map((e) => snapshotScalar(input, e));
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
		// Snapshot FIRST — every read below (shape, constraints, output) must see
		// the same bytes.
		const value = snapshot(input, supplied.get(input.name));
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
	// Returned with a NULL PROTOTYPE, not spread into a plain object. An
	// argument may legally be named `valueOf` / `toString` / `constructor`
	// (`APP_TOOL_INPUT_NAME_RE` admits them), so on a normal object a consumer
	// asking `args[input.name]` for an OMITTED optional argument gets
	// `Object.prototype.valueOf` — a function — instead of `undefined`, and any
	// `=== undefined` guard downstream silently doesn't fire.
	return { ok: true, args: Object.freeze(out) };
}

/** The scalar half of the projection. */
function scalarSchema(input: AppToolInput): JsonSchema {
	switch (input.valueType) {
		case ValueType.Text: {
			const schema: JsonSchema = { type: "string" };
			if (input.choices !== undefined) {
				schema.enum =
					input.format === PropertyFormat.Url
						? input.choices.map((c) => canonicalUrl(c) ?? c)
						: [...input.choices];
			}
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
