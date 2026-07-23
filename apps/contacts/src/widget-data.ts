/**
 * Pure data-shaping for the Contacts dashboard widget (9.12.13(c)) — no React /
 * CSS imports, so it's unit-testable in isolation. The `widget.tsx` component is
 * a thin presentational shell over `shapeContacts`.
 */

import { t } from "./i18n";
import { COMPANY_TYPE, PERSON_TYPE } from "./types/person";

/** Manifest widget id — must match `registrations.widgets[].id` in manifest.json. */
export const CONTACTS_WIDGET_LIST = "list-contacts";

/** Default number of people the glance list shows. */
export const LIST_LIMIT = 8;

/** How the glance list is ordered — the in-widget sort control's value set. */
export enum ContactsSort {
	Name = "name",
	Recent = "recent",
}

export type WidgetContact = { id: string; name: string; subtitle: string };

/** The minimal vault-entity shape the widget reads (a subset of the live
 *  snapshot's rows) — kept local so the shaper is testable without the full
 *  `react-yjs` entity type. */
export type WidgetPersonEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	updatedAt: number;
	deletedAt: number | null;
};

export function personName(properties: Record<string, unknown>): string {
	const name = properties.name;
	return typeof name === "string" && name.trim().length > 0 ? name : t("row.noName");
}

/** Vault entity ids are `ent_<alphanum>` — never a display name. Hiding
 *  unresolved ids keeps wire format off glance tiles (F-403). */
function looksLikeEntityId(value: string): boolean {
	return /^ent_[a-z0-9]+$/i.test(value);
}

/** Resolve a Person.company value to a display string. Role wins; linked
 *  company refs resolve through `companyNames` when present; unresolved ids
 *  and object refs stay blank rather than leak wire ids onto the tile. */
export function personSubtitle(
	properties: Record<string, unknown>,
	companyNames?: ReadonlyMap<string, string>,
): string {
	const role = properties.role;
	if (typeof role === "string" && role.trim().length > 0) return role;
	const company = properties.company;
	if (typeof company === "string") {
		const trimmed = company.trim();
		if (trimmed.length === 0) return "";
		const resolved = companyNames?.get(trimmed);
		if (resolved) return resolved;
		// Linked ref the widget couldn't resolve — never show the raw id.
		if (looksLikeEntityId(trimmed)) return "";
		return trimmed;
	}
	return "";
}

/** `id → company name` for non-deleted `Company/v1` rows in the snapshot. */
export function companyNameIndex(
	entities: readonly WidgetPersonEntity[],
): ReadonlyMap<string, string> {
	const index = new Map<string, string>();
	for (const e of entities) {
		if (e.type !== COMPANY_TYPE || e.deletedAt !== null) continue;
		const name = e.properties.name;
		if (typeof name === "string" && name.trim().length > 0) {
			index.set(e.id, name.trim());
		}
	}
	return index;
}

/** Filter the live snapshot to non-deleted `Person/v1`, order by the chosen
 *  sort, and project the top `limit` into glance rows. `total` is the full
 *  live-people count (independent of the limit). Company entities in the same
 *  snapshot resolve linked `company` refs to display names (F-403). */
export function shapeContacts(
	entities: readonly WidgetPersonEntity[],
	sort: ContactsSort,
	limit = LIST_LIMIT,
): { contacts: WidgetContact[]; total: number } {
	const names = companyNameIndex(entities);
	const live = entities.filter((e) => e.type === PERSON_TYPE && e.deletedAt === null);
	const ordered = [...live].sort((a, b) =>
		sort === ContactsSort.Recent
			? b.updatedAt - a.updatedAt
			: personName(a.properties).localeCompare(personName(b.properties)),
	);
	const contacts = ordered.slice(0, limit).map((e) => ({
		id: e.id,
		name: personName(e.properties),
		subtitle: personSubtitle(e.properties, names),
	}));
	return { contacts, total: live.length };
}
