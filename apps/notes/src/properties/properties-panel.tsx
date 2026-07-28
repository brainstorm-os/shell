/**
 * PropertiesPanel (Notes) — a thin adapter over the SHARED
 * `@brainstorm-os/sdk/property-ui` `<EntityPropertiesPanel>` (Props-4): the
 * open note's `values` bag becomes editable rows + remove + the shared rich
 * add-property picker; Notes supplies only the whole-bag persister, the
 * created/updated `meta` footer, and its localised picker labels (the same
 * `useNotesPickerLabels` set the editor's `/property` flow uses, so the two
 * mount points of the one picker can never drift). The resizable glass
 * container (`.notes__props`) stays in `app.tsx`.
 */

import { EntityPropertiesPanel, type ValuesMap } from "@brainstorm-os/sdk/property-ui";
import { type JSX, useMemo } from "react";
import { t } from "../i18n/t";
import type { StoredNote } from "../store/note";
import { relativeTime } from "../ui/relative-time";
import { useNotesPickerLabels } from "./picker-labels";

export type PropertiesPanelProps = {
	note: StoredNote;
	/** Persist the note's next whole values bag (bind / edit / clear all
	 *  funnel through it). The host gates it on the note's lock. */
	onWriteValues: (next: ValuesMap) => void;
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
	onWriteValues,
	onClose,
	hideHeader,
	readOnly,
}: PropertiesPanelProps): JSX.Element {
	const pickerLabels = useNotesPickerLabels();

	const meta = useMemo(
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

	return (
		<EntityPropertiesPanel
			title={t("notes.properties.title")}
			entityId={note.id}
			values={note.values}
			canMutate={!readOnly}
			onWriteValues={onWriteValues}
			emptyLabel={t("notes.properties.empty")}
			addLabel={t("notes.properties.add")}
			removeLabel={(name) => t("notes.properties.remove", { name })}
			pickerLabels={pickerLabels}
			meta={meta}
			closeLabel={t("notes.properties.hide")}
			{...(hideHeader ? { hideHeader: true } : { onClose })}
		/>
	);
}
