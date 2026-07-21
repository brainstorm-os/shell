/**
 * `@brainstorm-os/sdk/property-ui` property-catalog — pure search + display
 * classification over a `PropertyDef` set, shared by the add-property
 * picker (and any surface that lists the vault's property catalog).
 *
 * Two domains, both DOM/React-free so they live in the pure half too:
 *   - `filterProperties` — substring search ranked starts-with >
 *     word-start > anywhere. The "+ Create new property" entry is
 *     appended by the picker's React layer, not here.
 *   - `categorizeProperty` / `isMultiProperty` — coarse, display-only
 *     classification driving the picker's per-row glyph + type caption.
 *
 * Extracted from Notes' `add-property-ops.ts` at copy two (Notes had the
 * rich picker; the SDK now owns it so every properties panel shares one
 * flow). The editor-state mutations (`applyAddProperty*`) stay in Notes —
 * they're Lexical-specific.
 */

import type { PropertyDef } from "@brainstorm-os/sdk-types";
import { PropertyFormat, ValueType, isMultiValued } from "@brainstorm-os/sdk-types";

export type FilterResult = {
	def: PropertyDef;
	/** Lower is better. Stable for use as a sort key. */
	rank: number;
};

const RANK_PREFIX = 0;
const RANK_WORD = 1;
const RANK_ANYWHERE = 2;

/** Rank `defs` against a (possibly empty) search query.
 *  - Empty query returns every def in stable iteration order, rank 0.
 *  - Non-empty query keeps defs whose `name` contains the trimmed query
 *    (case-insensitive). Sort is by rank, then by name. */
export function filterProperties(
	defs: Iterable<PropertyDef>,
	query: string,
): readonly FilterResult[] {
	const q = query.trim().toLowerCase();
	const out: FilterResult[] = [];
	for (const def of defs) {
		if (!q) {
			out.push({ def, rank: 0 });
			continue;
		}
		const name = def.name.toLowerCase();
		if (name.startsWith(q)) {
			out.push({ def, rank: RANK_PREFIX });
		} else if (matchesWordStart(name, q)) {
			out.push({ def, rank: RANK_WORD });
		} else if (name.includes(q)) {
			out.push({ def, rank: RANK_ANYWHERE });
		}
	}
	out.sort((a, b) => {
		if (a.rank !== b.rank) return a.rank - b.rank;
		return a.def.name.localeCompare(b.def.name);
	});
	return out;
}

/** Coarse, display-only classification of a `PropertyDef`. Drives the
 *  picker's per-row glyph + humanized type caption. Distinct from
 *  `ValueType` because a single value type fans out into several
 *  user-facing kinds via modifiers (a `text` def is Select with a
 *  vocabulary, URL with `format=url`, plain Text otherwise). */
export enum PropertyTypeCategory {
	Text = "text",
	Number = "number",
	Boolean = "boolean",
	Date = "date",
	Select = "select",
	Url = "url",
	Email = "email",
	Phone = "phone",
	File = "file",
	Reference = "reference",
	RichText = "rich-text",
}

const FILE_TARGET_TYPE = "brainstorm/File/v1";

/** Map a def to its display category. Modifier precedence mirrors the
 *  shell constructor's preset decomposition: vocabulary → Select wins
 *  over format; `entityRef` splits File vs Reference on `allowedTypes`. */
export function categorizeProperty(def: PropertyDef): PropertyTypeCategory {
	if (def.vocabulary) return PropertyTypeCategory.Select;
	switch (def.valueType) {
		case ValueType.Text:
			if (def.format === PropertyFormat.Url) return PropertyTypeCategory.Url;
			if (def.format === PropertyFormat.Email) return PropertyTypeCategory.Email;
			if (def.format === PropertyFormat.Phone) return PropertyTypeCategory.Phone;
			return PropertyTypeCategory.Text;
		case ValueType.Number:
			return PropertyTypeCategory.Number;
		case ValueType.Boolean:
			return PropertyTypeCategory.Boolean;
		case ValueType.Date:
			return PropertyTypeCategory.Date;
		case ValueType.EntityRef:
			return def.allowedTypes?.includes(FILE_TARGET_TYPE)
				? PropertyTypeCategory.File
				: PropertyTypeCategory.Reference;
		case ValueType.RichText:
			return PropertyTypeCategory.RichText;
		default:
			return PropertyTypeCategory.Text;
	}
}

/** Whether a def stores more than one value — surfaces a "· Multiple"
 *  caption suffix in the picker so the cardinality reads at a glance. */
export function isMultiProperty(def: PropertyDef): boolean {
	return isMultiValued(def.count);
}

function matchesWordStart(name: string, q: string): boolean {
	let i = 0;
	while (i < name.length) {
		const start = i === 0 || /\s|[-_/]/.test(name[i - 1] ?? "");
		if (start && name.startsWith(q, i)) return true;
		i += 1;
	}
	return false;
}
