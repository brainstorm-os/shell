/**
 * Value-shape bridge between the Database's flat entity `properties` map
 * and the shared `@brainstorm-os/sdk` property cells.
 *
 * The two layers store the same logical value in different shapes:
 *   - DB raw:  dates are bare epoch-ms numbers, multi-values are bare
 *              `string[]`, scalars are bare strings / numbers / booleans.
 *   - Cell:    dates are `DateValue { at, granularity }`, multi-values are
 *              the `LabeledValue<T>[]` envelope, scalars are bare.
 *
 * `toCellValue` adapts DB → cell on the way in (tolerant of either shape so
 * a value another app wrote as a `DateValue` / envelope still renders), and
 * `toDbValue` adapts the cell's emitted value back to the DB's native shape
 * on commit — keeping the grid's existing display path (`render/cells.ts`)
 * unchanged. Pure (no DOM) so it gets node-environment unit coverage.
 */

import {
	DateGranularity,
	type DateValue,
	type LabeledValue,
	type PropertyDef,
	ValueType,
	isMultiValued,
} from "@brainstorm-os/sdk-types";

function asDateValue(raw: unknown, granularity: DateGranularity | undefined): DateValue | null {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return { at: raw, granularity: granularity ?? DateGranularity.Date };
	}
	if (raw && typeof raw === "object" && typeof (raw as { at?: unknown }).at === "number") {
		return raw as DateValue;
	}
	return null;
}

/** A DB raw multi-value (`string[]`, or an already-enveloped array) → the
 *  `LabeledValue<string>[]` the multi cells expect. */
function asLabeledValues(raw: unknown): LabeledValue<string>[] {
	if (!Array.isArray(raw)) return [];
	const out: LabeledValue<string>[] = [];
	for (const el of raw) {
		if (typeof el === "string") out.push({ value: el });
		else if (el && typeof el === "object" && typeof (el as { value?: unknown }).value === "string") {
			out.push(el as LabeledValue<string>);
		}
	}
	return out;
}

/** DB raw → the value shape the cell for `def` renders. */
export function toCellValue(def: PropertyDef, raw: unknown): unknown {
	if (def.valueType === ValueType.Date) return asDateValue(raw, def.granularity);
	if (isMultiValued(def.count)) return asLabeledValues(raw);
	switch (def.valueType) {
		case ValueType.Boolean:
			return raw === true;
		case ValueType.Number:
			return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
		default:
			// Text / EntityRef scalar — a bare string id, else empty.
			return typeof raw === "string" && raw.length > 0 ? raw : null;
	}
}

/** A cell's emitted value → the DB's native raw shape for `def`. */
export function toDbValue(def: PropertyDef, cellValue: unknown): unknown {
	if (def.valueType === ValueType.Date) {
		// Store the bare epoch-ms number — the grid's display path treats a
		// number as a date and derives granularity from the def.
		return cellValue && typeof cellValue === "object" ? ((cellValue as DateValue).at ?? null) : null;
	}
	if (isMultiValued(def.count)) {
		return asLabeledValues(cellValue).map((el) => el.value);
	}
	if (def.valueType === ValueType.Boolean) return cellValue === true;
	return cellValue ?? null;
}
