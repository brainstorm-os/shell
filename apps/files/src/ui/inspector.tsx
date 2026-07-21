/**
 * The right-hand inspector — Preview / Properties / Links tabs. Inspector
 * panels live on the right per the project-wide app-panel-sides
 * convention; the header shares the 44px / 1px-border panel chrome.
 */

import {
	CommentsPanel,
	CommentsProvider,
	localPresenceName,
	useCommentMutations,
	useEntityCommentsAdapter,
} from "@brainstorm-os/editor";
import { openEntity } from "@brainstorm-os/sdk";
import { type PropertyDef, ValueType, type VaultEntitiesService } from "@brainstorm-os/sdk-types";
import { Orientation, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import type { CoverPickerService } from "@brainstorm-os/sdk/cover-picker";
import { coverOf } from "@brainstorm-os/sdk/entity-cover";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { AddIconGlyph, openCoverPicker, openIconPicker } from "@brainstorm-os/sdk/picker-host";
import {
	PropertiesPanel,
	type PropertiesPanelMeta,
	type PropertiesPanelRow,
} from "@brainstorm-os/sdk/properties-panel";
import { t } from "../i18n";
import { humanLinkType } from "../logic/entity-links";
import { customPropertyRows } from "../logic/property-rows";
import { type FilesStore, InspectorTab } from "../store/use-files-store";
import { type Entity, FILE_TYPE, FOLDER_TYPE, readMembers, readName } from "../types/entity";
import type { BrainstormRuntime } from "../types/runtime";
import { formatBytes, readEntityIcon, typeLabel } from "./entity-view";
import { EntityCover, EntityIcon } from "./entity-visuals";
import { EditableField, fieldDef, readFieldValue, toStoredValue } from "./inspector-cells";

/** A read-only display row for the shared panel: a synthesised Text def for
 *  the label + the formatted value as the row's `valueNode` (plain text, no
 *  editing cell — these are formatted display strings, not typed vault values). */
function readonlyRow(key: string, label: string, value: string): PropertiesPanelRow {
	const def: PropertyDef = { key, name: label, icon: null, valueType: ValueType.Text };
	return { def, value, valueNode: value };
}

export type InspectorProps = {
	store: FilesStore;
	runtime: BrainstormRuntime | undefined;
};

const INSPECTOR_TABS = [
	[InspectorTab.Preview, "brainstorm.files.inspector.tabPreview"],
	[InspectorTab.Properties, "brainstorm.files.inspector.tabProperties"],
	[InspectorTab.Links, "brainstorm.files.inspector.tabLinks"],
	[InspectorTab.Comments, "brainstorm.files.inspector.tabComments"],
] as const;

/** Older shells / the preview drop don't expose the `covers` service. The
 *  picker still opens (gradient / color tabs work); the upload + library
 *  tabs reject gracefully. Mirrors the Bookmarks detail fallback. */
const COVERS_UNAVAILABLE: CoverPickerService = {
	uploadBytes: () => Promise.reject(new Error("covers service unavailable")),
	list: () => Promise.resolve([]),
};

export function Inspector({ store, runtime }: InspectorProps) {
	// KBN-A-files (inspector tabs): the Preview / Properties / Links tabs form a
	// horizontal tablist via the shared `useCompositeKeyboard` reducer — role +
	// roving tabindex + aria-selected come from the hook; ArrowLeft/Right rove and
	// select (selecting a tab === showing its panel, matching the click model).
	const activeTabIndex = Math.max(
		0,
		INSPECTOR_TABS.findIndex(([tab]) => tab === store.inspectorTab),
	);
	const { containerProps: tabsProps, getItemProps: getTabProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		role: "tablist",
		itemRole: "tab",
		count: INSPECTOR_TABS.length,
		activeIndex: activeTabIndex,
		onActiveIndexChange: (i) => {
			const entry = INSPECTOR_TABS[i];
			if (entry) store.setInspectorTab(entry[0]);
		},
	});

	if (!store.inspectorOpen) return null;
	const focused = store.focused;

	return (
		<aside
			className="inspector glass--strong"
			data-testid="inspector"
			aria-label={t("brainstorm.files.inspector.tabPreview")}
		>
			<header className="inspector__header" data-testid="inspector-header">
				<span className="inspector__title">{focused ? readName(focused) : ""}</span>
				<button
					type="button"
					className="bs-btn bs-btn--sm bs-btn--icon bs-btn--ghost"
					aria-label={t("brainstorm.files.actions.closeInspector")}
					onClick={store.toggleInspector}
				>
					<Icon name={IconName.Close} size={16} />
				</button>
			</header>
			<div
				{...tabsProps}
				className="inspector__tabs"
				aria-label={t("brainstorm.files.inspector.tabsRegion")}
			>
				{INSPECTOR_TABS.map(([tab, key], i) => (
					<button
						{...getTabProps(i)}
						key={tab}
						type="button"
						className="inspector__tab"
						data-active={store.inspectorTab === tab}
						onClick={() => store.setInspectorTab(tab)}
					>
						{t(key)}
					</button>
				))}
			</div>
			<div className="inspector__body" role="tabpanel">
				{!focused ? (
					<p className="inspector__empty">{t("brainstorm.files.inspector.emptySelection")}</p>
				) : store.inspectorTab === InspectorTab.Preview ? (
					<PreviewTab entity={focused} store={store} runtime={runtime} />
				) : store.inspectorTab === InspectorTab.Properties ? (
					<PropertiesTab entity={focused} store={store} />
				) : store.inspectorTab === InspectorTab.Comments ? (
					<CommentsTab entity={focused} runtime={runtime} />
				) : (
					<LinksTab store={store} entity={focused} runtime={runtime} />
				)}
			</div>
		</aside>
	);
}

