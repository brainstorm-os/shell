/**
 * Text → stored-value coercion for a typed column, shared by every path that
 * turns free text into a row's property value: the Database's CSV import
 * (9.12.19) and the Agent's proposed database rows (Agent-11d).
 *
 * The storage shapes are what the Database renders + edits back: a date is a
 * Unix-ms timestamp (not an ISO string), a number is a finite number, a boolean
 * accepts the common English spellings. Blank / unparseable input is
 * `undefined` — the caller OMITS the property rather than writing a `0` or an
 * `Invalid Date` (an empty cell, not a wrong one).
 */

import { ValueType } from "./properties";

export function coerceScalarValue(raw: string | undefined, type: ValueType): unknown {
	const value = (raw ?? "").trim();
	if (value === "") return undefined;
	switch (type) {
		case ValueType.Number: {
			const n = Number(value);
			return Number.isFinite(n) ? n : undefined;
		}
		case ValueType.Boolean:
			return parseBoolean(value);
		case ValueType.Date: {
			const ms = Date.parse(value);
			return Number.isNaN(ms) ? undefined : ms;
		}
		default:
			return value;
	}
}

function parseBoolean(value: string): boolean | undefined {
	const lower = value.toLowerCase();
	if (lower === "true" || lower === "yes") return true;
	if (lower === "false" || lower === "no") return false;
	return undefined;
}
