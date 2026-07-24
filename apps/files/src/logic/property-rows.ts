/**
 * Custom-property enumeration for the inspector's Properties tab.
 *
 * The tab renders system metadata (Type, Created, Modified, Name, etc.)
 * with hand-written rows, but an entity's `properties` bag is open-ended:
 * a File or Folder can carry user-defined or app-written keys (tags, a
 * URL, a status) that the hardcoded set never surfaced — so the tab showed
 * zero rows for them (F-files inspector). This enumerates the REMAINING
 * properties (everything not already rendered elsewhere or owned by the
 * shell) into read-only label/value rows.
 *
 * Kept pure + app-local (no React, no catalog) so it's unit-testable; the
 * Database app's `effective-def` / `EditableCell` are coupled to its own
 * catalog bridge and can't be reused here. Labels come from the shared
 * `humanizeKey` (`@brainstorm-os/sdk`) so a generated key reads the same here,
 * in the Database inspector, and on the Agent's row cards.
 */

import { humanizeKey } from "@brainstorm-os/sdk";
import type { EntityProperties } from "../types/entity";

export { humanizeKey };

/** Keys the inspector already renders (system metadata rows / the
 *  Preview tab) — excluded from the custom-property enumeration so they
 *  aren't duplicated. The shell-owned timestamps live as top-level fields,
 *  but defensively skip their property-bag spellings too. */
const RENDERED_ELSEWHERE: ReadonlySet<string> = new Set([
	"name",
	"description",
	"mime",
	"size",
	"members",
	"icon",
	"cover",
	"hash",
	"attachment",
	"view",
	"sortby",
	"createdat",
	"updatedat",
	"deletedat",
	"created",
	"modified",
	"id",
	"type",
]);

export type PropertyRow = {
	key: string;
	label: string;
	value: string;
};

/** Render a property-bag value as a single display string, or `null` when
 *  it carries nothing legible (empty string, empty array, empty object). A
 *  nested object renders as a compact `{ a, b }` key list so an
 *  object-valued custom property still surfaces a row instead of being
 *  silently dropped. */
export function formatPropertyValue(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value.length > 0 ? value : null;
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
	if (typeof value === "boolean") return value ? "✓" : "✕";
	if (Array.isArray(value)) {
		const parts = value
			.map((item) => formatPropertyValue(item))
			.filter((part): part is string => part !== null);
		return parts.length > 0 ? parts.join(", ") : null;
	}
	if (typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		return keys.length > 0 ? `{ ${keys.join(", ")} }` : null;
	}
	return null;
}

/** Enumerate the entity's custom properties (everything not rendered
 *  elsewhere) into read-only rows, sorted by label for stable ordering. */
export function customPropertyRows(properties: EntityProperties): PropertyRow[] {
	const rows: PropertyRow[] = [];
	for (const key of Object.keys(properties)) {
		if (RENDERED_ELSEWHERE.has(key.toLowerCase())) continue;
		const value = formatPropertyValue(properties[key]);
		if (value === null) continue;
		rows.push({ key, label: humanizeKey(key), value });
	}
	rows.sort((a, b) => a.label.localeCompare(b.label));
	return rows;
}