function PreviewTab({
	entity,
	store,
	runtime,
}: {
	entity: Entity;
	store: FilesStore;
	runtime: BrainstormRuntime | undefined;
}) {
	const covers: CoverPickerService = runtime?.services?.covers ?? COVERS_UNAVAILABLE;
	const icon = readEntityIcon(entity);
	// Appearance is editable for folders only. Files have no
	// `entities.write:brainstorm/File/v1` capability, so a cover/icon write on a
	// file fails-closed and the optimistic state silently reverts — we must not
	// offer an affordance that can't persist. Editable file metadata is a
	// follow-up gated on that capability + a security pass.
	const editable = entity.type === FOLDER_TYPE;

	// The pickers mount at the document-body level (shared SDK picker-host
	// portal). The inspector panel is a transformed (`translateX`) overlay,
	// which creates a containing block for `position: fixed` descendants —
	// so an inline-rendered picker would be confined to the 320px panel.
	// The body-level bridge escapes that, matching every other app.
	const onEditCover = (): void => {
		openCoverPicker({
			value: coverOf(entity),
			covers,
			onChange: (cover) => store.setEntityCover(entity.id, cover),
		});
	};
	const onEditIcon = (): void => {
		openIconPicker({
			value: icon,
			onChange: (next) => store.setEntityIcon(entity.id, next),
		});
	};

	return (
		<div className="inspector__preview">
			{editable ? (
				<button
					type="button"
					className="inspector__preview-cover"
					aria-label={t("brainstorm.files.appearance.editCover")}
					aria-haspopup="dialog"
					onClick={onEditCover}
				>
					<EntityCover subject={entity} aspect={16 / 6} />
				</button>
			) : (
				<div className="inspector__preview-cover" data-static="true">
					<EntityCover subject={entity} aspect={16 / 6} />
				</div>
			)}
			{editable ? (
				<button
					type="button"
					className="inspector__preview-icon"
					data-empty={icon ? undefined : "true"}
					aria-label={t("brainstorm.files.appearance.editIcon")}
					aria-haspopup="dialog"
					onClick={onEditIcon}
				>
					{icon ? (
						<EntityIcon icon={icon} size={64} className="inspector__preview-glyph" />
					) : (
						<span className="inspector__preview-add-icon" aria-hidden="true">
							<AddIconGlyph />
						</span>
					)}
				</button>
			) : icon ? (
				<EntityIcon icon={icon} size={64} className="inspector__preview-glyph" />
			) : null}
			<p className="inspector__preview-name">{readName(entity)}</p>
			<p className="inspector__empty">{typeLabel(entity)}</p>
		</div>
	);
}

/** An editable scalar-text row for the shared panel — a synthesised Plain /
 *  Multiline def + the stored string mapped to the cell's `string | null`
 *  scalar; commits route back through the store's `entities.update` writer.
 *  No `<PropertiesProvider>` is needed: Plain / Multiline cells fall back to
 *  the SDK's default labels when no provider ancestor exists. */
function editableRow(
	entity: Entity,
	field: EditableField,
	label: string,
	onCommit: (value: string) => void,
): PropertiesPanelRow {
	return {
		def: fieldDef(field, label),
		value: readFieldValue(entity.properties, field),
		onChange: (next) => onCommit(toStoredValue(next)),
	};
}

/**
 * The Properties tab renders the entity's properties through the SHARED
 * `<PropertiesPanel>` content (`.bs-props` rows + meta) — identical to every
 * other app's inspector — hosted inside the Files-owned tab chrome (the header
 * is hidden; the tab strip already labels it "Properties"). Name + description
 * are editable for FOLDERS only (files have no `entities.write:brainstorm/File/v1`
 * cap, so a write fails-closed); everything else is read-only display. Created /
 * modified live in the shared `meta` footer, matching Notes / Books.
 */
