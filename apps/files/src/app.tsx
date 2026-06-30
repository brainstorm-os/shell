/**
 * Files app — React + `@brainstorm/react-yjs` renderer (Stage 9.8.2b).
 *
 * Replaces the former plain-DOM `app.ts` preview drop. Every long-term
 * logic keystone (`FolderTree` + selection/rename/nav/search/preview-
 * siblings/entity-links/vault-tree reducers under `logic/`) is preserved
 * verbatim; only the DOM glue, the bespoke `ui/icons.ts` and the bespoke
 * `.modal`/New-popover are gone. Fundamentals now come from the shared
 * SDK: `<Icon>` / `<Popover>` / `<ObjectMenuTrigger>` / `useShortcut` /
 * `createT` / `<IconPicker>` / `<CoverPicker>` / entity-icon + entity-
 * cover DOM twins.
 *
 * The renderer binds to the EXISTING `vaultEntities.list` / `onChange`
 * preview read path. The shell root-Folder bootstrap landed
 * (`VaultSession.ensureRootFolder`): the vault's canonical root
 * `Folder/v1` is provisioned on open, so the tree resolves a real root
 * instead of a synthetic placeholder. `entities.subscribe` /
 * `ui.windows.setRoute` remain folded into the Stage 9.3 swap.
 *
 * `@brainstorm/react-yjs` is the app's CRDT seam. Files is read-only
 * over the `vaultEntities` snapshot today, so it does NOT install a
 * `<YDocProvider>` yet — per the package contract `useYDoc(entityId)`
 * needs the entities-service resolver that lands at Stage 9.3.2. When
 * that resolver ships, the Files window wraps in the SDK-provided
 * `<YDocProvider>` and per-Folder `useYDoc(folderId)` becomes a drop-in
 * (the store's snapshot path is the seam it replaces). The dependency +
 * import surface are wired now so that swap touches one file. The
 * resolver itself remains part of the Stage 9.3.2 entities-service work.
 */

import { openEntity, quickLookEntity } from "@brainstorm/sdk";
import type { StoredAsset } from "@brainstorm/sdk-types";
import { plural } from "@brainstorm/sdk/i18n";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { MenuAlign, openSearchPicker } from "@brainstorm/sdk/menus";
import { NavButtons } from "@brainstorm/sdk/nav-history";
import {
	ObjectMenuMoreButton,
	ObjectMenuTrigger,
	openAnchoredMenu,
} from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { SelectMenu, type SelectMenuOption } from "@brainstorm/sdk/select-menu";
import { useShortcut } from "@brainstorm/sdk/shortcut";
import { useCallback, useMemo, useRef, useState } from "react";
import { type TranslationKey, t } from "./i18n";
import { orderedSelection } from "./logic/bulk";
import { bulkRenamePlanAvoiding } from "./logic/bulk-rename";
import { destinationFolders } from "./logic/destination-folders";
import { buildPreviewSiblings } from "./logic/preview-siblings";
import { ScopeFlipAction, SearchScope, flipScope } from "./logic/search";
import type { SmartFolder } from "./logic/smart-folders";
import { SortDirection, SortKey } from "./logic/sort";
import { ActionId, chordFor } from "./shortcuts";
import { type FilesStore, useFilesStore } from "./store/use-files-store";
import { type Entity, FILE_TYPE, FOLDER_TYPE, readName } from "./types/entity";
import { Caret, CaretDirection } from "./ui/affordance";
import { BulkActionBar } from "./ui/bulk-action-bar";
import { ContentList } from "./ui/content-list";
import {
	AppearanceTarget,
	BulkDestinationMode,
	BulkRenamePopover,
	ConfirmDialog,
	FolderAppearanceDialog,
	SmartFolderNamePopover,
	SortMenuPopover,
} from "./ui/dialogs";
import { Inspector } from "./ui/inspector";
import { filesObjectMenuContext } from "./ui/object-menu-context";
import { SidebarSection, SidebarTree } from "./ui/sidebar-tree";
import { SmartFolderList } from "./ui/smart-folders";
import { StoragePanel } from "./ui/storage-panel";
import { useResizable } from "./ui/use-resizable";
import { SUPPORTED_VIEW_MODES, ViewMode } from "./view-mode";

