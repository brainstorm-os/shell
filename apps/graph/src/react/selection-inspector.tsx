/**
 * SelectionInspector (9.13.11) — the editable property panel for the canvas
 * click-selection. One selected node ⇒ its title + scalar properties rendered
 * through the SHARED `<PropertiesPanel>` (`.bs-props` content + the same
 * `@brainstorm-os/sdk/property-ui` cells every other app uses), writing through
 * `onCommit` → `entities.update`. Two or more ⇒ a count summary (bulk edit is
 * forward scope). Zero ⇒ renders nothing.
 *
 * Graph keeps its OWN container — the floating `.graph-inspector` overlay
 * pinned to the canvas's bottom-left corner — and hosts the shared panel
 * content inside it, exactly the "app owns the container, SDK owns the content"
 * split Notes / Contacts / Bookmarks follow. The Name field is the first row so
 * it stays inline-editable (the inspector is the only edit surface for a node).
 */

import { EntityCommentsPanel, type EntityCommentsServices } from "@brainstorm-os/editor";
import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { PropertiesPanel, type PropertiesPanelRow } from "@brainstorm-os/sdk/properties-panel";
import type { ReactElement } from "react";
import { plural, t } from "../i18n/t";
import type { EntityRow } from "../logic/in-memory-graph";
import { editableInspectorFields, inspectorTitle } from "../logic/inspector-fields";

export type SelectionInspectorProps = {
	selectedCount: number;
	/** The single selected entity (null when 0 or >1 selected). */
	entity: EntityRow | null;
	onCommit: (entityId: string, key: string, value: unknown) => void;
	/** Live vault snapshot + entities mutation surface for the Comments tab.
	 *  Absent on an older shell → properties-only (no tab strip). */
	services?: EntityCommentsServices;
};

export function SelectionInspector({
	selectedCount,
	entity,
	onCommit,
	services,
}: SelectionInspectorProps): ReactElement | null {
	if (selectedCount === 0) return null;
	if (selectedCount > 1 || !entity) {
		return (
			<aside className="graph-inspector" aria-label={t("inspector.label")}>
				<p className="graph-inspector__count">
					{plural(selectedCount, "inspector.multi.one", "inspector.multi.other", {
						count: selectedCount,
					})}
				</p>
			</aside>
		);
	}

	const nameDef: PropertyDef = {
		key: "name",
		name: t("inspector.nameField"),
		icon: null,
		valueType: ValueType.Text,
	};
	const rows: PropertiesPanelRow[] = [
		{
			def: nameDef,
			value: inspectorTitle(entity),
			onChange: (v) => onCommit(entity.id, "name", v),
		},
		...editableInspectorFields(entity).map((field) => ({
			def: field.def,
			value: field.value,
			onChange: (v: unknown) => onCommit(entity.id, field.key, v),
		})),
	];

	return (
		<aside
			className="graph-inspector"
			aria-label={t("inspector.label")}
			data-testid="graph-inspector"
		>
			<EntityCommentsPanel
				services={services}
				documentId={entity.id}
				properties={({ tabbed }) => (
					<PropertiesPanel
						title={t("inspector.label")}
						rows={rows}
						entityId={entity.id}
						{...(tabbed ? { hideHeader: true } : {})}
					/>
				)}
			/>
		</aside>
	);
}
