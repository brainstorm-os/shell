/**
 * Inspector pane — right-hand panel showing the active file's metadata.
 * Per [[app-panel-sides]] inspector panels live on the right; it floats as
 * a `.glass--strong` overlay above the stage and slides in/out via the
 * `preview--inspector-collapsed` modifier on the root.
 *
 * Consistent with every other app's right panel (Notes / Journal): when the
 * previewed file is a vault entity AND the shell exposes the property catalog,
 * the inspector renders the shared editable `EntityPropertiesPanel` (vault
 * properties as editable rows) wrapped in the shared `CommentsRightPanel`
 * Properties | Comments tab strip. The file's intrinsic facts (MIME / size /
 * modified) and any renderer-extracted metadata (PDF author, image dimensions)
 * are READ-ONLY display strings, so they ride the panel's `meta` footer rather
 * than masquerading as editable rows.
 *
 * Standalone / demo files (no vault entity) or an older shell with no property
 * catalog fall back to the read-only facts panel — the same shared
 * `<PropertiesPanel>` chrome, just display-only.
 */

import {
	CommentsProvider,
	CommentsRightPanel,
	type RightPanelTab,
	localPresenceName,
} from "@brainstorm-os/editor";
import { useVaultEntities } from "@brainstorm-os/react-yjs";
import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import {
	PropertiesPanel,
	type PropertiesPanelMeta,
	type PropertiesPanelRow,
} from "@brainstorm-os/sdk/properties-panel";
import { EntityPropertiesPanel, PropertiesProvider } from "@brainstorm-os/sdk/property-ui";
import { type ReactElement, useCallback, useMemo } from "react";
import { humaniseBytes, humaniseDate, humaniseMime } from "../host/inspector-format";
import type { PreviewRuntime } from "../host/runtime";
import { t } from "../i18n";
import { entityValuesFromSnapshot } from "../logic/entity-values";
import { usePreviewCommentsAdapter } from "../store/comments-bindings";
import type { PreviewFileInfo } from "../types/preview-module";

export type InspectorPairs = ReadonlyArray<readonly [label: string, value: string]>;

export type InspectorProps = {
	runtime: PreviewRuntime | undefined;
	file: PreviewFileInfo | null;
	/** The previewed file's vault entity id, or null for a demo / intent-pushed
	 *  sibling that has no entity (then the panel is read-only facts). */
	entityId: string | null;
	pairs: InspectorPairs;
	activeTab: RightPanelTab;
	onTabChange: (tab: RightPanelTab) => void;
	onClose: () => void;
};

/** The file's intrinsic + renderer-extracted facts, read-only. Shown as the
 *  panel's `meta` footer in the editable view, or as the whole body (rows) in
 *  the read-only fallback. */
function factPairs(file: PreviewFileInfo, pairs: InspectorPairs): InspectorPairs {
	return [
		[t("inspector.type"), humaniseMime(file.mime)],
		[t("inspector.size"), file.sizeBytes != null ? humaniseBytes(file.sizeBytes) : "—"],
		[t("inspector.modified"), file.modifiedAt != null ? humaniseDate(file.modifiedAt) : "—"],
		...pairs,
	];
}

export function Inspector(props: InspectorProps): ReactElement {
	const { runtime, file, entityId } = props;
	const editable = Boolean(runtime?.services?.properties && entityId && file);
	if (editable && file && entityId) {
		return <EditableInspector {...props} file={file} entityId={entityId} />;
	}
	return <FactsInspector file={file} pairs={props.pairs} onClose={props.onClose} />;
}

/** Read-only fallback: file facts as display rows. Used for standalone / demo
 *  files and shells without a property catalog. */
function FactsInspector({
	file,
	pairs,
	onClose,
}: {
	file: PreviewFileInfo | null;
	pairs: InspectorPairs;
	onClose: () => void;
}): ReactElement {
	if (!file) {
		return (
			<PropertiesPanel
				title={t("inspector.title")}
				rows={[]}
				entityId=""
				emptyLabel={t("inspector.empty")}
				onClose={onClose}
				closeLabel={t("menu.hideInspector")}
			/>
		);
	}
	const rows: PropertiesPanelRow[] = factPairs(file, pairs).map(([label, value], i) => {
		const def: PropertyDef = { key: `r${i}`, name: label, icon: null, valueType: ValueType.Text };
		return { def, value, valueNode: value };
	});
	return (
		<PropertiesPanel
			title={file.name}
			rows={rows}
			entityId={file.name}
			onClose={onClose}
			closeLabel={t("menu.hideInspector")}
		/>
	);
}

/** Editable view: vault properties as editable rows + the file facts as the
 *  `meta` footer, all inside the shared Properties | Comments tab strip. */
function EditableInspector({
	runtime,
	file,
	entityId,
	pairs,
	activeTab,
	onTabChange,
	onClose,
}: InspectorProps & { file: PreviewFileInfo; entityId: string }): ReactElement {
	const vaultEntities = runtime?.services?.vaultEntities ?? null;
	const snapshot = useVaultEntities(vaultEntities);
	const values = useMemo(
		() => entityValuesFromSnapshot(snapshot, entityId) ?? {},
		[snapshot, entityId],
	);

	const updateEntity = runtime?.services?.entities?.update;
	const canMutate = Boolean(updateEntity);
	const writeValues = useCallback(
		(next: Record<string, unknown>): void => {
			if (!updateEntity) return;
			void (async () => {
				try {
					await updateEntity.call(runtime?.services?.entities, entityId, { values: next });
				} catch (error) {
					console.warn("[preview] entities.update values failed:", error);
				}
			})();
		},
		[updateEntity, runtime, entityId],
	);

	const meta = useMemo<PropertiesPanelMeta[]>(
		() => factPairs(file, pairs).map(([label, value]) => ({ label, value })),
		[file, pairs],
	);

	// The PropertiesProvider needs only the properties service. The Preview
	// runtime type lists a narrow surface; the preload exposes the full
	// service, so cast through unknown (mirrors Journal).
	const propertiesRuntime = useMemo(() => {
		const properties = runtime?.services?.properties;
		if (!properties) return null;
		return { services: { properties } } as unknown as Parameters<
			typeof PropertiesProvider
		>[0]["runtime"];
	}, [runtime]);

	const adapter = usePreviewCommentsAdapter(entityId);

	const tabbed = Boolean(adapter);
	const propertiesPanel = (
		<EntityPropertiesPanel
			title={t("inspector.properties")}
			entityId={entityId}
			values={values}
			canMutate={canMutate}
			onWriteValues={writeValues}
			emptyLabel={t("inspector.noProperties")}
			addLabel={t("inspector.addProperty")}
			removeLabel={(name) => t("inspector.removeProperty", { name })}
			meta={meta}
			closeLabel={t("menu.hideInspector")}
			{...(tabbed ? { hideHeader: true } : { onClose })}
		/>
	);

	const withProvider = propertiesRuntime ? (
		<PropertiesProvider runtime={propertiesRuntime}>{propertiesPanel}</PropertiesProvider>
	) : (
		propertiesPanel
	);

	if (!adapter) return withProvider;
	return (
		<CommentsProvider adapter={adapter} authorName={localPresenceName()}>
			<CommentsRightPanel
				documentId={entityId}
				active={activeTab}
				onTabChange={onTabChange}
				properties={withProvider}
			/>
		</CommentsProvider>
	);
}
