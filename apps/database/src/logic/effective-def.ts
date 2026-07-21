/**
 * Effective column PropertyDef resolution for inline editing.
 *
 * The composable property model (Stage 9.6) registers a real `PropertyDef`
 * per property in the vault catalog; until a vault carries those, the
 * Database runs on display heuristics (`render/cells.ts`) and the catalog
 * resolves nothing. To make cells editable in that interim, we INFER a
 * minimal def from the column's data: the value's JS type maps to a
 * ValueType so the right editing cell (text / number / date / checkbox)
 * mounts. A registered catalog def always wins.
 *
 * Deliberately conservative:
 *   - Strings that resolve a VOCABULARY COLOUR (status / select-like) are
 *     left UN-inferred → they keep their read-only coloured chip rather
 *     than degrading to a plain text box (there is no dictionary to edit
 *     them against yet; a real catalog def turns them into proper selects).
 *   - Arrays / rich-text / untyped-empty columns are not inferred → they
 *     render read-only, exactly as before.
 */

import { DateGranularity, type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { humanize } from "../ui/humanize";
import type { EntityRow } from "./in-memory-entities";
import { readPropertyPath } from "./in-memory-entities";
import { resolvePropertyDef, resolveVocabularyColor } from "./property-resolver";

/** Large positive integers in a ~30-year window read as Unix-ms dates —
 *  mirrors `render/cells.ts` so display + edit agree on what's a date. */
function looksLikeTimestamp(n: number): boolean {
	return Number.isFinite(n) && n >= 1_000_000_000_000 && n <= 4_000_000_000_000;
}

/** Entity metadata the shell owns — never user-editable through a cell
 *  (editing would write a spurious `properties.<key>` that shadows the
 *  real top-level field). Matched case-insensitively against both camel
 *  and snake spellings. */
const SYSTEM_READONLY: ReadonlySet<string> = new Set([
	"id",
	"type",
	"createdat",
	"updatedat",
	"deletedat",
	"created_at",
	"updated_at",
	"deleted_at",
	"ownerappid",
	"owner_app_id",
]);

function isSystemField(propertyId: string): boolean {
	return SYSTEM_READONLY.has(propertyId.toLowerCase());
}

/** Infer a minimal PropertyDef from one sample value, or `null` when the
 *  value can't be typed for editing. */
export function inferPropertyDef(propertyId: string, sample: unknown): PropertyDef | null {
	const base = (valueType: ValueType, extra: Partial<PropertyDef> = {}): PropertyDef => ({
		key: propertyId,
		name: humanize(propertyId),
		icon: null,
		valueType,
		...extra,
	});
	if (typeof sample === "boolean") return base(ValueType.Boolean);
	if (typeof sample === "number") {
		return looksLikeTimestamp(sample)
			? base(ValueType.Date, { granularity: DateGranularity.Date })
			: base(ValueType.Number);
	}
	if (typeof sample === "string" && sample.length > 0) {
		// Status / select-like (a vocabulary colour resolves) → leave read-only.
		if (resolveVocabularyColor(propertyId, sample) !== null) return null;
		return base(ValueType.Text);
	}
	return null;
}

/** The def to drive an editing cell for `propertyId`: the registered
 *  catalog def if present, else one inferred from the first typeable value
 *  across `rows`. `null` ⇒ render read-only. */
export function effectiveColumnDef(
	propertyId: string,
	rows: readonly EntityRow[],
): PropertyDef | null {
	if (isSystemField(propertyId)) return null;
	const fromCatalog = resolvePropertyDef(propertyId);
	if (fromCatalog) return fromCatalog;
	for (const row of rows) {
		const value = readPropertyPath(row, propertyId);
		if (value === null || value === undefined || value === "") continue;
		const inferred = inferPropertyDef(propertyId, value);
		if (inferred) return inferred;
	}
	return null;
}
