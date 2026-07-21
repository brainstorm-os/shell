/**
 * Vault PropertyDefs for the **Contacts** surface (`brainstorm/Person/v1`),
 * seeded shell-side through the live vault `PropertiesStore` — a throwaway
 * dev hook exactly like `seedPlanProperties`, kept separate so Task/plan
 * semantics and Person semantics don't bleed into one catalog.
 *
 * Per the composable property model (, OQ-CT): there is NO
 * "Email"/"Phone" value-kind — Email/Phone are `Text` + a semantic
 * `PropertyFormat`; "multiple" is a `Cardinality.max > 1`, not a list
 * type. So a contact's emails = `text` + `format: email` + `count`. `name`
 * is the shared display key (already defined by `seedPlanProperties`); a
 * Person reuses it rather than introducing `fullName`.
 *
 * 9.12.13(a) of the Contacts iteration. The curated `All People` List +
 * its 3 views (b) and the Dashboard PinnedList shortcut (c) are a
 * follow-up slice — the Database app already auto-derives a per-type List
 * for `Person/v1`, so seeding the type + catalog + demo people is what
 * makes Contacts render today. `brainstorm/Person/v1` is a sanctioned
 * canonical vault type (not a per-app silo) per OQ-DM-1 / the plan.
 */

import {
	type Cardinality,
	DateGranularity,
	type PropertyDef,
	PropertyFormat,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { COMPANY_TYPE } from "../entities/company-migration";

const MULTI: Cardinality = { min: 0, max: 5 };

export function buildContactProperties(): PropertyDef[] {
	return [
		{
			key: "email",
			name: "Email",
			icon: null,
			valueType: ValueType.Text,
			format: PropertyFormat.Email,
			count: MULTI,
		},
		{
			key: "phone",
			name: "Phone",
			icon: null,
			valueType: ValueType.Text,
			format: PropertyFormat.Phone,
			count: MULTI,
		},
		{
			key: "company",
			name: "Company",
			icon: null,
			valueType: ValueType.EntityRef,
			allowedTypes: [COMPANY_TYPE],
		},
		{ key: "role", name: "Role", icon: null, valueType: ValueType.Text },
		{
			key: "birthday",
			name: "Birthday",
			icon: null,
			valueType: ValueType.Date,
			granularity: DateGranularity.Date,
		},
		{
			key: "links",
			name: "Links",
			icon: null,
			valueType: ValueType.EntityRef,
			allowedTypes: ["brainstorm/Person/v1", "brainstorm/Project/v1"],
			count: { min: 0, max: 10 },
		},
		{ key: "bio", name: "Bio", icon: null, valueType: ValueType.RichText },
	];
}

/** Minimal slice of the vault session the seeder needs (mirrors
 *  `PlanPropertiesStore` — kept local so the module is independent). */
export type ContactPropertiesStore = {
	setProperty(def: PropertyDef): void;
};
export type ContactPropertiesSession = {
	propertiesStore(): Promise<ContactPropertiesStore>;
};

export type SeedContactPropertiesResult =
	| { ok: true; properties: number }
	| { ok: false; reason: string };

export async function seedContactProperties(
	session: ContactPropertiesSession,
): Promise<SeedContactPropertiesResult> {
	try {
		const store = await session.propertiesStore();
		const properties = buildContactProperties();
		for (const def of properties) store.setProperty(def);
		return { ok: true, properties: properties.length };
	} catch (error) {
		return { ok: false, reason: (error as Error).message };
	}
}
