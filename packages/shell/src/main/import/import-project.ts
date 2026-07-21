/**
 * Project stage (IE-2) — map a parsed record onto a typed {@link EntityDraft}.
 *
 * Coerces each mapped column's raw source value into the value-shape its
 * ValueType implies. This is *external→typed* coercion (a CSV/JSON cell is a
 * string or a bare number) — distinct from the SDK's `coerceValue`, which
 * validates already-typed stored values for hydration and won't parse a date
 * string or a numeric string. Unmapped/absent columns are skipped (not nulled)
 * so a partial source row produces a partial entity, not one full of empties.
 */

import { DateGranularity, type DateValue, ValueType } from "@brainstorm-os/sdk-types";
import type { EntityDraft, ImportRecord, MappingPlan } from "./import-types";

const TRUE_TOKENS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_TOKENS = new Set(["false", "0", "no", "n", "off"]);

function toDate(raw: unknown): DateValue | null {
	if (raw && typeof raw === "object" && typeof (raw as DateValue).at === "number") {
		return raw as DateValue;
	}
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return { at: raw, granularity: DateGranularity.Date };
	}
	if (typeof raw === "string") {
		const at = Date.parse(raw);
		if (Number.isNaN(at)) return null;
		const hasTime = /[T ]\d{2}:\d{2}/.test(raw);
		return { at, granularity: hasTime ? DateGranularity.DateTime : DateGranularity.Date };
	}
	return null;
}

/** Coerce a raw source value into the shape its ValueType implies, or null. */
export function coerceToValueType(valueType: ValueType, raw: unknown): unknown {
	switch (valueType) {
		case ValueType.Text:
			return raw === null || raw === undefined ? null : typeof raw === "string" ? raw : String(raw);
		case ValueType.Number: {
			if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
			if (typeof raw === "string" && raw.trim() !== "") {
				const n = Number(raw);
				return Number.isFinite(n) ? n : null;
			}
			return null;
		}
		case ValueType.Boolean: {
			if (typeof raw === "boolean") return raw;
			if (typeof raw === "number") return raw !== 0;
			if (typeof raw === "string") {
				const t = raw.trim().toLowerCase();
				if (TRUE_TOKENS.has(t)) return true;
				if (FALSE_TOKENS.has(t)) return false;
			}
			return null;
		}
		case ValueType.Date:
			return toDate(raw);
		default:
			// EntityRef / RichText aren't inferred from generic sources in v1.
			return raw === undefined ? null : raw;
	}
}

/** Project one parsed record into a typed entity draft per the mapping plan. */
export function projectRecord(record: ImportRecord, plan: MappingPlan): EntityDraft {
	const properties: Record<string, unknown> = {};
	for (const mapping of plan.columns) {
		if (!mapping.include) continue;
		if (!(mapping.column in record.fields)) continue;
		properties[mapping.property] = coerceToValueType(
			mapping.valueType,
			record.fields[mapping.column],
		);
	}
	return { externalId: record.externalId, type: plan.targetType, properties };
}