function PropertiesTab({ entity, store }: { entity: Entity; store: FilesStore }) {
	const rows: PropertiesPanelRow[] = [];
	if (entity.type === FOLDER_TYPE) {
		rows.push(
			editableRow(entity, EditableField.Name, t("brainstorm.files.inspector.propertyName"), (v) =>
				store.setEntityName(entity.id, v),
			),
			editableRow(
				entity,
				EditableField.Description,
				t("brainstorm.files.inspector.propertyDescription"),
				(v) => store.setEntityDescription(entity.id, v),
			),
		);
	} else {
		rows.push(readonlyRow("name", t("brainstorm.files.inspector.propertyName"), readName(entity)));
	}

	rows.push(readonlyRow("type", t("brainstorm.files.inspector.propertyType"), typeLabel(entity)));
	if (entity.type === FILE_TYPE) {
		const mime = entity.properties.mime;
		const size = entity.properties.size;
		if (typeof mime === "string")
			rows.push(readonlyRow("mime", t("brainstorm.files.inspector.propertyMime"), mime));
		if (typeof size === "number")
			rows.push(readonlyRow("size", t("brainstorm.files.inspector.propertySize"), formatBytes(size)));
	}
	if (entity.type === FOLDER_TYPE) {
		rows.push(
			readonlyRow(
				"members",
				t("brainstorm.files.inspector.propertyMembers"),
				String(readMembers(entity).length),
			),
		);
	}
	// An entity's `properties` bag is open-ended (user-defined / app-written
	// keys); enumerate the rest so the tab isn't empty for them (F-files inspector).
	for (const row of customPropertyRows(entity.properties)) {
		rows.push(readonlyRow(row.key, row.label, row.value));
	}

	const meta: PropertiesPanelMeta[] = [
		{
			label: t("brainstorm.files.inspector.propertyCreated"),
			value: new Date(entity.createdAt).toLocaleString(),
		},
		{
			label: t("brainstorm.files.inspector.propertyModified"),
			value: new Date(entity.updatedAt).toLocaleString(),
		},
	];

	return <PropertiesPanel title="" hideHeader rows={rows} meta={meta} entityId={entity.id} />;
}

/** The Comments tab — the same shared comments thread every entity app shows,
 *  scoped to the focused file/folder. Hosted in Files' own 4-tab inspector
 *  (Preview / Properties / Links / Comments) rather than the 2-tab strip, so
 *  Files keeps its richer inspector while gaining comments. */
function CommentsTab({
	entity,
	runtime,
}: { entity: Entity; runtime: BrainstormRuntime | undefined }) {
	const mutations = useCommentMutations(runtime?.services?.entities);
	const adapter = useEntityCommentsAdapter(
		(runtime?.services?.vaultEntities ?? null) as unknown as VaultEntitiesService | null,
		mutations,
		entity.id,
	);
	if (!adapter) {
		return <p className="inspector__empty">{t("brainstorm.files.inspector.commentsUnavailable")}</p>;
	}
	return (
		<CommentsProvider adapter={adapter} authorName={localPresenceName()}>
			<CommentsPanel documentId={entity.id} />
		</CommentsProvider>
	);
}

function LinksTab({
	store,
	entity,
	runtime,
}: {
	store: FilesStore;
	entity: Entity;
	runtime: BrainstormRuntime | undefined;
}) {
	const { outgoing, incoming } = store.linksForFocused(entity.id);
	if (outgoing.length === 0 && incoming.length === 0) {
		return <p className="inspector__empty">{t("brainstorm.files.inspector.noLinks")}</p>;
	}
	return (
		<>
			{outgoing.length > 0 ? (
				<LinkSection
					title={t("brainstorm.files.inspector.linksOutgoing")}
					links={outgoing}
					pickOther={(l) => l.destEntityId}
					store={store}
					runtime={runtime}
				/>
			) : null}
			{incoming.length > 0 ? (
				<LinkSection
					title={t("brainstorm.files.inspector.linksIncoming")}
					links={incoming}
					pickOther={(l) => l.sourceEntityId}
					store={store}
					runtime={runtime}
				/>
			) : null}
		</>
	);
}

function LinkSection({
	title,
	links,
	pickOther,
	store,
	runtime,
}: {
	title: string;
	links: readonly { id: string; linkType: string; destEntityId: string; sourceEntityId: string }[];
	pickOther: (l: {
		destEntityId: string;
		sourceEntityId: string;
	}) => string;
	store: FilesStore;
	runtime: BrainstormRuntime | undefined;
}) {
	return (
		<section className="inspector__links-section">
			<h3 className="inspector__links-heading">{title}</h3>
			<ul className="inspector__links-list">
				{links.map((link) => {
					const otherId = pickOther(link);
					const meta = store.vaultIndex.get(otherId);
					const name = meta?.name ?? t("brainstorm.files.inspector.unknownEntity");
					const chip = humanLinkType(link.linkType);
					return (
						<li className="inspector__links-row" key={link.id}>
							<button
								type="button"
								className="inspector__links-target"
								disabled={!meta}
								title={meta ? t("brainstorm.files.inspector.openEntity", { name }) : undefined}
								aria-label={meta ? t("brainstorm.files.inspector.openEntity", { name }) : undefined}
								onClick={() => {
									if (!meta || !runtime) return;
									void openEntity(runtime, {
										entityId: meta.id,
										entityType: meta.type,
									});
								}}
							>
								{name}
							</button>
							{chip !== "" ? (
								<span className="inspector__links-chip" data-link-type={link.linkType}>
									{chip}
								</span>
							) : null}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
