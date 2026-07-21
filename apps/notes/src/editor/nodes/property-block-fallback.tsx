/**
 * Fallback views for PropertyBlock / PropertyListBlock when:
 *   - The referenced PropertyDef has been deleted from the vault
 *     (`UnknownProperty`), or
 *   - The picked (kind, view) pair hasn't shipped a cell yet — e.g.
 *     a serialized snapshot from a future build using `Toggle` view on
 *     a Boolean, encountered by a build whose registry only has
 *     `Checkbox`. (`UnavailableView`.)
 *
 * Both render a non-destructive notice with enough context for the
 * user to see why the cell rendered "empty". Designed to be friendly
 * placeholders, not error states.
 */

import type { PropertyDef, PropertyView } from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { t } from "../../i18n/t";

export function PropertyBlockFallback({ propertyKey }: { propertyKey: string }): JSX.Element {
	return (
		<div className="notes__property-row notes__property-row--missing" data-property-key={propertyKey}>
			<span className="notes__property-row-label">{t("notes.property.unknown.label")}</span>
			<span className="notes__property-row-value notes__property-row-value--hint">
				{t("notes.property.unknown.hint", { key: propertyKey })}
			</span>
		</div>
	);
}

export function PropertyBlockUnavailableView({
	def,
	view,
}: {
	def: PropertyDef;
	view: PropertyView;
}): JSX.Element {
	return (
		<div className="notes__property-row notes__property-row--missing" data-property-key={def.key}>
			<span className="notes__property-row-label">{def.name}</span>
			<span className="notes__property-row-value notes__property-row-value--hint">
				{t("notes.property.unavailableView.hint", { view, kind: def.valueType })}
			</span>
		</div>
	);
}
