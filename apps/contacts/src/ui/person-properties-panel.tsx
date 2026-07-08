/**
 * Person properties — thin adapters over the SHARED
 * `@brainstorm/sdk/properties-panel`. `personPropertyRows` maps a person's
 * bridged fields (see `logic/person-properties.ts`) to the generic `rows`
 * the shared panel renders; the same rows feed BOTH surfaces: the inline
 * block at the top of the contact page (the Tasks-detail convention) and
 * the slide-over inspector (full list + comments). All chrome (glass
 * slide-over, header, grid rows) lives in the SDK component, identical to
 * Notes / Journal / Database / Bookmarks / Tasks.
 */

import { EntityCommentsPanel } from "@brainstorm/editor";
import { PropertiesPanel, type PropertiesPanelRow } from "@brainstorm/sdk/properties-panel";
import { readValue } from "@brainstorm/sdk/property-ui";
import { t } from "../i18n";
import {
	PERSON_PROPERTY_DEFS,
	READONLY_PERSON_PROP_KEYS,
	applyPersonPropertyValue,
	personToValues,
} from "../logic/person-properties";
import { getBrainstorm } from "../runtime";
import type { Person } from "../types/person";

/** Build the shared-cell rows for a person — one code path for the inline
 *  page block and the slide-over inspector, so both edit identically. */
export function personPropertyRows(
	person: Person,
	onPatch: (patch: Record<string, unknown>) => void,
): PropertiesPanelRow[] {
	const values = personToValues(person);
	return PERSON_PROPERTY_DEFS.map((def) => {
		const readOnly = READONLY_PERSON_PROP_KEYS.has(def.key);
		const row: PropertiesPanelRow = { def, value: readValue(values, def), readOnly };
		if (!readOnly) {
			row.onChange = (next) => {
				const patch = applyPersonPropertyValue(def.key, next);
				if (patch) onPatch(patch);
			};
		}
		return row;
	});
}

export type PersonPropertiesPanelProps = {
	person: Person;
	open: boolean;
	onPatch: (patch: Record<string, unknown>) => void;
	onClose: () => void;
};

export function PersonPropertiesPanel({
	person,
	open,
	onPatch,
	onClose,
}: PersonPropertiesPanelProps): React.ReactElement {
	const rows = personPropertyRows(person, onPatch);
	const services = getBrainstorm()?.services ?? null;
	return (
		<aside
			className={open ? "bs-props bs-props--open glass--strong" : "bs-props glass--strong"}
			aria-label={t("detail.properties.title")}
			aria-hidden={!open}
			{...(open ? {} : { inert: true })}
		>
			<EntityCommentsPanel
				services={services}
				documentId={person.id}
				properties={({ tabbed }) => (
					<PropertiesPanel
						title={t("detail.properties.title")}
						rows={rows}
						entityId={person.id}
						{...(tabbed ? { hideHeader: true } : { onClose, closeLabel: t("detail.properties.hide") })}
					/>
				)}
			/>
		</aside>
	);
}
