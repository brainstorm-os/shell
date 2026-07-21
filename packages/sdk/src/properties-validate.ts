/**
 * Validation + coercion for property definitions and bound values —
 * composable model.
 *
 * Pure logic — no React, no storage, no platform deps. Two surfaces:
 *
 *   - `validatePropertyDef(def)` — checks valueType + modifier
 *     coherence (vocabulary required on Select-shaped text;
 *     allowedTypes on entityRef; format compatibility with valueType;
 *     cardinality bounds; range / precision; etc.).
 *   - `validateValue(def, value)` — shape-checks a stored value
 *     against `def`. Cardinality decides scalar vs `LabeledValue[]`
 *     envelope; coerceValue does the same with a tolerant cast.
 *
 * Both return a discriminated `{ ok: true }` / `{ ok: false; errors }`
 * shape so callers can render the error list inline.
 *
 * Boundary contract: the shell's IPC handler runs these again at the
 * broker, regardless of what the app claims — defense in depth.
 */

import {
	CARDINALITY_HARD_MAX,
	type Cardinality,
	DateGranularity,
	type DateValue,
	type Dictionary,
	type DictionaryItem,
	type LabeledValue,
	type PropertyDef,
	PropertyFormat,
	type PropertyValueByValueType,
	ValueType,
	isMultiValued,
} from "@brainstorm-os/sdk-types";

export type ValidationResult = { ok: true } | { ok: false; errors: readonly string[] };

const HEX_COLOUR = /^#[0-9a-f]{6}$/;
const KNOWN_VALUE_TYPES: ReadonlySet<string> = new Set(Object.values(ValueType));
const KNOWN_FORMATS: ReadonlySet<string> = new Set(Object.values(PropertyFormat));

/** Which formats are valid for a given valueType. `text` accepts the
 *  prose-shaped formats; `number` accepts the numeric-display formats;
 *  other base types accept no format. */
const VALUE_TYPE_FORMATS: Readonly<Record<ValueType, ReadonlySet<PropertyFormat>>> = Object.freeze({
	[ValueType.Text]: new Set<PropertyFormat>([
		PropertyFormat.Email,
		PropertyFormat.Url,
		PropertyFormat.Phone,
		PropertyFormat.Markdown,
		PropertyFormat.Code,
	]),
	[ValueType.Number]: new Set<PropertyFormat>([
		PropertyFormat.Currency,
		PropertyFormat.Percent,
		PropertyFormat.Duration,
		PropertyFormat.Formula,
	]),
	[ValueType.Boolean]: new Set<PropertyFormat>(),
	[ValueType.Date]: new Set<PropertyFormat>(),
	[ValueType.EntityRef]: new Set<PropertyFormat>(),
	[ValueType.RichText]: new Set<PropertyFormat>(),
});

/** Per-valueType allowance for the `vocabulary` modifier. `text` and
 *  `number` accept it (per the spec); the rest reject. */
const VALUE_TYPE_ACCEPTS_VOCABULARY: Readonly<Record<ValueType, boolean>> = Object.freeze({
	[ValueType.Text]: true,
	[ValueType.Number]: true,
	[ValueType.Boolean]: false,
	[ValueType.Date]: false,
	[ValueType.EntityRef]: false,
	[ValueType.RichText]: false,
});

