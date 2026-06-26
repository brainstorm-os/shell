/**
 * The Files app store hook — the React seam over the long-term logic
 * keystones (`FolderTree` + selection/rename/nav/search reducers).
 *
 * The renderer was rewritten React-first at 9.8.2b; every reducer,
 * algorithm and command from the former plain-DOM `app.ts` is preserved
 * verbatim — only the DOM glue is gone. The store binds to the EXISTING
 * `vaultEntities.list` / `onChange` preview read path (Stage 9.13.1.8);
 * the real entities-service swap (Stage 9.3) replaces only the broker
 * registration behind that, never this hook.
 *
 * The shell root-Folder bootstrap landed (`VaultSession.ensureRootFolder`
 * → `ROOT_FOLDER_ID`): on vault open the canonical root `Folder/v1` is
 * provisioned in `entities.db`, so the snapshot carries a real root row
 * and the tree binds to it (`buildVaultFileTree` prefers it, synthesising
 * only when an older vault lacks it). `entities.subscribe` / `ui.windows.
 * setRoute` remain folded into the Stage 9.3 entities-service swap, which
 * replaces only the read source behind this hook.
 */

import { useOptionalYDocResolver } from "@brainstorm/react-yjs";
import { type NavHistory, createNavHistory } from "@brainstorm/sdk/nav-history";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { type BreadcrumbSegment, deriveBreadcrumbs } from "../logic/breadcrumbs";
import {
	type OpenerMeta,
	browsableTypeSet,
	openerFromHandlers,
	unresolvedTypes,
} from "../logic/browsable-types";
import { type EntityLink, partitionLinksForEntity } from "../logic/entity-links";
import { FolderTree } from "../logic/folder-tree";
import { DEFAULT_GROUP_KEY, type EntityGroup, GroupKey, groupEntities } from "../logic/group";
import { DEFAULT_LIST_COLUMNS, type ListColumn, toggleListColumn } from "../logic/list-columns";
import { IDLE_RENAME, type RenameState, RenameStatus, renameReducer } from "../logic/rename";
import { SearchScope, runSearch } from "../logic/search";
import {
	EMPTY_SELECTION,
	SelectionModifier,
	type SelectionState,
	selectionReducer,
} from "../logic/selection";
import {
	type SmartFolder,
	deleteSmartFolder,
	readSmartFolders,
	renameSmartFolder,
	saveSmartFolder,
} from "../logic/smart-folders";
import {
	DEFAULT_SORT_DIRECTION,
	DEFAULT_SORT_KEY,
	SortDirection,
	type SortKey,
	defaultDirectionFor,
	sortEntities,
} from "../logic/sort";
import { collisionName, mimeFromName, sha256Hex } from "../logic/upload";
import { buildVaultFileTree } from "../logic/vault-tree";
import {
	applyViewOptionsToAllFolders,
	readViewOptions,
	writeViewOptions,
} from "../logic/view-options";
import {
	type Entity,
	FILE_TYPE,
	FOLDER_TYPE,
	ROOT_FOLDER_ID,
	readMembers,
	readName,
} from "../types/entity";
import type { VaultEntityShape, VaultLinkShape } from "../types/runtime";
import { DEFAULT_TILE_SIZE, type TileSize, ViewMode } from "../view-mode";

export enum InspectorTab {
	Preview = "preview",
	Properties = "properties",
	Links = "links",
	Comments = "comments",
}

export enum ClipboardMode {
	Cut = "cut",
	Copy = "copy",
}

export type Clipboard = {
	mode: ClipboardMode;
	ids: string[];
	sourceId: string;
} | null;

/** Resolved metadata for a linked entity — used by the Links inspector
 *  tab to label each row and route `intent.open`. */
export type LinkedEntityMeta = {
	id: string;
	type: string;
	name: string;
	ownerAppId: string | null;
};

export type FilesStore = ReturnType<typeof useFilesStore>;

/** What the upload flows persist onto a `File/v1` row beyond name/mime —
 *  the byte count plus the stored-blob coordinates when `files.import`
 *  sealed the content into the vault asset store. */
type StoredUpload = { size: number; hash?: string; assetId?: string; assetMime?: string };

/** Cheap structural hash over the BROWSABLE slice of a snapshot — File /
 *  Folder rows plus every type the opener registry says Files can show
 *  (`browsable`). Files is a universal browser now, so a sibling app
 *  adding a Note/Task DOES change what's on screen and must rebuild; only
 *  churn in truly-internal types (no opener, never shown) still collapses
 *  to the same fingerprint and skips the rebuild. */
function fingerprintFilesSnapshot(
	entities: readonly VaultEntityShape[],
	links: readonly VaultLinkShape[],
	browsable: ReadonlySet<string>,
): string {
	let entitySig = "";
	let count = 0;
	for (const e of entities) {
		if (e.type !== FILE_TYPE && e.type !== FOLDER_TYPE && !browsable.has(e.type)) continue;
		entitySig += `${e.id}:${e.updatedAt ?? 0}:${e.deletedAt ?? 0};`;
		count += 1;
	}
	let linkSig = "";
	let linkCount = 0;
	for (const l of links) {
		linkSig += `${l.id};`;
		linkCount += 1;
	}
	return `${count}|${linkCount}|${entitySig}|${linkSig}`;
}

function buildVaultEntityIndex(
	entities: readonly VaultEntityShape[],
): Map<string, LinkedEntityMeta> {
	const map = new Map<string, LinkedEntityMeta>();
	for (const raw of entities) {
		if (raw.deletedAt) continue;
		const props = raw.properties ?? {};
		const nameValue = props.name ?? props.title;
		const name = typeof nameValue === "string" && nameValue.length > 0 ? nameValue : "(untitled)";
		map.set(raw.id, {
			id: raw.id,
			type: raw.type,
			name,
			ownerAppId: typeof raw.ownerAppId === "string" ? raw.ownerAppId : null,
		});
	}
	return map;
}

/** A stable per-vault discriminator for the renderer-local view-options
 *  blob, derived from the root Folder's per-vault `createdAt` (stamped once
 *  at `ensureRootFolder`). Returns undefined when the root row isn't in the
 *  snapshot yet (older vault / pre-bootstrap), so the caller falls back to
 *  the legacy unscoped key — backward-tolerant. Exported for unit-test. */
export function deriveVaultKey(entities: readonly VaultEntityShape[]): string | undefined {
	for (const e of entities) {
		if (e.id === ROOT_FOLDER_ID && typeof e.createdAt === "number" && e.createdAt > 0) {
			return `v${e.createdAt}`;
		}
	}
	return undefined;
}

