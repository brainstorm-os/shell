/**
 * PropertiesPanel (Notes) — a thin adapter over the SHARED
 * `@brainstorm/sdk/properties-panel`. It maps the open note's `values` bag to
 * the generic `rows` + `meta` the shared content renders; all chrome (header,
 * grid rows, add/remove affordances) lives in the SDK component, identical to
 * every other app. The resizable glass container (`.notes__props`) stays in
 * `app.tsx`.
 *
 * A property is "on the note" when its key is in `values`; "Add property" binds
 * a key via the shared picker (`AddPropertyTargetKind.BindToNote`), and each
 * row's remove clears the key.
 */

import type { PropertyDef } from "@brainstorm/sdk-types";
import {
	type PropertiesPanelMeta,
	type PropertiesPanelRow,
	PropertiesPanel as SharedPropertiesPanel,
} from "@brainstorm/sdk/properties-panel";
import { type ValuesMap, readValue, usePropertyStore } from "@brainstorm/sdk/property-ui";
import { type JSX, useCallback, useMemo, useRef } from "react";
import {
	type AddPropertyTarget,
	AddPropertyTargetKind,
	addPropertyStore,
} from "../editor/add-property-store";
import { t } from "../i18n/t";
import type { StoredNote } from "../store/note";
import { relativeTime } from "../ui/relative-time";

export type PropertiesPanelProps = {
	note: StoredNote;
	onSetValue: (def: PropertyDef, next: unknown) => void;
	onClear: (key: string) => void;
	/** Bind a property onto the note with no value yet (the "Add property"
	 *  flow). Distinct from `onSetValue` because seeding the empty value
	 *  through the value path unbinds instead of binds. */
	onBind: (def: PropertyDef) => void;
	onClose: () => void;
	/** Suppress the panel's own header when hosted inside the comments tab strip
	 *  (the tab already says "Properties") — avoids a doubled header (F-252). */
	hideHeader?: boolean;
	/** A locked note: every row renders read-only and the add-property
	 *  affordance hides (the value writes are already no-ops upstream). */
	readOnly?: boolean;
};

export function PropertiesPanel({
	note,
	onSetValue,
	onClear,
	onBind,
	onClose,
	hideHeader,
	readOnly,
}: PropertiesPanelProps): JSX.Element {
	const { store, properties } = usePropertyStore();
	const addButtonRef = useRef<HTMLButtonElement | null>(null);

	const rows = useMemo<PropertiesPanelRow[]>(() => {
		const values: ValuesMap = note.values;
		const out: { key: string; def: PropertyDef }[] = [];
		for (const key of Object.keys(values)) {
			const def = properties.get(key);
			if (def) out.push({ key, def });
		}
		out.sort((a, b) => a.def.name.localeCompare(b.def.name));
		return out.map(({ def }) =>
			readOnly
				? { def, value: readValue(values, def), readOnly: true }
				: {
						def,
						value: readValue(values, def),
						onChange: (next: unknown) => onSetValue(def, next),
						onRemove: () => onClear(def.key),
					},
		);
	}, [note.values, properties, onSetValue, onClear, readOnly]);

	const meta = useMemo<PropertiesPanelMeta[]>(
		() => [
			{
				label: t("notes.properties.meta.created"),
				value: relativeTime(note.createdAt),
				title: new Date(note.createdAt).toLocaleString(),
			},
			{
				label: t("notes.properties.meta.updated"),
				value: relativeTime(note.updatedAt),
				title: new Date(note.updatedAt).toLocaleString(),
			},
		],
		[note.createdAt, note.updatedAt],
	);

	const openAddProperty = useCallback(() => {
		const rect = addButtonRef.current?.getBoundingClientRect();
		if (!rect) return;
		const target: AddPropertyTarget = {
			kind: AddPropertyTargetKind.BindToNote,
			anchor: rect,
			onPick: (propertyKey) => {
				const def = store.get(propertyKey);
				// MUST bind (kind-empty) via `onBind`, not `onSetValue` — the value
				// path treats an empty write as "unbind" and deletes the key.
				if (def) onBind(def);
			},
		};
		addPropertyStore.open(target);
	}, [store, onBind]);

	return (
		<SharedPropertiesPanel
			title={t("notes.properties.title")}
			rows={rows}
			entityId={note.id}
			emptyLabel={t("notes.properties.empty")}
			removeLabel={(name) => t("notes.properties.remove", { name })}
			{...(hideHeader ? { hideHeader: true } : { onClose })}
			closeLabel={t("notes.properties.hide")}
			{...(readOnly
				? {}
				: { onAdd: openAddProperty, addLabel: t("notes.properties.add"), addButtonRef })}
			meta={meta}
		/>
	);
}