const VIEW_MODE_LABEL_KEY: Record<ViewMode, TranslationKey> = {
	[ViewMode.List]: "brainstorm.files.view.list",
	[ViewMode.IconList]: "brainstorm.files.view.iconList",
	[ViewMode.Grid]: "brainstorm.files.view.grid",
	[ViewMode.Gallery]: "brainstorm.files.view.gallery",
	[ViewMode.Column]: "brainstorm.files.view.column",
};

type ConfirmState = {
	title: string;
	body: string;
	confirm: string;
	cancel: string;
	danger: boolean;
	acknowledge?: boolean;
	onConfirm: () => void;
} | null;

function scopeLabel(scope: SearchScope): string {
	if (scope === SearchScope.Subfolders) return t("brainstorm.files.search.scope.subfolders");
	if (scope === SearchScope.Vault) return t("brainstorm.files.search.scope.vault");
	return t("brainstorm.files.search.scope.active");
}

function sortLabel(key: SortKey): string {
	if (key === SortKey.Name) return t("brainstorm.files.sort.name");
	if (key === SortKey.Created) return t("brainstorm.files.sort.created");
	if (key === SortKey.Modified) return t("brainstorm.files.sort.modified");
	return t("brainstorm.files.sort.manual");
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}
function readNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Build the Preview-app folder context payload (sort+filter+search
 *  applied) so Preview's sibling walk matches what the user just saw.
 *  Verbatim from the former `app.ts:folderContextFor`. */
function folderContextFor(store: FilesStore, entity: Entity): Record<string, unknown> {
	const parentId = store.nav.current;
	if (!parentId) return {};
	const parent = store.tree.get(parentId);
	if (!parent || parent.type !== FOLDER_TYPE) return {};
	const siblings = buildPreviewSiblings(
		store.visibleRows.map((m) => ({
			id: m.id,
			type: m.type,
			name: readName(m),
			mime: readString(m.properties.mime),
			sizeBytes: readNumber(m.properties.size),
			modifiedAt: m.updatedAt,
			url: readString(m.properties.attachment),
		})),
		FILE_TYPE,
	);
	if (siblings.length <= 1 && !siblings.some((s) => s.id === entity.id)) return {};
	return {
		context: { kind: "folder", sourceId: parentId, label: readName(parent) },
		siblings,
	};
}