export function useFilesStore() {
	// One FolderTree for the app lifetime. Boot empty (placeholder root,
	// replaced by the real shell-bootstrapped root once the first
	// `vaultEntities.list()` resolves) — no demo data ever bleeds in.
	const treeRef = useRef<FolderTree | null>(null);
	if (treeRef.current === null) {
		const t = new FolderTree();
		t.applySnapshot(buildVaultFileTree([], ROOT_FOLDER_ID));
		treeRef.current = t;
	}
	const tree = treeRef.current;

	// CRDT seam (`@brainstorm/react-yjs`). Files is read-only over the
	// `vaultEntities` snapshot today, so no SDK `<YDocProvider>` is
	// installed and this resolves to `null` — the snapshot path drives
	// state. When the entities-service resolver lands (Stage 9.3.2) the
	// Files window is wrapped in the SDK `<YDocProvider>`; this hook then
	// returns a live resolver and per-Folder `useYDoc(folderId)` reads
	// flow through it. Reading it here keeps the dependency a real,
	// type-checked integration rather than a package.json-only stub.
	const yDocResolver = useOptionalYDocResolver();
	const hasLiveCrdt = yDocResolver !== null;

	// A render-tick bumps whenever the tree or any reducer state changes.
	const [, forceRender] = useState(0);
	const rerender = useCallback(() => forceRender((n) => n + 1), []);

	const [viewMode, setViewModeState] = useState<ViewMode>(ViewMode.List);
	const [navOpen, setNavOpen] = useState<boolean>(() => readNavOpenPref());
	const [inspectorOpen, setInspectorOpen] = useState(false);
	const [inspectorTab, setInspectorTab] = useState<InspectorTab>(InspectorTab.Preview);

	useEffect(() => {
		document.body.dataset.navOpen = navOpen ? "true" : "false";
	}, [navOpen]);
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
		() => new Set([ROOT_FOLDER_ID]),
	);
	// Folder back/forward is the shared SDK primitive (`@brainstorm/sdk/
	// nav-history`) — same model + header chrome + chords as every other
	// first-party app. The current folder id IS Files' navigable location;
	// `navHist.get()` is the render snapshot (still `{current,back,forward}`,
	// so every existing `nav.current` / `navRef.current.current` reader is
	// unchanged). Recording is explicit at the navigation entry points
	// (folder open / reveal); `back`/`forward`/`reset` mutate the stack.
	const navHistRef = useRef<NavHistory<string> | null>(null);
	if (!navHistRef.current) {
		navHistRef.current = createNavHistory<string>({ initial: ROOT_FOLDER_ID });
	}
	const navHist = navHistRef.current;
	const nav = navHist.get();
	const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
	const [rename, setRename] = useState<RenameState>(IDLE_RENAME);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchScope, setSearchScope] = useState<SearchScope>(SearchScope.ActiveFolder);
	const [smartFolders, setSmartFolders] = useState<SmartFolder[]>([]);
	const [sortKey, setSortKeyState] = useState<SortKey>(DEFAULT_SORT_KEY);
	const [sortDirection, setSortDirection] = useState<SortDirection>(DEFAULT_SORT_DIRECTION);
	const [groupKey, setGroupKeyState] = useState<GroupKey>(DEFAULT_GROUP_KEY);
	const [tileSize, setTileSizeState] = useState<TileSize>(DEFAULT_TILE_SIZE);
	const [listColumns, setListColumns] = useState<readonly ListColumn[]>(DEFAULT_LIST_COLUMNS);
	const sortKeyRef = useRef(sortKey);
	sortKeyRef.current = sortKey;

	// Per-vault discriminator for the renderer-local view-options blob. The
	// app-origin localStorage is shared across every vault opened in this
	// app, and `ROOT_FOLDER_ID` is a fixed constant, so an unscoped blob let
	// vault B's root inherit vault A's. The root Folder's per-vault
	// `createdAt` (stamped once at `ensureRootFolder`) is a stable
	// discriminator that rides in the snapshot — null until the first
	// snapshot resolves (then the unscoped legacy blob is used, which is
	// backward-tolerant).
	const [vaultKey, setVaultKey] = useState<string | undefined>(undefined);

	// Per-folder view options (9.8.11): entering a folder restores its
	// remembered {mode, sort, group}; edits persist back.
	//
	// The persist effect must fire ONLY when the user explicitly changed an
	// option for the CURRENT folder — not on the render right after a
	// navigation (old state, new folder id), which would stamp the previous
	// folder's options under the new folder's key and pin an override on
	// every merely-visited folder. The hydrate effect resets the "dirty"
	// flag; option setters flip it true. Gating on the folder-id ref alone
	// was insufficient because hydration sets the ref to the new folder
	// before the option state has caught up.
	const hydratedFolderRef = useRef<string | null>(null);
	const optionsDirtyRef = useRef(false);
	useEffect(() => {
		const options = readViewOptions(nav.current, vaultKey);
		setViewModeState(options.mode);
		document.body.dataset.viewMode = options.mode;
		setSortKeyState(options.sortKey);
		setSortDirection(options.sortDirection);
		setGroupKeyState(options.groupKey);
		setTileSizeState(options.tileSize);
		setListColumns(options.columns);
		hydratedFolderRef.current = nav.current;
		optionsDirtyRef.current = false;
	}, [nav.current, vaultKey]);
	useEffect(() => {
		if (hydratedFolderRef.current !== nav.current) return;
		if (!optionsDirtyRef.current) return;
		writeViewOptions(
			nav.current,
			{
				mode: viewMode,
				sortKey,
				sortDirection,
				groupKey,
				tileSize,
				columns: listColumns,
			},
			vaultKey,
		);
	}, [nav.current, vaultKey, viewMode, sortKey, sortDirection, groupKey, tileSize, listColumns]);
	// Smart folders (saved searches) hydrate from the per-vault blob the
	// moment the vault discriminator resolves; mutations write through the
	// pure helpers, which return the next list AND persist it.
	useEffect(() => {
		setSmartFolders(readSmartFolders(vaultKey));
	}, [vaultKey]);
	const [clipboard, setClipboard] = useState<Clipboard>(null);
	const [vaultLinks, setVaultLinks] = useState<readonly VaultLinkShape[]>([]);
	const [vaultIndex, setVaultIndex] = useState<Map<string, LinkedEntityMeta>>(() => new Map());

	// Universal browser: which non-File/Folder types an app can open. Resolved
	// once per type via `intents.suggest` (registry truth) and cached — `null`
	// = resolved-but-unopenable (hidden, never re-queried). `browsableTypes` is
	// the derived "has an opener" set the tree projection + fingerprint use; a
	// render bumps it whenever a new type resolves to an opener.
	const openersByTypeRef = useRef<Map<string, OpenerMeta | null>>(new Map());
	const [browsableTypes, setBrowsableTypes] = useState<ReadonlySet<string>>(() => new Set());
	const browsableTypesRef = useRef(browsableTypes);
	browsableTypesRef.current = browsableTypes;

	// Mirror the tree's + nav controller's subscriptions into React renders.
	useEffect(() => tree.subscribe(rerender), [tree, rerender]);
	useEffect(() => navHist.subscribe(rerender), [navHist, rerender]);

	const navRef = useRef(nav);
	navRef.current = nav;
	const searchQueryRef = useRef(searchQuery);
	searchQueryRef.current = searchQuery;
	const searchScopeRef = useRef(searchScope);
	searchScopeRef.current = searchScope;
	const vaultKeyRef = useRef(vaultKey);
	vaultKeyRef.current = vaultKey;
	// True while an upload batch is mid-flight. Each per-file `entities.create`
	// fires `vaultEntities.onChange`; rebuilding the tree from that lagging
	// snapshot (the parent's `members[]` is only written once, at the end)
	// would destroy the optimistic membership the final `persistFolderMembers`
	// reads — so files would land at the vault root permanently. The reload is
	// suppressed during the batch and reconciled once after.
	const uploadInFlightRef = useRef(false);
	// `loadFromVault` is declared further down; upload helpers above it call it
	// through this ref to avoid the temporal-dead-zone in their dep arrays.
	const loadFromVaultRef = useRef<() => void>(() => {});
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const renameRef = useRef(rename);
	renameRef.current = rename;

	// ─── Derived data ────────────────────────────────────────────────────

	const currentFolderMembers = useCallback(
		(): Entity[] => tree.listFolderMembers(nav.current),
		[tree, nav.current],
	);

	// Computed every render (not memoised): the tree's `subscribe`
	// triggers `rerender` on every mutation (create/rename/move/delete),
	// so a fresh read here always reflects the latest snapshot. The list
	// is row-virtualised downstream, so this stays cheap.
	const searching = searchQuery.trim() !== "";
	const sortedRows: Entity[] = searching
		? runSearch({
				tree,
				// Vault scope walks from the ROOT folder, not the folder the user
				// happens to be in (9.8.9) — a Vault-scoped smart folder re-run
				// must see the whole tree.
				folderId: searchScope === SearchScope.Vault ? ROOT_FOLDER_ID : nav.current,
				query: searchQuery,
				scope: searchScope,
			})
		: sortEntities(tree.listFolderMembers(nav.current), sortKey, sortDirection);
	// Group-by (9.8.11): sections re-order the flat row list (group-major,
	// sorted within), so selection / keyboard / preview-siblings — which all
	// consume `visibleRows` order — stay coherent with what's on screen.
	// Search results are never grouped (relevance order IS the result).
	const visibleGroups: EntityGroup[] | null =
		!searching && groupKey !== GroupKey.None
			? groupEntities(sortedRows, groupKey, {
					folders: t("brainstorm.files.group.folders"),
					noExtension: t("brainstorm.files.group.noExtension"),
					otherLetter: t("brainstorm.files.group.otherLetter"),
				})
			: null;
	const visibleRows: Entity[] = visibleGroups
		? visibleGroups.flatMap((g) => g.entities)
		: sortedRows;
	// Header sections for the list renderer: label + the flat-row index the
	// section starts at. Null when grouping is off / searching.
	const visibleSections = visibleGroups
		? (() => {
				let start = 0;
				return visibleGroups.map((g) => {
					const section = { key: g.key, label: g.label, startIndex: start, count: g.entities.length };
					start += g.entities.length;
					return section;
				});
			})()
		: null;
	// Mirror through a ref so `selectRow` / `selectAllVisible` can read the
	// current order without re-sorting / re-searching per click.
	const visibleRowsRef = useRef(visibleRows);
	visibleRowsRef.current = visibleRows;

	const lastSelection = useCallback((): string | undefined => {
		if (selection.selected.size === 0) return undefined;
		return Array.from(selection.selected).pop();
	}, [selection]);

	const focusedId = selection.anchorId ?? lastSelection();
	const focused = focusedId ? tree.get(focusedId) : undefined;

	const breadcrumb = useMemo<BreadcrumbSegment[]>(
		() =>
			deriveBreadcrumbs({
				currentId: nav.current,
				rootId: ROOT_FOLDER_ID,
				parentOf: (id) => tree.findParentId(id),
				nameOf: (id) => tree.getName(id),
				rootFallbackLabel: t("brainstorm.files.breadcrumb.vaultRoot"),
			}),
		[tree, nav.current],
	);

	// ─── Navigation ──────────────────────────────────────────────────────

	// Apply a folder location WITHOUT recording it — the shared
	// `<NavButtons>` (and back/forward chords) call this after the
	// controller has already walked the stack, so it must not re-`push`.
	const applyFolderLocation = useCallback((id: string) => {
		setExpandedFolders((s) => new Set(s).add(id));
		setSelection(EMPTY_SELECTION);
		setSearchQuery("");
		setSearchScope(SearchScope.ActiveFolder);
	}, []);

	const navigateToFolder = useCallback(
		(id: string) => {
			if (id === navHist.current()) return;
			const entity = tree.get(id);
			if (!entity || entity.type !== FOLDER_TYPE) return;
			navHist.push(id);
			applyFolderLocation(id);
		},
		[tree, navHist, applyFolderLocation],
	);

	const navigateBackOnce = useCallback(() => {
		const id = navHist.back();
		if (id !== null) applyFolderLocation(id);
	}, [navHist, applyFolderLocation]);

	const navigateForwardOnce = useCallback(() => {
		const id = navHist.forward();
		if (id !== null) applyFolderLocation(id);
	}, [navHist, applyFolderLocation]);

	const navigateUp = useCallback(() => {
		const parent = tree.findParentId(navRef.current.current);
		if (parent) navigateToFolder(parent);
	}, [tree, navigateToFolder]);

	// ─── Smart folders (saved searches, 9.8.9) ─────────────────────────────

	const saveSearchAsSmartFolder = useCallback((name: string) => {
		setSmartFolders((existing) =>
			saveSmartFolder(
				existing,
				{
					name,
					query: searchQueryRef.current,
					scope: searchScopeRef.current,
					folderId: navRef.current.current,
					now: Date.now(),
					id: crypto.randomUUID(),
				},
				vaultKeyRef.current,
			),
		);
	}, []);

	const deleteSmartFolderById = useCallback((id: string) => {
		setSmartFolders((existing) => deleteSmartFolder(existing, id, vaultKeyRef.current));
	}, []);

	const renameSmartFolderById = useCallback((id: string, name: string) => {
		setSmartFolders((existing) => renameSmartFolder(existing, id, name, vaultKeyRef.current));
	}, []);

	// Activating a smart folder re-runs its search: navigate to its saved
	// folder (if it still exists; a deleted folder leaves the user where
	// they are), then apply the remembered query + scope. The query/scope
	// sets run after `navigateToFolder`'s `applyFolderLocation` clears them,
	// so they win in the same render batch.
	const activateSmartFolder = useCallback(
		(folder: SmartFolder) => {
			const target = tree.get(folder.folderId);
			if (target && target.type === FOLDER_TYPE && folder.folderId !== navRef.current.current) {
				navigateToFolder(folder.folderId);
			}
			setSearchQuery(folder.query);
			setSearchScope(folder.scope);
		},
		[tree, navigateToFolder],
	);

	const toggleFolderExpansion = useCallback((id: string) => {
		setExpandedFolders((s) => {
			const next = new Set(s);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	// ─── Selection ───────────────────────────────────────────────────────

	const selectRow = useCallback((id: string, modifier: SelectionModifier) => {
		const order = visibleRowsRef.current.map((e) => e.id);
		setSelection((s) => selectionReducer(s, { kind: "click", id, modifier, order }));
	}, []);

	const selectAllVisible = useCallback(() => {
		const order = visibleRowsRef.current.map((e) => e.id);
		setSelection((s) => selectionReducer(s, { kind: "selectAll", order }));
	}, []);

	const clearSelection = useCallback(() => setSelection(EMPTY_SELECTION), []);

	const revealEntityById = useCallback(
		(targetId: string): boolean => {
			const entity = tree.get(targetId);
			if (!entity) return false;
			if (entity.type === FOLDER_TYPE) {
				navHist.push(targetId);
				setExpandedFolders((s) => new Set(s).add(targetId));
				setSelection(EMPTY_SELECTION);
				return true;
			}
			const parent = tree.findParentId(targetId);
			if (parent) {
				navHist.push(parent);
				setExpandedFolders((s) => new Set(s).add(parent));
			}
			setSelection(
				selectionReducer(EMPTY_SELECTION, {
					kind: "click",
					id: targetId,
					modifier: SelectionModifier.None,
					order: [targetId],
				}),
			);
			return true;
		},
		[tree, navHist],
	);

	// ─── Rename ──────────────────────────────────────────────────────────

	const startRenameOnAnchor = useCallback(() => {
		const id = selectionRef.current.anchorId ?? Array.from(selectionRef.current.selected).pop();
		if (!id) return;
		const entity = tree.get(id);
		if (!entity) return;
		setRename(
			renameReducer(renameRef.current, {
				kind: "start",
				entityId: entity.id,
				original: readName(entity),
			}),
		);
	}, [tree]);

	const editRenameDraft = useCallback((draft: string) => {
		setRename((r) => renameReducer(r, { kind: "edit", draft }));
	}, []);

	const cancelRename = useCallback(() => {
		setRename((r) => renameReducer(r, { kind: "cancel" }));
	}, []);

	/** Commit. Returns a collision draft string when the name clashes (so
	 *  the renderer can show the collision dialog), else null. */
	const commitRename = useCallback((): string | null => {
		const current = renameRef.current;
		if (current.status !== RenameStatus.Editing) return null;
		const next = renameReducer(current, { kind: "submit" });
		if (next.status !== RenameStatus.Committing) {
			setRename(next);
			return null;
		}
		if (tree.hasNameCollision(navRef.current.current, next.draft, next.entityId)) {
			setRename(renameReducer(next, { kind: "collision" }));
			return next.draft;
		}
		tree.rename(next.entityId, next.draft);
		setRename(renameReducer(next, { kind: "committed" }));
		return null;
	}, [tree]);

	const resolveCollisionRenameAnyway = useCallback(() => {
		setRename((r) => {
			if (r.status !== RenameStatus.Confirming) return r;
			const next = renameReducer(r, {
				kind: "resolveCollision",
				decision: "renameAnyway",
			});
			if (next.status === RenameStatus.Committing) {
				tree.rename(next.entityId, next.draft);
				return renameReducer(next, { kind: "committed" });
			}
			return next;
		});
	}, [tree]);

	// ─── Create / mutate ─────────────────────────────────────────────────

	const newFolder = useCallback(() => {
		const parentId = navRef.current.current;
		let name = "Untitled folder";
		let counter = 1;
		while (tree.hasNameCollision(parentId, name)) {
			counter += 1;
			name = `Untitled folder ${counter}`;
		}
		const created = tree.createFolder({ name, parentId });
		if (!created) return;
		// Persist the row itself + the parent's membership — same optimistic-
		// then-write-through shape as move/copy (self-healing on reject).
		void persistEntityCreate(FOLDER_TYPE, created.properties, created.id);
		void persistFolderMembers(tree, parentId);
		setSelection(
			selectionReducer(EMPTY_SELECTION, {
				kind: "set",
				ids: [created.id],
				anchorId: created.id,
			}),
		);
		setRename(renameReducer(IDLE_RENAME, { kind: "start", entityId: created.id, original: name }));
	}, [tree]);

	/** Collision-rename + optimistic tree insert + `entities.create` for one
	 *  stored upload — the shared tail of the picker and drag-in flows. */
	const ingestStoredFile = useCallback(
		(displayName: string, stored: StoredUpload, parentId: string): string | null => {
			let name = displayName;
			let counter = 1;
			while (tree.hasNameCollision(parentId, name)) {
				counter += 1;
				name = collisionName(displayName, counter);
			}
			const created = tree.createFile({
				name,
				mime: mimeFromName(displayName),
				...stored,
				parentId,
			});
			if (!created) return null;
			void persistEntityCreate(FILE_TYPE, created.properties, created.id);
			return created.id;
		},
		[tree],
	);

	/** Persist the parent's membership once per batch + select the uploads,
	 *  then end the in-flight guard and reconcile against the now-consistent
	 *  vault (members written, every file created). */
	const finishUpload = useCallback(
		(parentId: string, createdIds: string[]) => {
			uploadInFlightRef.current = false;
			if (createdIds.length === 0) {
				loadFromVaultRef.current();
				return;
			}
			void persistFolderMembers(tree, parentId).finally(() => loadFromVaultRef.current());
			setSelection(
				selectionReducer(EMPTY_SELECTION, {
					kind: "set",
					ids: createdIds,
					anchorId: createdIds[createdIds.length - 1] ?? null,
				}),
			);
		},
		[tree],
	);

	/**
	 * The create-flow upload path (iteration `9.8.5`).
	 *
	 * Replaces the former synthetic "Untitled.txt" placeholder. The user
	 * picks one or more OS files via `services.files.requestOpen` (the
	 * 9.10 broker method); the app reads each via `services.files.read`
	 * and creates a `File/v1` entity per file with the real `name`,
	 * `mime` (extension-derived), `size`, and SHA-256 `hash`.
	 *
	 * Persistence (9.8.5 second half): the bytes are sealed into the
	 * vault's encrypted asset store via `files.import` (the shell reads
	 * the picked path itself — bytes never cross IPC), and the `File/v1`
	 * row persists through `entities.create` with `assetId`/`assetMime`
	 * pointing at the stored blob (served at `brainstorm://asset/<id>`,
	 * which the gallery preview renders). On an older shell / preview
	 * build without `files.import`, degrades to the metadata-only
	 * read+hash path (the pre-blob-store 9.8.5 shape).
	 *
	 * Cancellation is data, not error: `requestOpen` resolves to `[]`
	 * on user-cancel (per the 9.10 service contract), and we treat a
	 * missing `services.files` as a graceful no-op so the New-menu
	 * entry stays inert rather than throwing in non-Electron builds.
	 */
	const uploadFiles = useCallback(async () => {
		const runtime = typeof window !== "undefined" ? window.brainstorm : undefined;
		const filesSvc = runtime?.services?.files;
		if (!filesSvc?.requestOpen || (!filesSvc.import && !filesSvc.read)) {
			console.warn(`[files] ${t("brainstorm.files.upload.unavailable")}`);
			return;
		}

		let handles: ReadonlyArray<{ handleId: string; displayName: string }>;
		try {
			handles = await filesSvc.requestOpen({
				title: t("brainstorm.files.upload.dialogTitle"),
				multi: true,
			});
		} catch (error) {
			console.warn("[files] upload: requestOpen failed", error);
			return;
		}
		if (handles.length === 0) return;

		const parentId = navRef.current.current;
		const createdIds: string[] = [];
		uploadInFlightRef.current = true;
		for (const handle of handles) {
			let stored: StoredUpload;
			try {
				if (filesSvc.import) {
					const reply = await filesSvc.import({ handle });
					stored = {
						size: reply.size,
						hash: reply.contentHash,
						assetId: reply.assetId,
						assetMime: reply.mime,
					};
				} else {
					const bytes = await filesSvc.read(handle);
					stored = { size: bytes.byteLength, hash: await sha256Hex(bytes) };
				}
			} catch (error) {
				console.warn(
					`[files] ${t("brainstorm.files.upload.readFailed", { name: handle.displayName })}`,
					error,
				);
				continue;
			}
			const id = ingestStoredFile(handle.displayName, stored, parentId);
			if (id) createdIds.push(id);
		}
		finishUpload(parentId, createdIds);
	}, [ingestStoredFile, finishUpload]);

	/**
	 * 9.8.15 — Finder/OS drag-in upload. The drop gesture is the user
	 * mediation (mirroring the picker), so the bytes-variant `files.import`
	 * carries the dropped `File`'s bytes into the same encrypted asset
	 * store + `entities.create` path the picker flow uses. No `files.import`
	 * (older shell / preview build) → graceful no-op with a console signal,
	 * matching the upload posture above.
	 */
	const uploadDroppedFiles = useCallback(
		async (dropped: ReadonlyArray<File>) => {
			const runtime = typeof window !== "undefined" ? window.brainstorm : undefined;
			const filesSvc = runtime?.services?.files;
			if (!filesSvc?.import) {
				console.warn(`[files] ${t("brainstorm.files.upload.unavailable")}`);
				return;
			}
			const parentId = navRef.current.current;
			const createdIds: string[] = [];
			uploadInFlightRef.current = true;
			for (const file of dropped) {
				let stored: StoredUpload;
				try {
					const bytes = new Uint8Array(await file.arrayBuffer());
					const reply = await filesSvc.import({ name: file.name, bytes });
					stored = {
						size: reply.size,
						hash: reply.contentHash,
						assetId: reply.assetId,
						assetMime: reply.mime,
					};
				} catch (error) {
					console.warn(`[files] ${t("brainstorm.files.upload.readFailed", { name: file.name })}`, error);
					continue;
				}
				const id = ingestStoredFile(file.name, stored, parentId);
				if (id) createdIds.push(id);
			}
			finishUpload(parentId, createdIds);
		},
		[ingestStoredFile, finishUpload],
	);

	const deleteIds = useCallback(
		(ids: string[]) => {
			for (const id of ids) {
				tree.softDelete(id);
				void persistEntityDelete(id);
			}
			setSelection(EMPTY_SELECTION);
		},
		[tree],
	);

	const duplicateIds = useCallback(
		(ids: string[]) => {
			const newIds: string[] = [];
			for (const id of ids) {
				const entity = tree.get(id);
				if (!entity) continue;
				let candidate = `${readName(entity)} (copy)`;
				let counter = 1;
				while (tree.hasNameCollision(navRef.current.current, candidate)) {
					counter += 1;
					candidate = `${readName(entity)} (copy ${counter})`;
				}
				if (entity.type === FOLDER_TYPE) {
					const c = tree.createFolder({
						name: candidate,
						parentId: navRef.current.current,
					});
					if (c) {
						newIds.push(c.id);
						void persistEntityCreate(FOLDER_TYPE, c.properties, c.id);
					}
				} else if (entity.type === FILE_TYPE) {
					const { mime, size, hash, assetId, assetMime } = entity.properties;
					// A duplicate shares the source's stored blob (`assetId`) —
					// same bytes, two rows; asset deletion is never tied to a
					// single row, so the shared reference is safe.
					const c = tree.createFile({
						name: candidate,
						mime: typeof mime === "string" ? mime : "application/octet-stream",
						size: typeof size === "number" ? size : 0,
						...(typeof hash === "string" ? { hash } : {}),
						...(typeof assetId === "string" ? { assetId } : {}),
						...(typeof assetMime === "string" ? { assetMime } : {}),
						parentId: navRef.current.current,
					});
					if (c) {
						newIds.push(c.id);
						void persistEntityCreate(FILE_TYPE, c.properties, c.id);
					}
				}
			}
			if (newIds.length > 0) {
				void persistFolderMembers(tree, navRef.current.current);
				setSelection(
					selectionReducer(EMPTY_SELECTION, {
						kind: "set",
						ids: newIds,
						anchorId: newIds[newIds.length - 1] ?? null,
					}),
				);
			}
		},
		[tree],
	);

	// 9.8.7 — drag-drop now writes through. The in-memory `tree.move` runs
	// first so the UI repaints optimistically; the entities-service writes
	// follow as a background fire-and-forget. If either persist call
	// rejects, the next `vaultEntities.list` snapshot reverts the optimistic
	// state automatically (the broadcaster fires after every entity write),
	// so a transient failure is self-healing rather than silently divergent.
	// One `entities.update` per affected folder = one Yjs txn per folder,
	// matching design 30 §Performance ("bulk operations atomic per folder").
	const moveIds = useCallback(
		(sourceId: string, destId: string, ids: string[]) => {
			const result = tree.move(sourceId, destId, ids);
			if (!result.ok || result.movedIds.length === 0) return result;
			void persistFolderMembers(tree, sourceId);
			void persistFolderMembers(tree, destId);
			return result;
		},
		[tree],
	);

	// 9.8.7 — copy = membership add to destination without removing from
	// source (the multi-membership default per design 30). Reuses the
	// cycle guard inside `tree.copy`. The one in-memory call + one
	// persist call (dest only) mirrors the move path's shape.
	const copyIds = useCallback(
		(destId: string, ids: string[]) => {
			const result = tree.copy(destId, ids);
			if (!result.ok || result.copiedIds.length === 0) return result;
			void persistFolderMembers(tree, destId);
			return result;
		},
		[tree],
	);

	// DND-4 — cross-app drop onto a folder = add the dropped objects to that
	// folder's membership (`DropSemantic.AddMembership`, non-destructive). Unlike
	// `copyIds`, the ids may be FOREIGN objects (a note/contact from another app)
	// not present in this Files tree, so it goes through `tree.addMembers` (no
	// `missing-entity` rejection) and persists the dest folder's members the same
	// way move/copy do. The entities service resolves the foreign id; the write
	// is the Folder's own `members[]`, gated by the manifest `entities.write:*`.
	const addMembers = useCallback(
		(destId: string, ids: string[]) => {
			const result = tree.addMembers(destId, ids);
			if (!result.ok || result.addedIds.length === 0) return result;
			void persistFolderMembers(tree, destId);
			return result;
		},
		[tree],
	);

	// Folder/file appearance + editable metadata (icon / cover / name /
	// description). Applied optimistically to the in-memory mirror so the
	// change is visible immediately, then persisted through the SAME
	// `entities.update` write path the drag-drop move/copy uses
	// (`persistEntityProperties`). A rejected write is self-healing: the
	// next `vaultEntities.list` refresh reverts the optimistic state, which
	// the shell fires after every entity write.
	const patchEntityProperties = useCallback(
		(id: string, patch: Record<string, unknown>) => {
			const next = tree.list().map((e) =>
				e.id === id
					? {
							...e,
							properties: { ...e.properties, ...patch },
							updatedAt: Date.now(),
						}
					: e,
			);
			tree.applySnapshot(next);
			void persistEntityProperties(id, patch);
		},
		[tree],
	);

	const setEntityIcon = useCallback(
		(id: string, icon: unknown) => patchEntityProperties(id, { icon }),
		[patchEntityProperties],
	);
	const setEntityCover = useCallback(
		(id: string, cover: unknown) => patchEntityProperties(id, { cover }),
		[patchEntityProperties],
	);
	const setEntityName = useCallback(
		(id: string, name: string) => patchEntityProperties(id, { name }),
		[patchEntityProperties],
	);
	const setEntityDescription = useCallback(
		(id: string, description: string) => patchEntityProperties(id, { description }),
		[patchEntityProperties],
	);

	const setViewMode = useCallback((next: ViewMode) => {
		optionsDirtyRef.current = true;
		setViewModeState((cur) => (cur === next ? cur : next));
		document.body.dataset.viewMode = next;
	}, []);

	// When the key changes, default the direction to the most natural one
	// for that key (newest-first for dates, A→Z for name); picking the SAME
	// key flips direction. Read prior key via a ref so the setSortDirection
	// call sits OUTSIDE the setSortKeyState updater — StrictMode double-
	// invokes updaters, which would otherwise flip direction twice (no-op).
	const setSortKey = useCallback((next: SortKey) => {
		optionsDirtyRef.current = true;
		const cur = sortKeyRef.current;
		if (cur === next) {
			setSortDirection((d) => (d === SortDirection.Asc ? SortDirection.Desc : SortDirection.Asc));
			return;
		}
		setSortKeyState(next);
		setSortDirection(defaultDirectionFor(next));
	}, []);

	const setGroupKey = useCallback((next: GroupKey) => {
		optionsDirtyRef.current = true;
		setGroupKeyState((cur) => (cur === next ? cur : next));
	}, []);

	const setTileSize = useCallback((next: TileSize) => {
		optionsDirtyRef.current = true;
		setTileSizeState((cur) => (cur === next ? cur : next));
	}, []);

	const toggleColumn = useCallback((column: ListColumn) => {
		optionsDirtyRef.current = true;
		setListColumns((cur) => toggleListColumn(cur, column));
	}, []);

	// "Apply to all folders" (9.8.11): the current folder's options become
	// the vault-wide default and per-folder overrides drop.
	const applyViewToAllFolders = useCallback(() => {
		applyViewOptionsToAllFolders(
			{
				mode: viewMode,
				sortKey,
				sortDirection,
				groupKey,
				tileSize,
				columns: listColumns,
			},
			vaultKey,
		);
	}, [viewMode, sortKey, sortDirection, groupKey, tileSize, listColumns, vaultKey]);

	const toggleSortDirection = useCallback(() => {
		optionsDirtyRef.current = true;
		setSortDirection((d) => (d === SortDirection.Asc ? SortDirection.Desc : SortDirection.Asc));
	}, []);

	const toggleInspector = useCallback(() => {
		setInspectorOpen((open) => {
			const next = !open;
			document.body.dataset.inspector = next ? "open" : "closed";
			return next;
		});
	}, []);

	const toggleNav = useCallback(() => {
		setNavOpen((open) => {
			const next = !open;
			writeNavOpenPref(next);
			return next;
		});
	}, []);

	const linksForFocused = useCallback(
		(id: string): { outgoing: readonly EntityLink[]; incoming: readonly EntityLink[] } =>
			partitionLinksForEntity(vaultLinks, id),
		[vaultLinks],
	);

	// The default opener (app id + name) for a non-File/Folder type, or null
	// when the type isn't openable / not yet resolved. Drives the type-identity
	// icon for iconless typed objects. Reads the live cache ref, so a stable
	// identity is fine — consumers re-render off the `browsableTypes` state bump
	// whenever a new type resolves, and re-read it then.
	const openerForType = useCallback(
		(type: string): OpenerMeta | null => openersByTypeRef.current.get(type) ?? null,
		[],
	);

	// ─── Vault wiring (EXISTING preview read path) ───────────────────────

	const loadedOnceRef = useRef(false);
	// Fingerprint of the last snapshot we applied: when a sibling app (Notes,
	// Tasks, …) writes through storage, vaultEntities.onChange fires for
	// every consumer. The fingerprint over the BROWSABLE slice (File/Folder +
	// every openable type) lets us bail when nothing on screen changed —
	// churn in hidden internal types still collapses to the same hash.
	const lastFingerprintRef = useRef<string | null>(null);

	// Resolve the opener for each not-yet-seen non-File/Folder type via
	// `intents.suggest` (registry truth). A type that resolves to an opener
	// becomes browsable and triggers one reload so its rows appear; a batch
	// that resolves only to "no opener" just seeds the cache (no rebuild).
	// Fire-and-forget: the current render proceeds with the types known so far.
	// The cache is session-scoped and never re-queries a resolved type, so an
	// opener registered mid-session (a freshly installed app) surfaces its type
	// only after a relaunch — acceptable for an install-time-stable registry.
	const resolveOpeners = useCallback((entities: readonly VaultEntityShape[]) => {
		const suggest = window.brainstorm?.services?.intents?.suggest;
		if (!suggest) return;
		const pending = unresolvedTypes(entities, openersByTypeRef.current);
		if (pending.length === 0) return;
		void (async () => {
			const resolved = await Promise.all(
				pending.map(async (type) => {
					try {
						const handlers = await suggest({ verb: "open", payload: { entityType: type } });
						return [type, openerFromHandlers(handlers)] as const;
					} catch {
						return [type, null] as const;
					}
				}),
			);
			let gainedBrowsable = false;
			for (const [type, opener] of resolved) {
				openersByTypeRef.current.set(type, opener);
				if (opener !== null) gainedBrowsable = true;
			}
			if (!gainedBrowsable) return;
			const nextSet = browsableTypeSet(openersByTypeRef.current);
			// Keep the ref in lockstep with the state so the immediate reload below
			// reads the just-grown set (setState hasn't flushed to the mirror yet).
			browsableTypesRef.current = nextSet;
			setBrowsableTypes(nextSet);
			loadFromVaultRef.current();
		})();
	}, []);

	const loadFromVault = useCallback(() => {
		const runtime = window.brainstorm;
		const svc = runtime?.services?.vaultEntities;
		const list = svc?.list;
		if (!list) return;
		// Don't rebuild the tree from a mid-upload snapshot — it lags the
		// optimistic in-memory membership. `finishUpload` reconciles once the
		// batch + the parent members write complete.
		if (uploadInFlightRef.current) return;
		void (async () => {
			try {
				const snapshot = await list.call(svc);
				const entities = snapshot.entities ?? [];
				// Resolve any new types first (before the early-return) so a freshly
				// appeared openable type gets a follow-up rebuild even when the
				// browsable slice is otherwise unchanged this pass.
				resolveOpeners(entities);
				const browsable = browsableTypesRef.current;
				const isInitial = !loadedOnceRef.current;
				const fingerprint = fingerprintFilesSnapshot(entities, snapshot.links ?? [], browsable);
				if (!isInitial && fingerprint === lastFingerprintRef.current) return;
				lastFingerprintRef.current = fingerprint;
				setVaultLinks(snapshot.links ?? []);
				setVaultIndex(buildVaultEntityIndex(entities));
				// Derive the per-vault discriminator for the view-options blob
				// from the root Folder's per-vault `createdAt` (stamped once at
				// `ensureRootFolder`). Stable for the life of the vault, distinct
				// across vaults, and never leaves the renderer.
				const derived = deriveVaultKey(entities);
				if (derived) setVaultKey((cur) => (cur === derived ? cur : derived));
				const tree_ = buildVaultFileTree(entities, ROOT_FOLDER_ID, Date.now(), browsable);
				if (isInitial) {
					// One-shot boot diagnostic — confirms vault loaded + tree built
					// when Files appears empty. `console.warn` (not info) so it
					// lands in the runtime error log. Removed in a follow-up once
					// the empty-vault report is root-caused.
					const rootRow = tree_.find((e) => e.id === ROOT_FOLDER_ID);
					const rootMembers = Array.isArray(rootRow?.properties.members)
						? (rootRow.properties.members as readonly unknown[]).length
						: 0;
					const folderTypes = new Set<string>();
					for (const e of entities) folderTypes.add(e.type);
					console.warn(
						`[files] boot: snapshot=${entities.length} entities, ` +
							`tree=${tree_.length} nodes, root.members=${rootMembers}, ` +
							`types=[${[...folderTypes].slice(0, 8).join(", ")}${folderTypes.size > 8 ? ", …" : ""}]`,
					);
				}
				tree.applySnapshot(tree_);
				if (isInitial) {
					loadedOnceRef.current = true;
					navHist.reset(ROOT_FOLDER_ID);
					setExpandedFolders(new Set([ROOT_FOLDER_ID]));
					setSelection(EMPTY_SELECTION);
					const launch = runtime?.launch;
					if (launch?.reason === "open-entity" && launch.entityId) {
						revealEntityById(launch.entityId);
					}
				}
			} catch (error) {
				console.warn("[files] vaultEntities.list failed; keeping current view", error);
			}
		})();
	}, [tree, revealEntityById, navHist, resolveOpeners]);
	loadFromVaultRef.current = loadFromVault;

	useEffect(() => {
		loadFromVault();
		const runtime = window.brainstorm;
		const svc = runtime?.services?.vaultEntities;
		const sub = svc?.onChange?.call(svc, () => loadFromVault());
		const intentSub = runtime?.on?.("intent", (event) => {
			if (event.type !== "intent") return;
			const verb = event.intent?.verb;
			if (verb === "open") {
				const id = event.intent?.payload?.entityId;
				if (typeof id === "string" && id) revealEntityById(id);
				return;
			}
			// 9.8.7 — any app can dispatch `intent.move` with
			// `{ entityIds, fromFolderId?, toFolderId, copy? }` per design 30
			// §intent.move. The Files manifest declares the `move` intent so
			// the broker routes it here; the handler runs the same persist
			// path the drag-drop UI uses, so an `intent.move` from Notes is
			// indistinguishable from a user drag on disk.
			if (verb === "move") {
				handleMoveIntent(event.intent?.payload as Record<string, unknown> | undefined, tree);
				return;
			}
		});
		return () => {
			sub?.unsubscribe();
			intentSub?.unsubscribe();
		};
	}, [loadFromVault, revealEntityById, tree]);

	return {
		tree,
		/** True once an SDK `<YDocProvider>` is installed (Stage 9.3.2):
		 *  the write-through gate for the deferred entities-service path. */
		hasLiveCrdt,
		viewMode,
		setViewMode,
		navOpen,
		toggleNav,
		inspectorOpen,
		toggleInspector,
		inspectorTab,
		setInspectorTab,
		expandedFolders,
		toggleFolderExpansion,
		nav,
		/** The shared back/forward controller — drives the header
		 *  `<NavButtons>`. `applyFolderLocation` is its non-recording apply. */
		navHistory: navHist,
		applyFolderLocation,
		canGoBack: navHist.canGoBack(),
		canGoForward: navHist.canGoForward(),
		navigateToFolder,
		navigateBackOnce,
		navigateForwardOnce,
		navigateUp,
		breadcrumb,
		selection,
		selectRow,
		selectAllVisible,
		clearSelection,
		revealEntityById,
		rename,
		startRenameOnAnchor,
		editRenameDraft,
		commitRename,
		cancelRename,
		resolveCollisionRenameAnyway,
		newFolder,
		uploadFiles,
		uploadDroppedFiles,
		/** Back-compat alias — `New ▾` → `New file` dispatches the upload
		 *  picker. Kept under the existing identifier so app.tsx and any
		 *  callers don't need to know the rename. */
		newFile: uploadFiles,
		deleteIds,
		duplicateIds,
		moveIds,
		copyIds,
		addMembers,
		setEntityIcon,
		setEntityCover,
		setEntityName,
		setEntityDescription,
		clipboard,
		setClipboard,
		searchQuery,
		setSearchQuery,
		searchScope,
		setSearchScope,
		smartFolders,
		saveSearchAsSmartFolder,
		deleteSmartFolderById,
		renameSmartFolderById,
		activateSmartFolder,
		sortKey,
		sortDirection,
		setSortKey,
		toggleSortDirection,
		groupKey,
		setGroupKey,
		tileSize,
		setTileSize,
		listColumns,
		toggleColumn,
		applyViewToAllFolders,
		visibleRows,
		visibleSections,
		currentFolderMembers,
		focused,
		focusedId,
		linksForFocused,
		vaultIndex,
		/** Default opener (app id + name) for a non-File/Folder type, or null —
		 *  the type-identity badge source for iconless typed objects. */
		openerForType,
		/** The set of openable non-File/Folder types currently shown. Bumps a
		 *  render whenever a new type resolves to an opener. */
		browsableTypes,
	};
}

/** 9.8.7 — apply an `intent.move` payload against the in-memory tree +
 *  fire the matching entities-service persistence pair, exactly mirroring
 *  the drag-drop UI path. Defensive about every payload field (this is a
 *  cross-app entry point — the dispatcher might be any app). The
 *  `copy: true` flag opts into the membership-add (multi-membership)
 *  variant; default is move. Silent on every failure mode (missing
 *  payload, missing folders, cycle, no entities service) — the
 *  dispatcher's typed wrapper (`moveEntity` from `@brainstorm/sdk`)
 *  surfaces the result. Exported for unit-test access without spinning
 *  up the React store. */
export function handleMoveIntent(
	payload: Record<string, unknown> | undefined,
	tree: FolderTree,
): void {
	if (!payload) return;
	const ids = Array.isArray(payload.entityIds)
		? payload.entityIds.filter((x): x is string => typeof x === "string" && x.length > 0)
		: [];
	const toFolderId = typeof payload.toFolderId === "string" ? payload.toFolderId : "";
	if (!toFolderId || ids.length === 0) return;
	const copy = payload.copy === true;
	if (copy) {
		const result = tree.copy(toFolderId, ids);
		if (result.ok && result.copiedIds.length > 0) void persistFolderMembers(tree, toFolderId);
		return;
	}
	const fromFolderId = typeof payload.fromFolderId === "string" ? payload.fromFolderId : "";
	if (!fromFolderId) return;
	const result = tree.move(fromFolderId, toFolderId, ids);
	if (!result.ok || result.movedIds.length === 0) return;
	void persistFolderMembers(tree, fromFolderId);
	void persistFolderMembers(tree, toFolderId);
}

/** 9.8.7 — write the current in-memory members[] of `folderId` through to
 *  the entities service. Best-effort: no-ops when the service surface is
 *  unavailable (standalone-dev / preview build / missing capability) and
 *  swallows-and-logs rejection — the optimistic in-memory state reverts
 *  on the next `vaultEntities.list` refresh, which the shell fires
 *  after every successful entity write. Reads members live from the
 *  passed-in `tree` (already mutated by the optimistic call) rather than
 *  capturing them in advance, so a quick second move on the same folder
 *  always persists the latest state. */
/** 9.8.13 — persist an arbitrary property patch (icon / cover / name /
 *  description, set from the inspector) through the same `entities.update`
 *  write seam the move/copy path uses. Best-effort with the identical
 *  failure contract: no-ops when the entities service / capability is
 *  unavailable and swallows-and-logs rejection, so the optimistic
 *  in-memory state reverts on the next `vaultEntities.list` refresh.
 *
 *  Capability note: the Files manifest grants `entities.write:*` (the
 *  universal browser manages any object — move/rename/edit-metadata and
 *  soft-delete-to-Bin work across every browsable type, mirroring the
 *  cross-type write grant Database / Graph / Notes already hold). */
async function persistEntityCreate(
	type: string,
	properties: Record<string, unknown>,
	id: string,
): Promise<void> {
	const runtime = typeof window !== "undefined" ? window.brainstorm : undefined;
	const entities = runtime?.services?.entities;
	const create = entities?.create;
	if (!create) return;
	try {
		await create.call(entities, type, properties, id);
	} catch (error) {
		console.warn(`[files] entities.create(${id}) failed:`, error);
	}
}

async function persistEntityDelete(id: string): Promise<void> {
	const runtime = typeof window !== "undefined" ? window.brainstorm : undefined;
	const entities = runtime?.services?.entities;
	const del = entities?.delete;
	if (!del) return;
	try {
		await del.call(entities, id);
	} catch (error) {
		console.warn(`[files] entities.delete(${id}) failed:`, error);
	}
}

async function persistEntityProperties(id: string, patch: Record<string, unknown>): Promise<void> {
	const runtime = typeof window !== "undefined" ? window.brainstorm : undefined;
	const entities = runtime?.services?.entities;
	const update = entities?.update;
	if (!update) return;
	try {
		await update.call(entities, id, patch);
	} catch (error) {
		console.warn(`[files] entities.update(${id}) failed:`, error);
	}
}

async function persistFolderMembers(tree: FolderTree, folderId: string): Promise<void> {
	const runtime = typeof window !== "undefined" ? window.brainstorm : undefined;
	const update = runtime?.services?.entities?.update;
	if (!update) return;
	const folder = tree.get(folderId);
	if (!folder) return;
	try {
		await update.call(runtime?.services?.entities, folderId, {
			members: [...readMembers(folder)],
		});
	} catch (error) {
		console.warn(`[files] entities.update(${folderId}.members) failed:`, error);
	}
}

const NAV_OPEN_PREF_KEY = "files.navOpen";

function readNavOpenPref(): boolean {
	try {
		const raw = globalThis.localStorage?.getItem(NAV_OPEN_PREF_KEY);
		if (raw === null || raw === undefined) return true;
		return raw !== "false";
	} catch {
		return true;
	}
}

function writeNavOpenPref(open: boolean): void {
	try {
		globalThis.localStorage?.setItem(NAV_OPEN_PREF_KEY, String(open));
	} catch {
		/* private mode / quota — silent */
	}
}
