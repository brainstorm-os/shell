/**
 * `<EntityPropertiesPanel>` — the shared editable-properties inspector body
 * every entity app renders inside its right panel. It maps an entity's
 * `properties.values` bag onto the shared `<PropertiesPanel>` rows: bound
 * properties become editable cells (write-through `onChange` / unbind
 * `onRemove`), and an "add property" control opens the shared
 * `<AddPropertyPicker>` (search the catalog, bind an existing def, or
 * create a new one inline).
 *
 * Extracted at copy three (Notes / Journal hand-rolled this map; Preview is
 * the third consumer): the values→rows→add-menu logic is identical across
 * apps, so it lives once. The host stays in charge of PERSISTENCE — it passes
 * `onWriteValues(next)`, which is where app-specific concerns (create the
 * entity on demand, pick the update verb) live. The host also supplies the
 * `meta` footer, header chrome, and any extra body sections (`children`).
 *
 * Must be rendered inside a `<PropertiesProvider>` so the catalog (the
 * vault-scoped `propertyStore`) and the cells reach the vault.
 */

import type { PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import type { AddPropertyPickerLabels } from "../i18n/common-labels";
import type { RelationTargetType } from "../inline-property-form-logic";
import {
	PropertiesPanel,
	type PropertiesPanelMeta,
	type PropertiesPanelRow,
} from "../properties-panel";
import { AddPropertyPicker } from "./add-property-picker";
import { usePropertyStore } from "./use-properties";
import { type ValuesMap, bindValue, clearValue, readValue, writeValue } from "./value-store";

export type EntityPropertiesPanelProps = {
	/** Panel title (used only when `hideHeader` is false). */
	title: string;
	/** The entity id handed to cells (some cells key per-object UI state).
	 *  Empty string is acceptable for a not-yet-created entity. */
	entityId: string;
	/** The entity's `properties.values` bag (already hydrated via
	 *  `migrateValuesField`). Empty when the entity has no bound properties. */
	values: ValuesMap;
	/** When false the rows render read-only and the add control is hidden —
	 *  e.g. a shell with no entities-update surface. */
	canMutate: boolean;
	/** Persist the next values bag. The host owns the update verb (and any
	 *  on-demand entity creation); the panel only computes the next bag. */
	onWriteValues: (next: ValuesMap) => void;
	/** Optional for hosts whose `extraRows` guarantee a never-empty grid. */
	emptyLabel?: string;
	addLabel: string;
	removeLabel: (name: string) => string;
	/** Host-owned rows interleaved into the SAME `.bs-props__list` grid,
	 *  rendered BEFORE the (name-sorted) bag-derived rows, in the order
	 *  given (Props-3). For hybrid hosts — Tasks' typed status / due /
	 *  project bridge rows — whose fields are not part of the values bag:
	 *  each row carries its own cell value, `onChange` persister and
	 *  `readOnly`, so per-field lock enforcement stays with the host. */
	extraRows?: readonly PropertiesPanelRow[];
	/** Catalog keys the add-property picker must not offer (threaded to
	 *  `AddPropertyPicker.excludeKeys`) — for hosts whose `extraRows`
	 *  shadow a real catalog def (Tasks' `assigneeId`). */
	pickerExcludeKeys?: ReadonlySet<string>;
	/** Localised labels for the panel's add-property picker, merged over
	 *  the English SDK defaults. */
	pickerLabels?: Partial<AddPropertyPickerLabels>;
	/** Entity types a picker-created Relation can target. */
	relationTargetTypes?: readonly RelationTargetType[];
	meta?: readonly PropertiesPanelMeta[];
	/** Suppress the panel's own header — set when hosted inside a tab strip
	 *  that already labels it "Properties". */
	hideHeader?: boolean;
	onClose?: () => void;
	closeLabel?: string;
	lead?: ReactNode;
	children?: ReactNode;
};

export function EntityPropertiesPanel({
	title,
	entityId,
	values,
	canMutate,
	onWriteValues,
	emptyLabel,
	addLabel,
	removeLabel,
	extraRows,
	pickerExcludeKeys,
	pickerLabels,
	relationTargetTypes,
	meta,
	hideHeader,
	onClose,
	closeLabel,
	lead,
	children,
}: EntityPropertiesPanelProps): ReactNode {
	const { properties } = usePropertyStore();
	const addButtonRef = useRef<HTMLButtonElement | null>(null);
	const [addAnchor, setAddAnchor] = useState<DOMRect | null>(null);

	const rows = useMemo<PropertiesPanelRow[]>(() => {
		const bound: { def: PropertyDef }[] = [];
		for (const key of Object.keys(values)) {
			const def = properties.get(key);
			if (def) bound.push({ def });
		}
		bound.sort((a, b) => a.def.name.localeCompare(b.def.name));
		const bagRows = bound.map(({ def }) => ({
			def,
			value: readValue(values, def),
			...(canMutate
				? {
						onChange: (next: unknown) => {
							const updated = writeValue(
								values,
								def as PropertyDef & { valueType: ValueType },
								next as never,
							);
							if (updated !== values) onWriteValues(updated);
						},
						onRemove: () => {
							const updated = clearValue(values, def.key);
							if (updated !== values) onWriteValues(updated);
						},
					}
				: {}),
		}));
		return extraRows ? [...extraRows, ...bagRows] : bagRows;
	}, [values, properties, canMutate, onWriteValues, extraRows]);

	const openAdd = useCallback(() => {
		const rect = addButtonRef.current?.getBoundingClientRect();
		if (rect) setAddAnchor(rect);
	}, []);

	const onPick = useCallback(
		(key: string) => {
			const def = properties.get(key);
			if (!def) return;
			const updated = bindValue(values, def as PropertyDef & { valueType: ValueType });
			if (updated !== values) onWriteValues(updated);
		},
		[properties, values, onWriteValues],
	);

	// Create-new lives in the picker, so the control shows whenever the host
	// allows mutation — even with every existing def already bound.
	const showAdd = canMutate;

	return (
		<>
			<PropertiesPanel
				title={title}
				rows={rows}
				entityId={entityId}
				{...(emptyLabel ? { emptyLabel } : {})}
				removeLabel={removeLabel}
				{...(hideHeader ? { hideHeader: true } : onClose ? { onClose } : {})}
				{...(closeLabel ? { closeLabel } : {})}
				{...(showAdd ? { onAdd: openAdd, addLabel, addButtonRef } : {})}
				{...(meta ? { meta } : {})}
				{...(lead ? { lead } : {})}
			>
				{children}
			</PropertiesPanel>
			{addAnchor ? (
				<AddPropertyPicker
					anchor={addAnchor}
					onPick={onPick}
					onClose={() => setAddAnchor(null)}
					{...(pickerLabels ? { labels: pickerLabels } : {})}
					{...(pickerExcludeKeys ? { excludeKeys: pickerExcludeKeys } : {})}
					{...(relationTargetTypes ? { relationTargetTypes } : {})}
				/>
			) : null}
		</>
	);
}