export function validatePropertyDef(def: PropertyDef): ValidationResult {
	const errors: string[] = [];

	if (!def.key || typeof def.key !== "string") errors.push("key must be a non-empty string");
	if (typeof def.name !== "string" || def.name.trim().length === 0) {
		errors.push("name must be non-empty");
	}
	if (def.description !== undefined && typeof def.description !== "string") {
		errors.push("description must be a string when present");
	}
	if (!KNOWN_VALUE_TYPES.has(def.valueType)) {
		errors.push(`unknown valueType ${String(def.valueType)}`);
		return { ok: false, errors };
	}

	// Cardinality.
	if (def.count !== undefined) {
		const c = def.count;
		if (typeof c.min !== "number" || !Number.isFinite(c.min) || c.min < 0) {
			errors.push("count.min must be a non-negative finite number");
		}
		if (typeof c.max !== "number" || !Number.isFinite(c.max) || c.max < 1) {
			errors.push("count.max must be ≥ 1");
		}
		if (c.max > CARDINALITY_HARD_MAX) {
			errors.push(`count.max must be ≤ ${CARDINALITY_HARD_MAX}`);
		}
		if (Number.isFinite(c.min) && Number.isFinite(c.max) && c.min > c.max) {
			errors.push("count.min must be ≤ count.max");
		}
	}
	if (def.valueType === ValueType.RichText && def.count !== undefined) {
		if (def.count.min !== 1 || def.count.max !== 1) {
			errors.push("richText count must be { min: 1, max: 1 }");
		}
	}

	// Format compatibility.
	if (def.format !== undefined) {
		if (!KNOWN_FORMATS.has(def.format)) {
			errors.push(`unknown format ${String(def.format)}`);
		} else if (!VALUE_TYPE_FORMATS[def.valueType].has(def.format)) {
			errors.push(`format ${def.format} is not valid for valueType ${def.valueType}`);
		}
	}

	// Vocabulary.
	if (def.vocabulary !== undefined) {
		if (!VALUE_TYPE_ACCEPTS_VOCABULARY[def.valueType]) {
			errors.push(`vocabulary is not valid for valueType ${def.valueType}`);
		} else if (
			typeof def.vocabulary.dictionaryId !== "string" ||
			def.vocabulary.dictionaryId.length === 0
		) {
			errors.push("vocabulary.dictionaryId is required");
		}
	}

	// Range.
	if (def.range !== undefined) {
		if (def.valueType !== ValueType.Number && def.valueType !== ValueType.Date) {
			errors.push(`range is not valid for valueType ${def.valueType}`);
		} else if (
			def.range.min !== undefined &&
			def.range.max !== undefined &&
			def.range.min > def.range.max
		) {
			errors.push("range.min must be ≤ range.max");
		}
	}

	// Precision.
	if (def.precision !== undefined) {
		if (def.valueType !== ValueType.Number) {
			errors.push("precision is only valid for number");
		} else if (
			typeof def.precision !== "number" ||
			!Number.isInteger(def.precision) ||
			def.precision < 0
		) {
			errors.push("precision must be a non-negative integer");
		}
	}

	// Granularity.
	if (def.granularity !== undefined) {
		if (def.valueType !== ValueType.Date) {
			errors.push("granularity is only valid for date");
		} else if (!Object.values(DateGranularity).includes(def.granularity)) {
			errors.push(`unknown granularity ${String(def.granularity)}`);
		}
	}

	// EntityRef constraints.
	if (def.valueType === ValueType.EntityRef) {
		if (def.allowedTypes !== undefined && !Array.isArray(def.allowedTypes)) {
			errors.push("allowedTypes must be an array");
		}
	} else if (def.allowedTypes !== undefined) {
		errors.push("allowedTypes is only valid for entityRef");
	}

	if (def.entityFilter !== undefined && def.valueType !== ValueType.EntityRef) {
		errors.push("entityFilter is only valid for entityRef");
	}

	// Pattern — text only.
	if (def.pattern !== undefined && def.valueType !== ValueType.Text) {
		errors.push("pattern is only valid for text");
	}

	// Currency — number + format=currency only.
	if (def.currency !== undefined) {
		if (def.valueType !== ValueType.Number || def.format !== PropertyFormat.Currency) {
			errors.push("currency is only valid when valueType=number AND format=currency");
		}
	}

	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Whether a def's storage shape is a `LabeledValue[]` envelope
 *  (`count.max > 1`) or a bare scalar. */
function isMultiShape(def: PropertyDef): boolean {
	if (def.valueType === ValueType.RichText) return false;
	if (def.valueType === ValueType.Boolean) return false;
	return isMultiValued(def.count);
}

export function validateValue<V extends ValueType>(
	def: PropertyDef & { valueType: V },
	value: unknown,
): ValidationResult {
	if (isMultiShape(def)) {
		if (!Array.isArray(value)) {
			return { ok: false, errors: ["expected an array (multi-value envelope)"] };
		}
		for (const element of value) {
			if (!isLabeledValueShape(element)) {
				return { ok: false, errors: ["each entry must be { value, label? }"] };
			}
			const scalarOk = validateScalar(def, element.value);
			if (!scalarOk.ok) return scalarOk;
		}
		return { ok: true };
	}
	return validateScalar(def, value);
}

function validateScalar(def: PropertyDef, raw: unknown): ValidationResult {
	switch (def.valueType) {
		case ValueType.Text:
			return raw === null || typeof raw === "string"
				? { ok: true }
				: { ok: false, errors: ["expected string or null"] };
		case ValueType.Number:
			return raw === null || (typeof raw === "number" && Number.isFinite(raw))
				? { ok: true }
				: { ok: false, errors: ["expected finite number or null"] };
		case ValueType.Boolean:
			return typeof raw === "boolean" ? { ok: true } : { ok: false, errors: ["expected boolean"] };
		case ValueType.Date:
			return raw === null || isDateValueShape(raw)
				? { ok: true }
				: { ok: false, errors: ["expected { at, granularity } or null"] };
		case ValueType.EntityRef:
			return raw === null || typeof raw === "string"
				? { ok: true }
				: { ok: false, errors: ["expected entity id (string) or null"] };
		case ValueType.RichText:
			// Y.XmlFragment values are opaque at this layer — assume valid.
			return { ok: true };
	}
}

/** Best-effort coercion to the value-shape implied by `def`. Used by
 *  hydration: invalid stored values get replaced with the
 *  shape's empty rather than crashing the renderer. */
export function coerceValue<V extends ValueType>(
	def: PropertyDef & { valueType: V },
	raw: unknown,
): PropertyValueByValueType[V] {
	if (isMultiShape(def)) {
		if (!Array.isArray(raw)) return [] as unknown as PropertyValueByValueType[V];
		const out: LabeledValue<unknown>[] = [];
		for (const element of raw) {
			let labeled: LabeledValue<unknown> | null = null;
			if (isLabeledValueShape(element)) {
				labeled = element;
			} else if (element !== undefined && element !== null && typeof element !== "object") {
				// Tolerate a legacy bare scalar — wrap it into a labeled envelope.
				labeled = { value: element };
			}
			if (!labeled) continue;
			const scalar = coerceScalar(def, labeled.value);
			if (scalar === null) continue;
			if (labeled.label !== undefined && typeof labeled.label !== "string") {
				out.push({ value: scalar });
			} else if (labeled.label !== undefined) {
				out.push({ value: scalar, label: labeled.label });
			} else {
				out.push({ value: scalar });
			}
		}
		return out as unknown as PropertyValueByValueType[V];
	}
	return coerceScalar(def, raw) as PropertyValueByValueType[V];
}

function coerceScalar(def: PropertyDef, raw: unknown): unknown {
	switch (def.valueType) {
		case ValueType.Text:
			return typeof raw === "string" ? raw : null;
		case ValueType.Number: {
			if (raw === null) return null;
			if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
			return clampNumber(raw, def.range?.min, def.range?.max);
		}
		case ValueType.Boolean:
			return typeof raw === "boolean" ? raw : false;
		case ValueType.Date:
			return isDateValueShape(raw) ? raw : null;
		case ValueType.EntityRef:
			return typeof raw === "string" ? raw : null;
		case ValueType.RichText:
			return raw;
	}
}

/** The shape-correct empty for a property. */
export function emptyValueFor<V extends ValueType>(
	def: PropertyDef & { valueType: V },
): PropertyValueByValueType[V] {
	if (isMultiShape(def)) return [] as unknown as PropertyValueByValueType[V];
	switch (def.valueType) {
		case ValueType.Boolean:
			return false as PropertyValueByValueType[V];
		case ValueType.RichText:
			return null as PropertyValueByValueType[V];
		default:
			return null as PropertyValueByValueType[V];
	}
}

function clampNumber(n: number, min?: number, max?: number): number {
	let v = n;
	if (min !== undefined && v < min) v = min;
	if (max !== undefined && v > max) v = max;
	return v;
}

function isDateValueShape(raw: unknown): raw is DateValue {
	if (!raw || typeof raw !== "object") return false;
	const obj = raw as { at?: unknown; granularity?: unknown };
	return (
		typeof obj.at === "number" &&
		Number.isFinite(obj.at) &&
		typeof obj.granularity === "string" &&
		Object.values(DateGranularity).includes(obj.granularity as DateGranularity)
	);
}

function isLabeledValueShape(raw: unknown): raw is LabeledValue<unknown> {
	if (!raw || typeof raw !== "object") return false;
	const obj = raw as { value?: unknown; label?: unknown };
	return "value" in obj && (obj.label === undefined || typeof obj.label === "string");
}

/** Validate a Dictionary on read. Same `ok | errors` shape; used by
 *  hydration to drop a corrupt row rather than crash. */
export function validateDictionary(dict: Dictionary): ValidationResult {
	const errors: string[] = [];
	if (!dict.id) errors.push("dictionary id missing");
	if (typeof dict.name !== "string" || dict.name.length === 0) {
		errors.push("dictionary name must be non-empty");
	}
	const seen = new Set<string>();
	for (const item of dict.items) {
		const itemErr = validateDictionaryItem(item);
		if (!itemErr.ok) errors.push(...itemErr.errors);
		if (seen.has(item.id)) errors.push(`duplicate item id ${item.id}`);
		seen.add(item.id);
	}
	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateDictionaryItem(item: DictionaryItem): ValidationResult {
	const errors: string[] = [];
	if (!item.id) errors.push("item id missing");
	if (typeof item.label !== "string") errors.push("item label must be a string");
	if (typeof item.sortIndex !== "number" || !Number.isFinite(item.sortIndex)) {
		errors.push("item sortIndex must be a finite number");
	}
	if (item.colour !== undefined && !HEX_COLOUR.test(item.colour)) {
		errors.push(`item colour must match #rrggbb (got ${item.colour})`);
	}
	if (item.archivedAt !== undefined && typeof item.archivedAt !== "number") {
		errors.push("item archivedAt must be a number");
	}
	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Convenience helper for tests / cells: cardinality-aware empty. */
export function isEmptyValue<V extends ValueType>(
	def: PropertyDef & { valueType: V },
	value: PropertyValueByValueType[V],
): boolean {
	if (isMultiShape(def)) return Array.isArray(value) && value.length === 0;
	switch (def.valueType) {
		case ValueType.Boolean:
			return value === false;
		default:
			return value === null;
	}
}
