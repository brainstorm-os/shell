/**
 * The Person property bridge for the shared inspector. Like the Bookmarks
 * bridge, it synthesises a `PropertyDef[]` + a `ValuesMap` so the SHARED
 * property-value cells (`@brainstorm-os/sdk/properties-panel`) render a contact's
 * attributes — never hand-rolled rows ([[feedback-no-hand-rolled-property-panels]]).
 * Person IS a property-bearing entity, so the values come straight from its
 * properties; the only bridging is array↔newline for the multi-value
 * email / phone (rendered through the scalar Multiline cell) and resolving the
 * company ref to a read-only name. Edits map back to an entity property patch.
 */

import {
	CARDINALITY_HARD_MAX,
	DateGranularity,
	type DateValue,
	type LabeledValue,
	type PropertyDef,
	PropertyView,
	ValueType,
} from "@brainstorm-os/sdk-types";
import type { ValuesMap } from "@brainstorm-os/sdk/property-ui";
import { t } from "../i18n";
import { COMPANY_TYPE, PERSON_TYPE, type Person } from "../types/person";

/** Synthetic def keys — the inspector's own value-map keys. They mirror the
 *  entity's stored property keys so the patch maps straight back. */
export const PERSON_PROP_KEY = {
	email: "email",
	phone: "phone",
	company: "company",
	role: "role",
	birthday: "birthday",
	anniversary: "anniversary",
	links: "links",
} as const;

/** Render order. Email / phone are stored multi-value but edited as a
 *  newline-delimited Multiline field; company / related-people are entity-ref
 *  picker cells; role / birthday / anniversary are scalar editable cells.
 *  Free-form notes are NOT a property row — they live in the page's body
 *  editor (the `bio` string is only the legacy seed for it). */
export const PERSON_PROPERTY_DEFS: readonly PropertyDef[] = [
	{
		key: PERSON_PROP_KEY.email,
		name: t("prop.email"),
		icon: null,
		valueType: ValueType.Text,
		display: { view: PropertyView.Multiline },
	},
	{
		key: PERSON_PROP_KEY.phone,
		name: t("prop.phone"),
		icon: null,
		valueType: ValueType.Text,
		display: { view: PropertyView.Multiline },
	},
	{
		key: PERSON_PROP_KEY.company,
		name: t("prop.company"),
		icon: null,
		valueType: ValueType.EntityRef,
		allowedTypes: [COMPANY_TYPE],
		count: { min: 0, max: 1 },
	},
	{ key: PERSON_PROP_KEY.role, name: t("prop.role"), icon: null, valueType: ValueType.Text },
	{
		key: PERSON_PROP_KEY.birthday,
		name: t("prop.birthday"),
		icon: null,
		valueType: ValueType.Date,
		granularity: DateGranularity.Date,
	},
	{
		key: PERSON_PROP_KEY.anniversary,
		name: t("prop.anniversary"),
		icon: null,
		valueType: ValueType.Date,
		granularity: DateGranularity.Date,
	},
	{
		key: PERSON_PROP_KEY.links,
		name: t("prop.related"),
		icon: null,
		valueType: ValueType.EntityRef,
		allowedTypes: [PERSON_TYPE],
		count: { min: 0, max: CARDINALITY_HARD_MAX },
	},
];

/** Every property is editable now that company / related-people are real
 *  entity-ref picker cells (the shared LinkCard cell, scoped by `allowedTypes`
 *  + resolved against the live `entityTitleSource`). */
export const READONLY_PERSON_PROP_KEYS: ReadonlySet<string> = new Set();

/** Synthesise the cell values for a person. The entity-ref cells take the raw
 *  ref id(s) — the shared cell resolves the display title from the live
 *  snapshot, so no name needs to be injected here. */
export function personToValues(person: Person): ValuesMap {
	const values: ValuesMap = {
		[PERSON_PROP_KEY.email]: person.emails.join("\n"),
		[PERSON_PROP_KEY.phone]: person.phones.join("\n"),
		[PERSON_PROP_KEY.company]: person.companyId ?? "",
		[PERSON_PROP_KEY.role]: person.role,
		[PERSON_PROP_KEY.links]: person.linkIds.map(
			(id) => ({ value: id }) satisfies LabeledValue<string>,
		),
	};
	if (person.birthday !== null) {
		values[PERSON_PROP_KEY.birthday] = {
			at: person.birthday,
			granularity: DateGranularity.Date,
		} satisfies DateValue;
	}
	if (person.anniversary !== null) {
		values[PERSON_PROP_KEY.anniversary] = {
			at: person.anniversary,
			granularity: DateGranularity.Date,
		} satisfies DateValue;
	}
	return values;
}

/** Pull the list of ref ids out of an edited multi entity-ref cell value. */
function refIdsFromValue(next: unknown): string[] {
	if (!Array.isArray(next)) return [];
	const out: string[] = [];
	for (const el of next) {
		const id = typeof el === "string" ? el : (el as LabeledValue<string>)?.value;
		if (typeof id === "string" && id) out.push(id);
	}
	return out;
}

/** Split a newline / comma delimited multi-value text field into clean
 *  entries (blank lines dropped). */
export function splitMultiValue(raw: unknown): string[] {
	if (typeof raw !== "string") return [];
	return raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Map an edited cell value back to an entity property patch, or `null` for a
 *  read-only key (the panel renders those non-editable anyway). */
export function applyPersonPropertyValue(
	key: string,
	next: unknown,
): Record<string, unknown> | null {
	switch (key) {
		case PERSON_PROP_KEY.email:
			return { email: splitMultiValue(next) };
		case PERSON_PROP_KEY.phone:
			return { phone: splitMultiValue(next) };
		case PERSON_PROP_KEY.role:
			return { role: typeof next === "string" ? next.trim() : "" };
		case PERSON_PROP_KEY.birthday: {
			const date = next && typeof next === "object" ? (next as DateValue) : null;
			return { birthday: date && Number.isFinite(date.at) ? date.at : null };
		}
		case PERSON_PROP_KEY.anniversary: {
			const date = next && typeof next === "object" ? (next as DateValue) : null;
			return { anniversary: date && Number.isFinite(date.at) ? date.at : null };
		}
		case PERSON_PROP_KEY.company:
			return { company: typeof next === "string" && next ? next : null };
		case PERSON_PROP_KEY.links:
			return { links: refIdsFromValue(next) };
		default:
			return null;
	}
}
