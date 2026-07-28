/**
 * Notes' localised labels for the shared SDK `<AddPropertyPicker>` —
 * used by BOTH mount points of the one picker: the editor's
 * `AddPropertyMenuPlugin` (slash command / gutter / property-list "+")
 * and the right-panel `<EntityPropertiesPanel>` (its "Add property"
 * button). Extracted from the plugin when the panel moved onto the
 * shared body (Props-4) so the two flows can never drift.
 */

import type { AddPropertyPickerLabels } from "@brainstorm-os/sdk/property-ui";
import { useMemo } from "react";
import { t } from "../i18n/t";

export function useNotesPickerLabels(): Partial<AddPropertyPickerLabels> {
	return useMemo<Partial<AddPropertyPickerLabels>>(
		() => ({
			region: t("notes.addProperty.region"),
			search: t("notes.addProperty.search"),
			searchPlaceholder: t("notes.addProperty.searchPlaceholder"),
			results: t("notes.addProperty.results"),
			empty: t("notes.addProperty.empty"),
			emptyCatalog: t("notes.addProperty.emptyCatalog"),
			loading: t("notes.addProperty.loading"),
			createNew: t("notes.addProperty.createNew"),
			typeMulti: t("notes.addProperty.typeMulti"),
			types: {
				text: t("notes.addProperty.type.text"),
				number: t("notes.addProperty.type.number"),
				boolean: t("notes.addProperty.type.boolean"),
				date: t("notes.addProperty.type.date"),
				select: t("notes.addProperty.type.select"),
				url: t("notes.addProperty.type.url"),
				email: t("notes.addProperty.type.email"),
				phone: t("notes.addProperty.type.phone"),
				file: t("notes.addProperty.type.file"),
				reference: t("notes.addProperty.type.reference"),
				"rich-text": t("notes.addProperty.type.richText"),
			},
			form: {
				region: t("notes.inlinePropertyForm.region"),
				back: t("notes.inlinePropertyForm.back"),
				nameLabel: t("notes.inlinePropertyForm.nameLabel"),
				namePlaceholder: t("notes.inlinePropertyForm.namePlaceholder"),
				kindLabel: t("notes.inlinePropertyForm.kindLabel"),
				formatLabel: t("notes.inlinePropertyForm.formatLabel"),
				multiLabel: t("notes.inlinePropertyForm.multiLabel"),
				cancel: t("notes.inlinePropertyForm.cancel"),
				submit: t("notes.inlinePropertyForm.submit"),
				moreOptionsHint: t("notes.inlinePropertyForm.moreOptionsHint"),
				kindText: t("notes.inlinePropertyForm.kind.text"),
				kindNumber: t("notes.inlinePropertyForm.kind.number"),
				kindBoolean: t("notes.inlinePropertyForm.kind.boolean"),
				kindDate: t("notes.inlinePropertyForm.kind.date"),
				kindSelect: t("notes.inlinePropertyForm.kind.select"),
				kindRelation: t("notes.inlinePropertyForm.kind.relation"),
				kindFile: t("notes.inlinePropertyForm.kind.file"),
				kindFormula: t("notes.inlinePropertyForm.kind.formula"),
				formulaLabel: t("notes.inlinePropertyForm.formula.label"),
				formulaPlaceholder: t("notes.inlinePropertyForm.formula.placeholder"),
				formulaHint: t("notes.inlinePropertyForm.formula.hint"),
				formatPlain: t("notes.inlinePropertyForm.format.plain"),
				formatUrl: t("notes.inlinePropertyForm.format.url"),
				formatEmail: t("notes.inlinePropertyForm.format.email"),
				formatPhone: t("notes.inlinePropertyForm.format.phone"),
				formatCurrency: t("notes.inlinePropertyForm.format.currency"),
				formatPercent: t("notes.inlinePropertyForm.format.percent"),
				formatDuration: t("notes.inlinePropertyForm.format.duration"),
				currencyLabel: t("notes.inlinePropertyForm.currencyLabel"),
				optionsLabel: t("notes.inlinePropertyForm.optionsLabel"),
				optionsPlaceholder: t("notes.inlinePropertyForm.optionsPlaceholder"),
				optionsHint: t("notes.inlinePropertyForm.optionsHint"),
				relationTargetLabel: t("notes.inlinePropertyForm.relationTargetLabel"),
				relationTargetAny: t("notes.inlinePropertyForm.relationTargetAny"),
			},
		}),
		[],
	);
}
