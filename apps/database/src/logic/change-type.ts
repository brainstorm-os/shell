/**
 * Change a property's type (9.12.33). `ValueType` is never flipped in place:
 * this plans the conversion of every bound value first, so the user sees what
 * each row becomes — and exactly which rows would lose data — before anything
 * is written. The def change drops the modifiers the new type can't carry.
 *
 * Supported: text ⇄ number ⇄ boolean ⇄ date. Select (vocabulary), relation
 * and rich-text properties are out of scope — their values are ids / docs a
 * scalar conversion can't faithfully carry.
 */

import {
	type PropertyDef,
	ValueType,
	coerceScalarValue,
	isMultiValued,
} from "@brainstorm-os/sdk-types";
import { isEntityLocked } from "@brainstorm-os/sdk/entity-lock";
import type { EntityRow } from "./in-memory-entities";

export const CONVERTIBLE_TYPES: readonly ValueType[] = [
	ValueType.Text,
	ValueType.Number,
	ValueType.Boolean,
	ValueType.Date,
];

export enum ConversionOutcome {
	/** Empty before and after — nothing to do. */
	Empty = "empty",
	/** Converted to an equivalent value of the new type. */
	Converted = "converted",
	/** The value can't be represented in the new type — it would be cleared. */
	Lost = "lost",
	/** A locked record — left as it is. */
	Locked = "locked",
}

export type RowConversion = {
	id: string;
	before: unknown;
	after: unknown;
	outcome: ConversionOutcome;
};

export type TypeChangePlan = {
	propertyId: string;
	from: ValueType;
	to: ValueType;
	rows: RowConversion[];
	converted: number;
	lost: number;
	locked: number;
	nextDef: PropertyDef;
};

/** Whether `def` may go through the change-type flow at all. */
export function canChangeType(def: PropertyDef | null | undefined): def is PropertyDef {
	return (
		!!def &&
		CONVERTIBLE_TYPES.includes(def.valueType) &&
		!def.vocabulary &&
		!def.formula &&
		!isMultiValued(def.count)
	);
}

function unwrap(value: unknown): unknown {
	if (Array.isArray(value)) return value.length === 0 ? null : unwrap(value[0]);
	if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
		return (value as { value: unknown }).value;
	}
	return value;
}

function isEmpty(value: unknown): boolean {
	return (
		value === null ||
		value === undefined ||
		value === "" ||
		(Array.isArray(value) && value.length === 0)
	);
}

function asText(value: unknown, from: ValueType): string {
	if (from === ValueType.Date && typeof value === "number") {
		return new Date(value).toISOString().slice(0, 10);
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}

/** One value's conversion: the new stored value, or `undefined` when it
 *  can't be represented (→ cleared, counted as lost). */
export function convertValue(value: unknown, from: ValueType, to: ValueType): unknown {
	const raw = unwrap(value);
	if (isEmpty(raw)) return null;
	if (to === ValueType.Text) return asText(raw, from);
	if (to === ValueType.Number && typeof raw === "boolean") return raw ? 1 : 0;
	if (to === ValueType.Boolean && typeof raw === "number") {
		return raw === 1 ? true : raw === 0 ? false : undefined;
	}
	if (to === ValueType.Date && typeof raw === "number")
		return from === ValueType.Date ? raw : undefined;
	if (to === ValueType.Number && from === ValueType.Date) return undefined;
	return coerceScalarValue(asText(raw, from), to);
}

/** The def under the new type — modifiers the new type rejects are dropped. */
export function defForType(def: PropertyDef, to: ValueType): PropertyDef {
	const {
		format: _format,
		precision: _precision,
		range: _range,
		granularity: _granularity,
		currency: _currency,
		unit: _unit,
		...rest
	} = def;
	return { ...rest, valueType: to };
}

export function planTypeChange(
	rows: ReadonlyArray<EntityRow>,
	def: PropertyDef,
	to: ValueType,
): TypeChangePlan {
	const from = def.valueType;
	const out: RowConversion[] = [];
	let converted = 0;
	let lost = 0;
	let locked = 0;
	for (const row of rows) {
		const before = row.properties[def.key];
		if (isEmpty(unwrap(before))) continue;
		if (isEntityLocked(row)) {
			out.push({ id: row.id, before, after: before, outcome: ConversionOutcome.Locked });
			locked += 1;
			continue;
		}
		const after = convertValue(before, from, to);
		if (after === undefined) {
			out.push({ id: row.id, before, after: null, outcome: ConversionOutcome.Lost });
			lost += 1;
		} else {
			out.push({ id: row.id, before, after, outcome: ConversionOutcome.Converted });
			converted += 1;
		}
	}
	return {
		propertyId: def.key,
		from,
		to,
		rows: out,
		converted,
		lost,
		locked,
		nextDef: defForType(def, to),
	};
}

/** The entity writes a committed plan makes (locked rows untouched). */
export function typeChangePatches(
	plan: TypeChangePlan,
): { id: string; patch: Record<string, unknown> }[] {
	return plan.rows
		.filter((r) => r.outcome === ConversionOutcome.Converted || r.outcome === ConversionOutcome.Lost)
		.map((r) => ({ id: r.id, patch: { [plan.propertyId]: r.after } }));
}
