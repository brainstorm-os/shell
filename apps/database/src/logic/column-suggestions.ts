/**
 * Distinct existing values for a column, feeding the select-like combobox
 * editor (`@brainstorm/sdk` formatted cell `suggestions`). Returns the values
 * a status/select column already uses so editing offers a type-or-pick list
 * instead of a bare text field.
 *
 * Deliberately conservative — only columns that READ as an enumerable get
 * suggestions, so genuinely free-text/prose columns (an excerpt, a unique
 * name/id) keep a plain editor:
 *   - values are short (a status label, not a paragraph);
 *   - few distinct values (an enum, not hundreds of one-offs);
 *   - and they REPEAT (some value used more than once) — an all-unique column
 *     is an identifier/free-text field, not a select.
 * A column that fails any test returns `[]` (no combobox).
 */

import type { EntityRow } from "./in-memory-entities";
import { readPropertyPath } from "./in-memory-entities";

/** A select label is short; a paragraph isn't. */
const MAX_VALUE_LENGTH = 48;
/** An enum has few options; a free-text column has many. */
const MAX_DISTINCT = 24;

/** Existing distinct string values for `propertyId` across `rows`, ranked by
 *  frequency then alphabetically — or `[]` when the column doesn't read as a
 *  select (see module doc). */
export function columnValueSuggestions(rows: readonly EntityRow[], propertyId: string): string[] {
	const counts = new Map<string, number>();
	let populated = 0;
	for (const row of rows) {
		const raw = readPropertyPath(row, propertyId);
		if (typeof raw !== "string") continue;
		const value = raw.trim();
		// A long value means this is prose, not a select — disqualify the column.
		if (value.length === 0) continue;
		if (value.length > MAX_VALUE_LENGTH) return [];
		populated += 1;
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	if (counts.size === 0) return [];
	if (counts.size > MAX_DISTINCT) return [];
	// Every value distinct ⇒ identifier / free-text, not a select.
	if (counts.size === populated) return [];
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([value]) => value);
}
