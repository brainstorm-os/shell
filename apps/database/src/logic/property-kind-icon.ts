import {
	type PropertyDef,
	PropertyFormat,
	ValueType,
	isMultiValued,
} from "@brainstorm-os/sdk-types";
import { IconName } from "@brainstorm-os/sdk/icon";
import { TITLE_COLUMN_ID } from "./column-layout";

/** The property-kind glyph for a column — the filter picker's type icon and
 *  the icon-only column header (9.12.29). A vocabulary-backed property is a
 *  Select; otherwise it maps off the catalog `valueType` + `format`. Built-ins
 *  with no def fall back by key (Name → text, the `*At` timestamps → date). */
export function propertyKindIconFor(
	propertyId: string,
	def: PropertyDef | null | undefined,
): IconName {
	if (propertyId === TITLE_COLUMN_ID) return IconName.KindText;
	if (!def) return /at$/i.test(propertyId) ? IconName.KindDate : IconName.KindText;
	if (def.vocabulary?.dictionaryId) {
		return isMultiValued(def.count) ? IconName.KindMultiSelect : IconName.KindSelect;
	}
	switch (def.valueType) {
		case ValueType.Number:
			return IconName.KindNumber;
		case ValueType.Boolean:
			return IconName.KindBoolean;
		case ValueType.Date:
			return IconName.KindDate;
		case ValueType.EntityRef:
			return IconName.KindLink;
		default:
			if (def.format === PropertyFormat.Email) return IconName.KindEmail;
			if (def.format === PropertyFormat.Url) return IconName.KindUrl;
			if (def.format === PropertyFormat.Phone) return IconName.KindPhone;
			return IconName.KindText;
	}
}