export function FilesApp() {
	const store = useFilesStore();
	const runtime = typeof window !== "undefined" ? window.brainstorm : undefined;

	const viewModeOptions = useMemo<readonly SelectMenuOption<ViewMode>[]>(
		() => SUPPORTED_VIEW_MODES.map((mode) => ({ value: mode, label: t(VIEW_MODE_LABEL_KEY[mode]) })),
		[],
	);

	const [confirm, setConfirm] = useState<ConfirmState>(null);
	const [sortMenuOpen, setSortMenuOpen] = useState(false);
	const [storageOpen, setStorageOpen] = useState(false);
	// Smart-folder name popover: `{ mode: "save" }` seeds from the active
	// query; `{ mode: "rename", folder }` seeds from the saved name.
	const [smartNamePrompt, setSmartNamePrompt] = useState<
		{ mode: "save" } | { mode: "rename"; folder: SmartFolder } | null
	>(null);
	const [appearance, setAppearance] = useState<{
		target: AppearanceTarget;
		folderId: string;
	} | null>(null);

	const searchInputRef = useRef<HTMLInputElement>(null);
	const newBtnRef = useRef<HTMLButtonElement>(null);

	// The header "New" picker — a "pick one of N" choice, so it opens through
	// the shared anchored fancy-menu (dropping from the + button), not a
	// bespoke centred popover.
	const openNewMenu = useCallback(() => {
		const el = newBtnRef.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		openAnchoredMenu(
			{ x: r.left, y: r.bottom + 4 },
			[
				{
					label: t("brainstorm.files.actions.newFolder"),
					icon: IconName.Folder,
					onSelect: store.newFolder,
				},
				{
					label: t("brainstorm.files.actions.newFile"),
					icon: IconName.KindFile,
					onSelect: store.newFile,
				},
			],
			{ menuLabel: t("brainstorm.files.actions.new"), anchor: el, align: MenuAlign.End },
		);
	}, [store.newFolder, store.newFile]);

	const sidebarResize = useResizable({
		side: "left",
		defaultWidth: 248,
		min: 180,
		max: 420,
		storageKey: "files:sidebar-width",
		cssVar: "--files-sidebar-width",
	});
	const inspectorResize = useResizable({
		side: "right",
		defaultWidth: 320,
		min: 220,
		max: 480,
		storageKey: "files:inspector-width",
		cssVar: "--files-inspector-width",
	});

	const openEntityFlow = useCallback(
		async (entity: Entity) => {
			if (entity.type === FOLDER_TYPE) {
				store.navigateToFolder(entity.id);
				return;
			}
			if (!runtime) return;
			const handled = await openEntity(runtime, {
				entityId: entity.id,
				entityType: entity.type,
				payload: folderContextFor(store, entity),
			});
			if (!handled) {
				console.warn(t("brainstorm.files.toast.openFallback", { type: entity.type }));
			}
		},
		[runtime, store],
	);

	const quickLookFlow = useCallback(async () => {
		const id = store.focusedId;
		if (!id) return;
		const entity = store.tree.get(id);
		if (!entity || !runtime) return;
		await quickLookEntity(runtime, {
			entityId: entity.id,
			entityType: entity.type,
			payload: folderContextFor(store, entity),
		});
	}, [runtime, store]);

	const loadStorageInventory = useCallback(
		() => runtime?.services?.files?.listStorageInventory?.() ?? Promise.resolve([]),
		[runtime],
	);

	const openStorageAsset = useCallback(
		(asset: StoredAsset) => {
			if (!runtime || asset.entityId === undefined) return;
			void openEntity(runtime, {
				entityId: asset.entityId,
				...(asset.entityType !== undefined ? { entityType: asset.entityType } : {}),
			});
			setStorageOpen(false);
		},
		[runtime],
	);

	// The breadcrumb's current folder IS an object — surface its menu in
	// the header (right-click the breadcrumb + a ⋯ button) so the user
	// doesn't have to navigate up and right-click the row. Reuses the
	// SAME builder the content rows use — no duplicate context.
	const currentFolderMenu = useCallback(() => {
		const folder = store.tree.get(store.nav.current);
		if (!folder) return null;
		return filesObjectMenuContext({
			entity: folder,
			store,
			runtime,
			onEditIcon: (folderId) => setAppearance({ target: AppearanceTarget.Icon, folderId }),
			onEditCover: (folderId) => setAppearance({ target: AppearanceTarget.Cover, folderId }),
		});
	}, [store, runtime]);

	const onCollision = useCallback(
		(draft: string) => {
			const folderName = store.tree.getName(store.nav.current) ?? "";
			setConfirm({
				title: t("brainstorm.files.collision.title"),
				body: t("brainstorm.files.collision.body", {
					name: draft,
					folder: folderName,
				}),
				confirm: t("brainstorm.files.collision.renameAnyway"),
				cancel: t("brainstorm.files.collision.cancel"),
				danger: false,
				onConfirm: () => store.resolveCollisionRenameAnyway(),
			});
		},
		[store],
	);

	const onCycle = useCallback(
		(movingId: string, destId: string) => {
			setConfirm({
				title: t("brainstorm.files.cycle.title"),
				body: t("brainstorm.files.cycle.body", {
					name: store.tree.getName(movingId) ?? "",
					dest: store.tree.getName(destId) ?? "",
				}),
				confirm: t("brainstorm.files.cycle.ok"),
				cancel: t("brainstorm.files.collision.cancel"),
				danger: false,
				acknowledge: true,
				onConfirm: () => {},
			});
		},
		[store],
	);

	const deleteSelected = useCallback(() => {
		const ids = Array.from(store.selection.selected);
		if (ids.length === 0) return;
		const names = ids
			.map((id) => store.tree.getName(id))
			.filter((n): n is string => typeof n === "string");
		setConfirm({
			title: t("brainstorm.files.delete.title"),
			body: plural(t, ids.length, "brainstorm.files.delete.bodyOne", "brainstorm.files.delete.bodyN", {
				name: names[0] ?? "",
			}),
			confirm: t("brainstorm.files.delete.confirm"),
			cancel: t("brainstorm.files.delete.cancel"),
			danger: true,
			onConfirm: () => store.deleteIds(ids),
		});
	}, [store]);

	// ─── Bulk Move / Copy / Rename (9.8.12) ──────────────────────────────
	const [bulkRenameOpen, setBulkRenameOpen] = useState(false);
	const selectionInVisibleOrder = useCallback(
		() =>
			orderedSelection(
				store.selection.selected,
				store.visibleRows.map((r) => r.id),
			),
		[store],
	);
	// Bulk move/copy destination: the shared searchable picker (`openSearchPicker`)
	// anchored to the toolbar button, replacing the centered `<div role="menu">`
	// folder list (F-300). Searching beats scrolling a deep folder tree.
	const openDestinationPicker = useCallback(
		(mode: BulkDestinationMode, anchor: HTMLElement) => {
			const folders = destinationFolders(store.tree, new Set(store.selection.selected));
			openSearchPicker({
				placeholder: t("brainstorm.files.bulk.searchDestinations"),
				ariaLabel:
					mode === BulkDestinationMode.Move
						? t("brainstorm.files.bulk.moveTitle")
						: t("brainstorm.files.bulk.copyTitle"),
				anchor,
				filter: (query) => {
					const needle = query.trim().toLowerCase();
					const matches = needle
						? folders.filter((f) => f.name.toLowerCase().includes(needle))
						: folders;
					if (matches.length === 0) {
						return [{ id: "", label: t("brainstorm.files.bulk.noDestinations"), disabled: true }];
					}
					return matches.map((f) => ({
						id: f.id,
						label: f.name,
						icon: <Icon name={IconName.Folder} size={14} />,
					}));
				},
				onSelect: (destId) => {
					if (!destId) return;
					const ids = selectionInVisibleOrder();
					if (ids.length === 0) return;
					if (mode === BulkDestinationMode.Move) {
						const result = store.moveIds(store.nav.current, destId, ids);
						if (!result.ok && result.reason === "cycle") onCycle(ids[0] ?? "", destId);
					} else {
						store.copyIds(destId, ids);
					}
					store.clearSelection();
				},
			});
		},
		[selectionInVisibleOrder, store, onCycle],
	);
	const onBulkRename = useCallback(
		(base: string) => {
			setBulkRenameOpen(false);
			const ids = selectionInVisibleOrder();
			const selectedSet = new Set(ids);
			// Names already occupied by NON-selected siblings in the current
			// folder — the bulk numbering must step past these so a renamed
			// item never collides with an untouched neighbour (single-rename
			// has the same guard via `tree.hasNameCollision`).
			const taken = new Set<string>();
			for (const member of store.tree.listFolderMembers(store.nav.current)) {
				if (!selectedSet.has(member.id)) taken.add(store.tree.getName(member.id) ?? "");
			}
			const plan = bulkRenamePlanAvoiding(
				base,
				ids.map((id) => store.tree.getName(id) ?? ""),
				taken,
			);
			ids.forEach((id, index) => {
				const name = plan[index];
				if (name) store.setEntityName(id, name);
			});
		},
		[selectionInVisibleOrder, store],
	);
	// ─── Keyboard (shared SDK useShortcut, chords from the registry) ──────
	const chord = (id: ActionId) => chordFor(id) ?? "";
	useShortcut(chord(ActionId.Search), () => searchInputRef.current?.focus());
	useShortcut(chord(ActionId.ToggleSidebar), store.toggleNav);
	useShortcut(chord(ActionId.ToggleInspector), store.toggleInspector);
	useShortcut(chord(ActionId.NewFolder), store.newFolder);
	useShortcut(chord(ActionId.NewMenu), openNewMenu);
	useShortcut(chord(ActionId.Rename), store.startRenameOnAnchor);
	useShortcut(chord(ActionId.RenameAlt), store.startRenameOnAnchor);
	useShortcut(chord(ActionId.QuickLook), () => void quickLookFlow());
	useShortcut(chord(ActionId.Delete), deleteSelected);
	useShortcut(chord(ActionId.DeleteAlt), deleteSelected);
	useShortcut(chord(ActionId.Duplicate), () =>
		store.duplicateIds(Array.from(store.selection.selected)),
	);
	useShortcut(chord(ActionId.SelectAll), store.selectAllVisible);
	useShortcut(chord(ActionId.Back), store.navigateBackOnce);
	useShortcut(chord(ActionId.Forward), store.navigateForwardOnce);
	useShortcut(chord(ActionId.Up), store.navigateUp);
	useShortcut(chord(ActionId.Open), () => {
		for (const id of store.selection.selected) {
			const e = store.tree.get(id);
			if (e) void openEntityFlow(e);
		}
	});
	useShortcut(chord(ActionId.PopoverClose), () => {
		setConfirm(null);
		setSortMenuOpen(false);
		setAppearance(null);
	});

	const appearanceFolderRaw = appearance ? store.tree.get(appearance.folderId) : undefined;
	const appearanceFolder =
		appearanceFolderRaw?.type === FOLDER_TYPE ? appearanceFolderRaw : undefined;
	const appearanceTargetOrIcon = appearance?.target ?? AppearanceTarget.Icon;

	return (
		<>
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<NavButtons
						history={store.navHistory}
						onNavigate={store.applyFolderLocation}
						labels={{
							back: t("brainstorm.files.actions.back"),
							forward: t("brainstorm.files.actions.forward"),
						}}
						bindShortcuts={false}
					/>
					<ObjectMenuTrigger
						context={currentFolderMenu}
						moreActionsLabel={t("brainstorm.files.menu.more")}
						className="breadcrumb__menu-host"
						noMoreButton
					>
						<nav className="breadcrumb" aria-label={t("brainstorm.files.breadcrumb.label")}>
							{store.breadcrumb.map((crumb, index) => (
								<span key={crumb.id} style={{ display: "contents" }}>
									{crumb.collapsed ? (
										<span
											className="breadcrumb__ellipsis"
											aria-label={t("brainstorm.files.breadcrumb.collapsed")}
										>
											{crumb.label}
										</span>
									) : crumb.isCurrent ? (
										/* The current location IS the window's title — it carries the
										   shared title face (F-220), never a per-app font fork. */
										<span
											className="breadcrumb__segment app-header__title"
											data-current="true"
											aria-current="page"
										>
											{crumb.label}
										</span>
									) : (
										<button
											type="button"
											className="breadcrumb__segment"
											onClick={() => store.navigateToFolder(crumb.id)}
										>
											{crumb.label}
										</button>
									)}
									{index < store.breadcrumb.length - 1 ? (
										<span className="breadcrumb__separator" aria-hidden="true">
											<Caret direction={CaretDirection.Right} size={10} />
										</span>
									) : null}
								</span>
							))}
						</nav>
					</ObjectMenuTrigger>
				</div>
				<div className="app-header__right">
					<button
						ref={newBtnRef}
						type="button"
						className="header-icon-btn"
						data-testid="toolbar-new"
						aria-haspopup="menu"
						aria-label={t("brainstorm.files.actions.new")}
						data-bs-tooltip={t("brainstorm.files.actions.new")}
						onClick={openNewMenu}
					>
						<Icon name={IconName.Plus} size={16} />
					</button>
					<PanelToggleButton
						side={PanelSide.Left}
						open={store.navOpen}
						onClick={store.toggleNav}
						labels={{
							show: t("brainstorm.files.actions.showSidebar"),
							hide: t("brainstorm.files.actions.hideSidebar"),
						}}
						testId="toolbar-sidebar"
					/>
					<PanelToggleButton
						side={PanelSide.Right}
						open={store.inspectorOpen}
						onClick={store.toggleInspector}
						labels={{
							show: t("brainstorm.files.actions.showInspector"),
							hide: t("brainstorm.files.actions.hideInspector"),
						}}
						testId="toolbar-inspector"
					/>
					{/* The object ⋯ menu is the LAST element in `.app-header__right`
					    (cross-app convention); the breadcrumb keeps its right-click
					    trigger via the `noMoreButton` ObjectMenuTrigger above. */}
					<ObjectMenuMoreButton
						context={currentFolderMenu}
						moreActionsLabel={t("brainstorm.files.menu.more")}
					/>
				</div>
			</header>

			<main className="window" id="window">
				<aside
					className="sidebar"
					data-testid="sidebar"
					aria-label={t("brainstorm.files.sidebar.label")}
					aria-hidden={!store.navOpen}
					inert={!store.navOpen ? true : undefined}
				>
					<SidebarSection titleKey="brainstorm.files.sidebar.folders">
						<SidebarTree store={store} onCycle={onCycle} />
					</SidebarSection>
					{/* Smart folders (saved searches) only appear once there are any —
					    an empty labelled shelf reads as a layout gap (F-047). "Tags"
					    stays unbuilt and unadvertised. */}
					{store.smartFolders.length > 0 ? (
						<SidebarSection titleKey="brainstorm.files.sidebar.smartFolders">
							<SmartFolderList
								folders={store.smartFolders}
								onActivate={store.activateSmartFolder}
								onRename={(folder) => setSmartNamePrompt({ mode: "rename", folder })}
								onDelete={store.deleteSmartFolderById}
							/>
						</SidebarSection>
					) : null}
					{/* Storage location — a Finder-style place that opens the
					    cross-store media inventory. A real sidebar location, not a
					    toolbar button bolted on. */}
					{runtime?.services?.files?.listStorageInventory ? (
						<SidebarSection titleKey="brainstorm.files.sidebar.storage">
							<ul className="sidebar__list">
								<li>
									<button
										type="button"
										className="sidebar__tree-row"
										data-testid="sidebar-storage"
										aria-current={storageOpen ? "true" : undefined}
										style={{ paddingLeft: "12px" }}
										onClick={() => setStorageOpen(true)}
									>
										<span className="sidebar__chevron sidebar__chevron--hidden" aria-hidden="true" />
										<Icon name={IconName.Archive} size={16} className="sidebar__glyph" />
										<span className="sidebar__name">{t("brainstorm.files.storage.allMedia")}</span>
									</button>
								</li>
							</ul>
						</SidebarSection>
					) : null}
				</aside>

				<section
					className="content"
					data-testid="content"
					aria-label={t("brainstorm.files.content.label")}
				>
					<div className="toolbar" data-testid="toolbar">
						<div className="toolbar__group toolbar__group--start">
							<label className="toolbar__search bs-input bs-input--sm">
								<span aria-hidden="true" className="toolbar__search-glyph">
									<Icon name={IconName.Search} size={15} />
								</span>
								<input
									ref={searchInputRef}
									className="toolbar__search-input"
									type="search"
									data-testid="toolbar-search-input"
									placeholder={t("brainstorm.files.search.placeholderFolder")}
									value={store.searchQuery}
									onChange={(e) => store.setSearchQuery(e.target.value)}
								/>
								{store.searchQuery.trim() !== "" ? (
									<button
										type="button"
										className="toolbar__scope"
										data-testid="toolbar-scope"
										data-scope={store.searchScope}
										onClick={() => {
											// 9.8.9 — vault position flips to the shell's global
											// search palette when the shell exposes it; the app's
											// own search closes (the palette owns the query now).
											const openSearch = runtime?.services?.ui?.openSearch;
											const flip = flipScope(store.searchScope, typeof openSearch === "function");
											if (flip.action === ScopeFlipAction.LauncherHandoff && openSearch) {
												openSearch({ query: store.searchQuery.trim() }).catch((error: unknown) => {
													console.warn("[files] search handoff failed:", error);
												});
												store.setSearchQuery("");
												store.setSearchScope(SearchScope.ActiveFolder);
												return;
											}
											if (flip.action === ScopeFlipAction.SetScope) {
												store.setSearchScope(flip.scope);
											}
										}}
									>
										{scopeLabel(store.searchScope)}
									</button>
								) : null}
							</label>
							{store.searchQuery.trim() !== "" ? (
								<button
									type="button"
									className="toolbar__save-search"
									data-testid="toolbar-save-search"
									data-bs-tooltip={t("brainstorm.files.smart.save")}
									aria-label={t("brainstorm.files.smart.save")}
									onClick={() => setSmartNamePrompt({ mode: "save" })}
								>
									<Icon name={IconName.Sparkle} size={15} />
									<span className="toolbar__save-search-label">{t("brainstorm.files.smart.save")}</span>
								</button>
							) : null}
						</div>
						<div className="toolbar__group toolbar__group--end">
							<button
								type="button"
								className="toolbar__sort"
								data-testid="toolbar-sort"
								aria-haspopup="menu"
								aria-expanded={sortMenuOpen}
								title={t("brainstorm.files.sort.label")}
								onClick={() => setSortMenuOpen((open) => !open)}
							>
								<span className="toolbar__sort-label">
									{t("brainstorm.files.sort.label")}: {sortLabel(store.sortKey)}
								</span>
								<span aria-hidden="true" className="toolbar__sort-arrow">
									<Icon
										name={store.sortDirection === SortDirection.Asc ? IconName.CaretUp : IconName.CaretDown}
										size={12}
									/>
								</span>
							</button>
							<SelectMenu<ViewMode>
								className="view-switch"
								data-testid="view-switch"
								ariaLabel={t("brainstorm.files.view.label")}
								value={store.viewMode}
								options={viewModeOptions}
								onChange={store.setViewMode}
							/>
						</div>
					</div>

					<ContentList
						store={store}
						runtime={runtime}
						onOpen={(e) => void openEntityFlow(e)}
						onCollision={onCollision}
						onCycle={onCycle}
						onEditIcon={(folderId) => setAppearance({ target: AppearanceTarget.Icon, folderId })}
						onEditCover={(folderId) => setAppearance({ target: AppearanceTarget.Cover, folderId })}
					/>

					<BulkActionBar
						count={store.selection.selected.size}
						onDuplicate={() => store.duplicateIds(selectionInVisibleOrder())}
						onMove={(anchor) => openDestinationPicker(BulkDestinationMode.Move, anchor)}
						onCopy={(anchor) => openDestinationPicker(BulkDestinationMode.Copy, anchor)}
						onRename={() => setBulkRenameOpen(true)}
						onDelete={deleteSelected}
						onClear={store.clearSelection}
					/>
				</section>

				<div
					className="window-resize window-resize--sidebar"
					role="separator"
					aria-orientation="vertical"
					aria-label={t("brainstorm.files.actions.resizeSidebar")}
					tabIndex={0}
					ref={sidebarResize}
				/>
				<div
					className="window-resize window-resize--inspector"
					role="separator"
					aria-orientation="vertical"
					aria-label={t("brainstorm.files.actions.resizeInspector")}
					tabIndex={0}
					ref={inspectorResize}
				/>
				<Inspector store={store} runtime={runtime} />
			</main>

			{storageOpen ? (
				<StoragePanel
					loadInventory={loadStorageInventory}
					onOpen={openStorageAsset}
					onClose={() => setStorageOpen(false)}
				/>
			) : null}

			{sortMenuOpen ? (
				<SortMenuPopover
					current={store.sortKey}
					direction={store.sortDirection}
					groupKey={store.groupKey}
					tileSize={store.tileSize}
					listColumns={store.listColumns}
					onSelect={(key) => {
						store.setSortKey(key);
						setSortMenuOpen(false);
					}}
					onToggleDirection={() => {
						store.toggleSortDirection();
						setSortMenuOpen(false);
					}}
					onSelectGroup={(key) => {
						store.setGroupKey(key);
						setSortMenuOpen(false);
					}}
					onSelectTileSize={(size) => {
						store.setTileSize(size);
						setSortMenuOpen(false);
					}}
					onToggleColumn={(column) => {
						store.toggleColumn(column);
					}}
					onApplyToAll={() => {
						store.applyViewToAllFolders();
						setSortMenuOpen(false);
					}}
					onClose={() => setSortMenuOpen(false)}
				/>
			) : null}

			{smartNamePrompt ? (
				<SmartFolderNamePopover
					title={
						smartNamePrompt.mode === "save"
							? t("brainstorm.files.smart.saveTitle")
							: t("brainstorm.files.smart.renameTitle")
					}
					initialName={
						smartNamePrompt.mode === "save" ? store.searchQuery.trim() : smartNamePrompt.folder.name
					}
					placeholder={t("brainstorm.files.smart.namePlaceholder")}
					submitLabel={t("brainstorm.files.smart.saveAction")}
					onSubmit={(name) => {
						if (smartNamePrompt.mode === "save") store.saveSearchAsSmartFolder(name);
						else store.renameSmartFolderById(smartNamePrompt.folder.id, name);
					}}
					onClose={() => setSmartNamePrompt(null)}
				/>
			) : null}

			{bulkRenameOpen ? (
				<BulkRenamePopover
					count={store.selection.selected.size}
					onSubmit={onBulkRename}
					onClose={() => setBulkRenameOpen(false)}
				/>
			) : null}

			{confirm ? (
				<ConfirmDialog
					title={confirm.title}
					body={confirm.body}
					confirm={confirm.confirm}
					cancel={confirm.cancel}
					danger={confirm.danger}
					{...(confirm.acknowledge ? { acknowledge: true } : {})}
					onConfirm={confirm.onConfirm}
					onClose={() => setConfirm(null)}
				/>
			) : null}

			{appearanceFolder ? (
				<FolderAppearanceDialog
					target={appearanceTargetOrIcon}
					icon={(appearanceFolder.properties.icon as never) ?? null}
					cover={(appearanceFolder.properties.cover as never) ?? null}
					covers={runtime?.services?.covers}
					onChangeIcon={(icon) => store.setEntityIcon(appearanceFolder.id, icon)}
					onChangeCover={(cover) => store.setEntityCover(appearanceFolder.id, cover)}
					onClose={() => setAppearance(null)}
				/>
			) : null}
		</>
	);
}
