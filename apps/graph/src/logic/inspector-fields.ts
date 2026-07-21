/**
 * Editable inspector fields (9.13.11) — the selected node's properties as
 * shared-SDK editable cells. Pure: infers a minimal `PropertyDef` per scalar
 * property so `getCell` mounts the right editor (text / number / checkbox), and
 * names the editable `name`/`title` field. Complex / chrome / non-scalar values
 * are skipped (they stay in the owning app). A real vault catalog def would
 * supersede this inference — extract to the SDK (alongside the Database
 * `effective-def`) if a third surface needs it.
 */

import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import type { EntityRow } from "./in-memory-graph";
import { MAX_INSPECTOR_ROWS, humaniseKey } from "./node-properties";

/** Keys whose values are chrome / containers other surfaces own, or internal
 *  plumbing the user never edits — never an editable inspector field.
 *  (`name`/`title` ARE editable, surfaced separately.) Any `__`-prefixed key is
 *  also skipped: that prefix marks reserved/internal fields (e.g. the seed
 *  provenance `__seededBy`), which must never surface as a user property. */
const NON_FIELD_KEYS: ReadonlySet<string> = new Set([
	"id",
	"body",
	"bodyRefs",
	"values",
	"icon",
	"cover",
	"snippet",
	"preview",
	"members",
	"createdAt",
	"updatedAt",
	// Collection / list-node plumbing — the view mode + source are app chrome,
	// not properties of the node a user names or edits from the graph.
	"view",
	"source",
	"kind",
]);

export type EditableField = {
	/** Property bag key the value lives + writes under. */
	key: string;
	def: PropertyDef;
	value: string | number | boolean;
};

/** Minimal def for a scalar value, or `null` when the value isn't a plainly
 *  editable scalar (arrays, objects, empty strings, dates-as-strings stay
 *  read-only here). */
export function inferInspectorDef(key: string, raw: unknown): PropertyDef | null {
	let valueType: ValueType | null = null;
	if (typeof raw === "string") valueType = raw.trim().length > 0 ? ValueType.Text : null;
	else if (typeof raw === "number" && Number.isFinite(raw)) valueType = ValueType.Number;
	else if (typeof raw === "boolean") valueType = ValueType.Boolean;
	if (valueType === null) return null;
	return { key, name: humaniseKey(key), icon: null, valueType };
}

/**
 * The editable scalar fields for `entity`, in bag-key order, capped at
 * {@link MAX_INSPECTOR_ROWS}. `name`/`title` are excluded (the inspector edits
 * the title separately); everything else routes through {@link inferInspectorDef}.
 */
export function editableInspectorFields(entity: EntityRow): EditableField[] {
	const out: EditableField[] = [];
	for (const [key, raw] of Object.entries(entity.properties)) {
		if (out.length >= MAX_INSPECTOR_ROWS) break;
		if (key.startsWith("__")) continue;
		if (NON_FIELD_KEYS.has(key) || key === "name" || key === "title") continue;
		const def = inferInspectorDef(key, raw);
		if (!def) continue;
		out.push({ key, def, value: raw as string | number | boolean });
	}
	return out;
}

/** The entity's display title for the editable name field (empty string when
 *  unset — the field still renders so a user can name a bare node). */
export function inspectorTitle(entity: EntityRow): string {
	const name = entity.properties.name ?? entity.properties.title;
	return typeof name === "string" ? name : "";
}
