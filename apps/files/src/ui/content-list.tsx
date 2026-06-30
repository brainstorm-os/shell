/**
 * The folder-contents list — 9.8.3 virtualisation via
 * `@tanstack/react-virtual`, 9.8.6 inline rename, per-row object menu
 * via the shared `<ObjectMenuTrigger>` (Open → Pin/Unpin → Duplicate →
 * Remove), drag-and-drop move.
 *
 * List mode = one-lane vertical virtualisation. Grid/Gallery = lane-based
 * grid virtualisation: column count is derived from container width via
 * ResizeObserver, and each item is absolutely positioned at
 * `(lane * tileWidth, row * tileHeight)` so only the tiles in view are
 * mounted even for very large folders.
 */

import { DragPayloadKind } from "@brainstorm/sdk-types";
import { Orientation, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { EmptyState } from "@brainstorm/sdk/empty-state";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import {
	DropSemantic,
	effectForSemantic,
	useDragSource,
	useDropTarget,
} from "@brainstorm/sdk/object-dnd";
import { ObjectMenuTrigger } from "@brainstorm/sdk/object-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { dragItemsForEntry } from "../logic/drag-items";
import { DEFAULT_LIST_COLUMNS, LIST_COLUMN_WIDTH, ListColumn } from "../logic/list-columns";
import { RenameStatus } from "../logic/rename";
import { initialSelectionRange } from "../logic/rename";
import { SelectionModifier } from "../logic/selection";
import type { FilesStore } from "../store/use-files-store";
import { type Entity, FILE_TYPE, FOLDER_TYPE, readName } from "../types/entity";
import type { BrainstormRuntime } from "../types/runtime";
import { TileSize, ViewMode, isListMode } from "../view-mode";
import { formatBytes, formatTimeAgo, readEntityIcon, typeLabel } from "./entity-view";
import { EntityIcon } from "./entity-visuals";
import { filesObjectMenuContext } from "./object-menu-context";

const DND_MIME = "application/x-brainstorm-entity";

/** Native HTML5 drag falls back to the browser's default drag image — a
 *  snapshot of the (transparent-background) row composited onto white, which
 *  reads as a stray white box following the cursor. Replace it with a small
 *  solid themed pill (file name + a count badge for a multi-selection). The
 *  element is appended off-screen, snapshotted by the browser during
 *  `dragstart`, then removed on the next frame. */
function applyDragImage(dataTransfer: DataTransfer, label: string, count: number): void {
	const ghost = document.createElement("div");
	ghost.className = "files-drag-image";
	const text = document.createElement("span");
	text.className = "files-drag-image__label";
	text.textContent = label;
	ghost.appendChild(text);
	if (count > 1) {
		const badge = document.createElement("span");
		badge.className = "files-drag-image__count";
		badge.textContent = String(count);
		ghost.appendChild(badge);
	}
	document.body.appendChild(ghost);
	dataTransfer.setDragImage(ghost, 12, 12);
	requestAnimationFrame(() => ghost.remove());
}

const ROW_HEIGHT = 36;
/** IconList is a one-lane list like List, but a taller row carrying a larger
 *  leading glyph (the Finder "as Icons in a list" density). */
const ICON_LIST_ROW_HEIGHT = 48;
const ICON_LIST_ICON_SIZE = 28;
const LIST_ICON_SIZE = 18;
const GROUP_HEADER_HEIGHT = 32;
const GRID_GAP = 12;
const GALLERY_GAP = 16;
const ICON_LIST_GAP = 4;
const GRID_PADDING = 16;
const GALLERY_PADDING = 20;
const ICON_LIST_PADDING = 8;

/** Tile geometry per size preset (9.8.11) — min width drives the column
 *  count, height + icon scale with it so density changes feel uniform. */
type TileMetrics = { minWidth: number; height: number; icon: number };
const GRID_METRICS: Record<TileSize, TileMetrics> = {
	[TileSize.Small]: { minWidth: 96, height: 108, icon: 32 },
	[TileSize.Medium]: { minWidth: 120, height: 132, icon: 40 },
	[TileSize.Large]: { minWidth: 152, height: 164, icon: 52 },
};
const GALLERY_METRICS: Record<TileSize, TileMetrics> = {
	[TileSize.Small]: { minWidth: 144, height: 168, icon: 48 },
	[TileSize.Medium]: { minWidth: 180, height: 204, icon: 64 },
	[TileSize.Large]: { minWidth: 228, height: 256, icon: 84 },
};
/** Icon-list (9.8.10): compact horizontal rows that wrap into columns —
 *  Finder's high-density browse mode. Same lane-based virtualisation as
 *  Grid/Gallery; the tile IS a row, so heights stay list-like. */
const ICON_LIST_METRICS: Record<TileSize, TileMetrics> = {
	[TileSize.Small]: { minWidth: 160, height: 28, icon: 15 },
	[TileSize.Medium]: { minWidth: 200, height: 32, icon: 17 },
	[TileSize.Large]: { minWidth: 248, height: 40, icon: 20 },
};

function tileMetrics(mode: ViewMode, tileSize: TileSize): TileMetrics | null {
	if (mode === ViewMode.Gallery) return GALLERY_METRICS[tileSize];
	if (mode === ViewMode.Grid) return GRID_METRICS[tileSize];
	if (mode === ViewMode.IconList) return ICON_LIST_METRICS[tileSize];
	return null;
}

type VirtualEntry =
	| { header: { key: string; label: string } }
	| { entity: Entity; rowIndex: number };

type GridGeometry = {
	columns: number;
	tileWidth: number;
	tileHeight: number;
	gap: number;
	padding: number;
};

function isGridMode(mode: ViewMode): boolean {
	return mode === ViewMode.Grid || mode === ViewMode.Gallery || mode === ViewMode.IconList;
}

/** Tile modes that render the media slot (thumbnail / glyph band). The
 *  icon-list lanes are compact rows — they keep the plain entity icon. */
function isTileMediaMode(mode: ViewMode): boolean {
	return mode === ViewMode.Grid || mode === ViewMode.Gallery;
}

function rowHeightFor(mode: ViewMode, tileSize: TileSize): number {
	if (mode === ViewMode.IconList) return ICON_LIST_ROW_HEIGHT;
	return tileMetrics(mode, tileSize)?.height ?? ROW_HEIGHT;
}

function iconSizeFor(mode: ViewMode, tileSize: TileSize): number {
	if (mode === ViewMode.IconList) return ICON_LIST_ICON_SIZE;
	return tileMetrics(mode, tileSize)?.icon ?? LIST_ICON_SIZE;
}

function geometryFor(mode: ViewMode, containerWidth: number, tileSize: TileSize): GridGeometry {
	if (!isGridMode(mode) || containerWidth <= 0) {
		return {
			columns: 1,
			tileWidth: 0,
			tileHeight: rowHeightFor(mode, tileSize),
			gap: 0,
			padding: 0,
		};
	}
	const minWidth = tileMetrics(mode, tileSize)?.minWidth ?? 120;
	const gap =
		mode === ViewMode.Gallery ? GALLERY_GAP : mode === ViewMode.IconList ? ICON_LIST_GAP : GRID_GAP;
	const padding =
		mode === ViewMode.Gallery
			? GALLERY_PADDING
			: mode === ViewMode.IconList
				? ICON_LIST_PADDING
				: GRID_PADDING;
	const usable = Math.max(0, containerWidth - padding * 2);
	const columns = Math.max(1, Math.floor((usable + gap) / (minWidth + gap)));
	const tileWidth = (usable - (columns - 1) * gap) / columns;
	return { columns, tileWidth, tileHeight: rowHeightFor(mode, tileSize), gap, padding };
}

/** DND-5 (scope D) — read a stored file's decrypted bytes back through the asset
 *  protocol (the same source thumbnails use). PREFETCHED on pointerdown so the
 *  bytes are ready by `dragstart`: `webContents.startDrag` must reach main while
 *  the OS drag gesture is still live, so the slow part (the fetch) must NOT sit
 *  in the `dragstart` critical path. Returns null on missing service/asset. */
async function fetchExportBytes(entity: Entity): Promise<Uint8Array | null> {
	const assetId = entity.properties.assetId;
	if (typeof assetId !== "string" || assetId === "") return null;
	try {
		const res = await fetch(`brainstorm://asset/${assetId}`);
		const bytes = new Uint8Array(await res.arrayBuffer());
		return bytes.length > 0 ? bytes : null;
	} catch {
		return null;
	}
}

function modifierFrom(event: React.MouseEvent): SelectionModifier {
	if (event.shiftKey) return SelectionModifier.Range;
	if (event.metaKey || event.ctrlKey) return SelectionModifier.Toggle;
	return SelectionModifier.None;
}

export type ContentListProps = {
	store: FilesStore;
	runtime: BrainstormRuntime | undefined;
	onOpen: (entity: Entity) => void;
	onCollision: (draft: string) => void;
	onCycle: (movingId: string, destId: string) => void;
	onEditIcon: (folderId: string) => void;
	onEditCover: (folderId: string) => void;
};

export function ContentList({
	store,
	runtime,
	onOpen,
	onCollision,
	onCycle,
	onEditIcon,
	onEditCover,
}: ContentListProps) {
	const rows = store.visibleRows;
	const mode = store.viewMode;
	const isGrid = isGridMode(mode);

	// 9.8.15 — Finder/OS drag-in upload. The content area is the drop
	// target for EXTERNAL files (`dataTransfer` carries the "Files" type);
	// internal entity drags ride DND_MIME on the rows and never enter this
	// path. Depth-counted so dragging across child rows doesn't flicker
	// the affordance off.
	const [osDragDepth, setOsDragDepth] = useState(0);
	const isOsFileDrag = (e: React.DragEvent) =>
		e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(DND_MIME);
	const onOsDragEnter = (e: React.DragEvent) => {
		if (!isOsFileDrag(e)) return;
		e.preventDefault();
		setOsDragDepth((d) => d + 1);
	};
	const onOsDragOver = (e: React.DragEvent) => {
		if (!isOsFileDrag(e)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	};
	const onOsDragLeave = (e: React.DragEvent) => {
		if (!isOsFileDrag(e)) return;
		setOsDragDepth((d) => Math.max(0, d - 1));
	};
	const onOsDrop = (e: React.DragEvent) => {
		if (!isOsFileDrag(e)) return;
		e.preventDefault();
		setOsDragDepth(0);
		const files = Array.from(e.dataTransfer.files);
		if (files.length > 0) void store.uploadDroppedFiles(files);
	};

	// Group-by section headers (9.8.11) — injected as their own virtual rows
	// in List mode. Grid/Gallery render group-ORDERED tiles without header
	// rows (headers would break the lane geometry; the ordering still
	// clusters each group together).
	const sections = isGrid ? null : store.visibleSections;
	const items: VirtualEntry[] = useMemo(() => {
		if (!sections) return rows.map((entity, rowIndex) => ({ entity, rowIndex }));
		const out: VirtualEntry[] = [];
		for (const section of sections) {
			out.push({ header: { key: section.key, label: section.label } });
			for (let i = 0; i < section.count; i += 1) {
				const rowIndex = section.startIndex + i;
				const entity = rows[rowIndex];
				if (entity) out.push({ entity, rowIndex });
			}
		}
		return out;
	}, [rows, sections]);
	// Flat-row index → virtual index, for keyboard scroll-into-view.
	const virtualIndexOfRow = useMemo(() => {
		const map = new Array<number>(rows.length);
		items.forEach((item, virtualIndex) => {
			if ("entity" in item) map[item.rowIndex] = virtualIndex;
		});
		return map;
	}, [items, rows.length]);

	const [containerWidth, setContainerWidth] = useState(0);
	const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
	// Callback ref instead of useRef + mount-only useLayoutEffect: the
	// empty-state branch below short-circuits the render, so .content-list
	// only mounts AFTER rows.length > 0. A `useLayoutEffect([])` runs once
	// during the empty-state render with a null ref and never re-attaches
	// the ResizeObserver — containerWidth stays 0, geometryFor takes its
	// columns=1/tileWidth=0 early-return branch, and the grid collapses
	// into a single vertical lane. A callback ref fires on every mount
	// transition so the observer attaches the moment the scroll container
	// exists.
	const scrollRef = useCallback((el: HTMLDivElement | null) => {
		setScrollEl(el);
	}, []);

	useLayoutEffect(() => {
		if (!scrollEl) {
			setContainerWidth(0);
			return;
		}
		setContainerWidth(scrollEl.clientWidth);
		const ro = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) setContainerWidth(entry.contentRect.width);
		});
		ro.observe(scrollEl);
		return () => ro.disconnect();
	}, [scrollEl]);

	const geometry = useMemo(
		() => geometryFor(mode, containerWidth, store.tileSize),
		[mode, containerWidth, store.tileSize],
	);
	const { columns, tileWidth, tileHeight, gap, padding } = geometry;
	const laneSpan = tileHeight + gap;

	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scrollEl,
		estimateSize: (index) => {
			if (isGrid) return laneSpan;
			const item = items[index];
			return item && "header" in item ? GROUP_HEADER_HEIGHT : tileHeight;
		},
		overscan: isGrid ? 4 : 12,
		lanes: columns,
	});

	// `items.length` (not `items`) — re-measure when header rows appear or
	// disappear; an identity-only change re-renders anyway.
	// biome-ignore lint/correctness/useExhaustiveDependencies: items.length is the intended re-measure trigger
	useEffect(() => {
		virtualizer.measure();
	}, [virtualizer, items.length]);

	// KBN-A-files: the folder-contents list adopts the SDK composite-keyboard
	// reducer. Vertical in List mode, 2D Grid (driven by the geometry's column
	// count) in Grid/Gallery. The list is virtualized, so it keeps focus on the
	// container and tracks the active row via `aria-activedescendant` (the Bin
	// precedent) — arrows move the selection cursor (single-select), Enter opens.
	const activeIndex = useMemo(() => {
		const anchor = store.selection.anchorId;
		return anchor === null ? -1 : rows.findIndex((r) => r.id === anchor);
	}, [rows, store.selection.anchorId]);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: isGrid ? Orientation.Grid : Orientation.Vertical,
		count: rows.length,
		activeIndex,
		onActiveIndexChange: (index) => {
			const entity = rows[index];
			if (entity) store.selectRow(entity.id, SelectionModifier.None);
			virtualizer.scrollToIndex(virtualIndexOfRow[index] ?? index);
		},
		onActivate: (index) => {
			const entity = rows[index];
			if (entity) onOpen(entity);
		},
		...(isGrid ? { columns } : {}),
		useAriaActiveDescendant: true,
		// A flat list of selectable objects: listbox/option semantics in every
		// view mode (grid layout is purely visual; arrows still navigate 2D).
		role: "listbox",
		itemRole: "option",
	});
	const setListRef = useCallback(
		(el: HTMLDivElement | null) => {
			scrollRef(el);
			containerProps.ref(el);
		},
		[scrollRef, containerProps.ref],
	);

	if (rows.length === 0) {
		const searching = store.searchQuery.trim() !== "";
		return (
			<div
				className="content-empty"
				data-testid="content-empty"
				data-os-drop={osDragDepth > 0 ? "true" : "false"}
				onDragEnter={onOsDragEnter}
				onDragOver={onOsDragOver}
				onDragLeave={onOsDragLeave}
				onDrop={onOsDrop}
			>
				<EmptyState
					icon={searching ? IconName.Search : IconName.Folder}
					title={searching ? t("brainstorm.files.empty.searchTitle") : t("brainstorm.files.empty.title")}
					hint={
						searching
							? t("brainstorm.files.empty.searchBody", { query: store.searchQuery })
							: t("brainstorm.files.empty.body")
					}
					{...(searching
						? {}
						: {
								action: (
									<button
										type="button"
										className="bs-btn"
										data-bs-primary=""
										data-testid="content-empty-new-folder"
										onClick={store.newFolder}
									>
										<Icon name={IconName.Plus} size={15} />
										{t("brainstorm.files.empty.newFolder")}
									</button>
								),
							})}
				/>
			</div>
		);
	}

	const totalSize = virtualizer.getTotalSize();
	const innerHeight = isGrid ? totalSize + padding * 2 - gap : totalSize;

	return (
		<div
			{...containerProps}
			className="content-list"
			id="content-list"
			data-testid="content-list"
			data-view-mode={store.viewMode}
			data-os-drop={osDragDepth > 0 ? "true" : "false"}
			ref={setListRef}
			aria-label={t("brainstorm.files.contentList.label")}
			onDragEnter={onOsDragEnter}
			onDragOver={onOsDragOver}
			onDragLeave={onOsDragLeave}
			onDrop={onOsDrop}
		>
			<div
				style={{
					height: Math.max(0, innerHeight),
					width: "100%",
					position: "relative",
				}}
			>
				{virtualizer.getVirtualItems().map((vRow) => {
					const item = items[vRow.index];
					if (!item) return null;
					if ("header" in item) {
						return (
							<div
								key={`header:${item.header.key}`}
								className="content-list__group-heading"
								role="presentation"
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									height: GROUP_HEADER_HEIGHT,
									transform: `translateY(${vRow.start}px)`,
								}}
							>
								{item.header.label}
							</div>
						);
					}
					const entity = item.entity;
					const lane = vRow.lane ?? 0;
					const itemStyle: React.CSSProperties = isGrid
						? {
								position: "absolute",
								top: 0,
								left: padding + lane * (tileWidth + gap),
								width: tileWidth,
								height: tileHeight,
								transform: `translateY(${vRow.start + padding}px)`,
							}
						: {
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								transform: `translateY(${vRow.start}px)`,
							};
					return (
						<div
							key={entity.id}
							{...getItemProps(item.rowIndex)}
							data-index={vRow.index}
							style={itemStyle}
						>
							<ContentRow
								entity={entity}
								store={store}
								runtime={runtime}
								onOpen={onOpen}
								onCollision={onCollision}
								onCycle={onCycle}
								onEditIcon={onEditIcon}
								onEditCover={onEditCover}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
}

type ContentRowProps = {
	entity: Entity;
	store: FilesStore;
	runtime: BrainstormRuntime | undefined;
	onOpen: (entity: Entity) => void;
	onCollision: (draft: string) => void;
	onCycle: (movingId: string, destId: string) => void;
	onEditIcon: (folderId: string) => void;
	onEditCover: (folderId: string) => void;
};

/** Legacy cell class per column — `__type`/`__modified` predate the
 *  chooser and the tile-mode stylesheets target them. */
const LIST_COLUMN_CLASS: Record<ListColumn, string> = {
	[ListColumn.Kind]: "content-row__type",
	[ListColumn.Modified]: "content-row__modified",
	[ListColumn.Size]: "content-row__size",
};

/** The text for one trailing list column. Folders (and anything without a
 *  numeric `size`) show an empty Size cell. */
function columnText(column: ListColumn, entity: Entity): string {
	if (column === ListColumn.Kind) return typeLabel(entity);
	if (column === ListColumn.Modified) return formatTimeAgo(entity.updatedAt);
	const size = entity.properties.size;
	return typeof size === "number" ? formatBytes(size) : "";
}

/** Trailing extension of `name`, uppercased for the tile chip ("JPG",
 *  "PDF"). Hidden-file prefixes and extension-less names yield null (the
 *  band keeps its plain surface). Capped so "markdown" doesn't blow the
 *  chip out. */
function extensionChip(name: string): string | null {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return null;
	const ext = name.slice(dot + 1);
	if (ext.length > 5) return null;
	return ext.toUpperCase();
}

/**
 * The tile-mode media slot (grid / gallery): image files render their
 * stored blob (`brainstorm://asset/<assetId>`, decided by the shell's
 * preview-safe `assetMime`); anything with its OWN icon renders it; other
 * files fall back to an extension chip so a tile is never an anonymous
 * blank rectangle. Folders render the folder glyph (the sanctioned
 * type-indicator exception to [[feedback_no_default_type_icon_fallback]] —
 * a container genuinely needs an indicator) on a neutral surface rather
 * than an empty tinted "cover" band.
 *
 * A non-File/Folder object (the universal browser) with no own icon shows
 * its default opener app's squircle (`brainstorm://app-icon/<appId>`) —
 * the same sanctioned type-identity badge the dashboard pins use, so a
 * Task/Note/Bookmark tile reads as *what it is* rather than going blank.
 */
function TileMedia({
	entity,
	iconSize,
	openerAppId,
}: {
	entity: Entity;
	iconSize: number;
	openerAppId: string | null;
}) {
	const icon = readEntityIcon(entity);
	const isFolder = entity.type === FOLDER_TYPE;
	const isFile = entity.type === FILE_TYPE;
	const assetId = entity.properties.assetId;
	const assetMime = entity.properties.assetMime;
	const hasImage =
		typeof assetId === "string" &&
		assetId !== "" &&
		typeof assetMime === "string" &&
		assetMime.startsWith("image/");
	const chip = isFile && !hasImage && !icon ? extensionChip(readName(entity)) : null;
	const appIcon = !isFolder && !isFile && !icon && !hasImage ? openerAppId : null;
	return (
		<span
			className="content-row__glyph"
			data-kind={isFolder ? "folder" : "file"}
			// Pipe the tile-size preset's icon metric to the stylesheet so the
			// glyph / squircle / thumbnail scale with the tile instead of the
			// CSS pinning one fixed pixel size across Small/Medium/Large.
			style={{ "--glyph-size": `${iconSize}px` } as React.CSSProperties}
			aria-hidden="true"
		>
			{hasImage ? (
				<img
					className="content-row__thumb"
					src={`brainstorm://asset/${assetId}`}
					alt=""
					loading="lazy"
					draggable={false}
				/>
			) : icon ? (
				<EntityIcon icon={icon} size={iconSize} />
			) : isFolder ? (
				<Icon name={IconName.Folder} size={iconSize} />
			) : appIcon ? (
				<img
					className="content-row__app-icon"
					src={`brainstorm://app-icon/${appIcon}`}
					alt=""
					loading="lazy"
					draggable={false}
				/>
			) : chip ? (
				<span className="content-row__ext">{chip}</span>
			) : null}
		</span>
	);
}

function ContentRow({
	entity,
	store,
	runtime,
	onOpen,
	onCollision,
	onCycle,
	onEditIcon,
	onEditCover,
}: ContentRowProps) {
	const selected = store.selection.selected.has(entity.id);
	const rowRef = useRef<HTMLDivElement | null>(null);
	// DND-5 — file bytes prefetched on export-grip pointerdown (see the grip below).
	const exportBytesRef = useRef<Promise<Uint8Array | null> | null>(null);
	// The column chooser is a LIST-mode feature; tile modes keep their
	// canonical caption cells (gallery shows Kind, grid hides both via CSS).
	const cellColumns = isListMode(store.viewMode) ? store.listColumns : DEFAULT_LIST_COLUMNS;
	const isFolder = entity.type === FOLDER_TYPE;

	// DND-4 source — a hover-revealed grip drives the shell-mediated cross-app
	// drag session via pointer events. `suppressNativeDragRef` flips the row's
	// native `draggable` (the existing intra-app move/copy DnD) off for the
	// gesture so the two transports don't fight over the same pointer-down. The
	// row keeps its native `draggable` for everything else.
	const { dragHandleProps, dragging } = useDragSource({
		getItems: () => dragItemsForEntry(entity, store.selection, store.visibleRows),
		suppressNativeDragRef: rowRef,
	});

	// DND-4 target — folders accept a dropped cross-app object and ADD it to
	// their membership (`DropSemantic.AddMembership`, non-destructive). The SDK
	// hook's native path reads the SHARED entity MIME
	// (`application/vnd.brainstorm.entity+json`), distinct from Files' own
	// intra-app `application/x-brainstorm-entity`, so the two never collide and
	// the existing move/copy handlers stay intact.
	const { dropProps, dropRef, isOver } = useDropTarget({
		accepts: (info) => isFolder && info.payloadKind === DragPayloadKind.Object,
		dropEffectFor: () => effectForSemantic(DropSemantic.AddMembership),
		onDrop: (payload) => {
			if (!isFolder) return;
			const ids = payload.items.map((item) => item.entityId).filter((id) => id !== entity.id);
			if (ids.length > 0) store.addMembers(entity.id, ids);
		},
	});
	// The row element is both the drag-source grip's `suppressNativeDragRef`
	// ancestor and the cross-app drop zone — give the registry its rect so the
	// folder under the cursor wins among sibling rows (not just the last one).
	const setRowRef = useCallback(
		(element: HTMLDivElement | null) => {
			rowRef.current = element;
			dropRef(element);
		},
		[dropRef],
	);
	const renaming =
		store.rename.status !== RenameStatus.Idle &&
		"entityId" in store.rename &&
		store.rename.entityId === entity.id;

	const menuContext = () =>
		filesObjectMenuContext({ entity, store, runtime, onEditIcon, onEditCover });

	function onRowClick(event: React.MouseEvent) {
		if (renaming) return;
		store.selectRow(entity.id, modifierFrom(event));
	}

	function onDragStart(event: React.DragEvent) {
		const ids = store.selection.selected.has(entity.id)
			? Array.from(store.selection.selected)
			: [entity.id];
		event.dataTransfer.setData(DND_MIME, JSON.stringify({ ids, sourceId: store.nav.current }));
		event.dataTransfer.setData("text/plain", readName(entity));
		event.dataTransfer.effectAllowed = "copyMove";
		applyDragImage(event.dataTransfer, readName(entity), ids.length);
	}

	function onDrop(event: React.DragEvent) {
		if (!isFolder) return;
		if (!event.dataTransfer.types.includes(DND_MIME)) return;
		event.preventDefault();
		let payload: { ids?: string[]; sourceId?: string };
		try {
			payload = JSON.parse(event.dataTransfer.getData(DND_MIME));
		} catch {
			return;
		}
		if (!Array.isArray(payload.ids) || typeof payload.sourceId !== "string") return;
		const moveSet = payload.ids.filter((id) => id !== entity.id);
		if (moveSet.length === 0) return;
		// 9.8.7 — Alt (macOS Option) at drop time = copy (membership-add),
		// not move. Mirrors Finder / macOS Files behaviour; same `altKey`
		// flag is the standard cue in Notes' DnD path. The picker chrome
		// already paints the cursor via `effectAllowed = "copyMove"` +
		// `dropEffect` toggle in `onDragOver`.
		if (event.altKey) {
			const result = store.copyIds(entity.id, moveSet);
			if (!result.ok && result.reason === "cycle") {
				onCycle(moveSet[0] ?? "", entity.id);
			}
			return;
		}
		const result = store.moveIds(payload.sourceId, entity.id, moveSet);
		if (!result.ok && result.reason === "cycle") {
			onCycle(moveSet[0] ?? "", entity.id);
		}
	}

	return (
		<ObjectMenuTrigger
			context={menuContext}
			moreActionsLabel={t("brainstorm.files.menu.more")}
			className="content-row__menu-host"
			variant="row"
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is the shared shortcut layer (Enter=Open, Space=Quick Look) bound at app root */}
			<div
				ref={setRowRef}
				className="content-row"
				data-testid="content-row"
				data-id={entity.id}
				data-selected={selected ? "true" : "false"}
				data-dragging={dragging ? "true" : undefined}
				data-cross-over={isFolder && isOver ? "true" : undefined}
				data-view-mode={store.viewMode}
				// List mode sizes the trailing tracks from the visible column
				// set (9.8.11); tile modes keep their stylesheet layout.
				style={
					isListMode(store.viewMode)
						? {
								gridTemplateColumns: `auto minmax(0, 1fr) ${store.listColumns
									.map((c) => LIST_COLUMN_WIDTH[c])
									.join(" ")}`.trimEnd(),
							}
						: undefined
				}
				draggable={!renaming}
				onClick={onRowClick}
				onDoubleClick={() => !renaming && onOpen(entity)}
				onDragStart={onDragStart}
				onDragOver={(e) => {
					if (isFolder && e.dataTransfer.types.includes(DND_MIME)) {
						e.preventDefault();
						e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
						return;
					}
					// Cross-app drag (shared entity MIME) — let the SDK target
					// negotiate it. Files' own DND_MIME is handled above and never
					// reaches here.
					dropProps.onDragOver(e);
				}}
				onDragLeave={dropProps.onDragLeave}
				onDrop={(e) => {
					if (e.dataTransfer.types.includes(DND_MIME)) {
						onDrop(e);
						return;
					}
					dropProps.onDrop(e);
				}}
			>
				<button
					type="button"
					className="content-row__drag-grip"
					draggable={false}
					aria-label={t("brainstorm.files.row.dragToApp")}
					data-bs-tooltip={t("brainstorm.files.row.dragToApp")}
					tabIndex={-1}
					{...dragHandleProps}
				>
					<Icon name={IconName.DragHandle} size={14} />
				</button>
				{!isFolder ? (
					// DND-5 — its own native-draggable handle (the nearest draggable
					// ancestor when grabbed) so a file export doesn't fight the row's
					// intra-app move on the row body. Pointer-only (the keyboard path is
					// the object menu), so it's out of the tab order. Bytes are
					// PREFETCHED on pointerdown so `dragstart` can hand the OS drag off
					// without an intervening `await` (else startDrag misses the gesture).
					<button
						type="button"
						className="content-row__export-grip"
						draggable
						tabIndex={-1}
						aria-label={t("brainstorm.files.row.exportOut")}
						data-bs-tooltip={t("brainstorm.files.row.exportOut")}
						onPointerDown={() => {
							exportBytesRef.current = fetchExportBytes(entity);
						}}
						onClick={() => {
							// A press that didn't become a drag — drop the prefetched bytes
							// so a large file's buffer isn't pinned in the ref.
							exportBytesRef.current = null;
						}}
						onDragStart={(event) => {
							event.stopPropagation();
							event.preventDefault();
							const exportFile = runtime?.services?.dnd?.exportFile;
							if (!exportFile) return;
							const pending = exportBytesRef.current ?? fetchExportBytes(entity);
							exportBytesRef.current = null;
							void pending.then((bytes) => {
								if (bytes) void exportFile({ name: readName(entity), bytes });
							});
						}}
					>
						<Icon name={IconName.OpenExternal} size={13} />
					</button>
				) : null}
				{isTileMediaMode(store.viewMode) ? (
					<TileMedia
						entity={entity}
						iconSize={iconSizeFor(store.viewMode, store.tileSize)}
						openerAppId={store.openerForType(entity.type)?.appId ?? null}
					/>
				) : isFolder && !readEntityIcon(entity) ? (
					<span className="content-row__glyph" data-glyph="folder" aria-hidden="true">
						<Icon name={IconName.Folder} size={iconSizeFor(store.viewMode, store.tileSize)} />
					</span>
				) : (
					<EntityIcon
						icon={readEntityIcon(entity)}
						size={iconSizeFor(store.viewMode, store.tileSize)}
						className="content-row__glyph"
					/>
				)}
				<span className="content-row__name">
					{renaming ? (
						<RenameInput store={store} entity={entity} onCollision={onCollision} />
					) : (
						readName(entity)
					)}
				</span>
				{cellColumns.map((column) => (
					<span key={column} className={LIST_COLUMN_CLASS[column]}>
						{columnText(column, entity)}
					</span>
				))}
			</div>
		</ObjectMenuTrigger>
	);
}

type RenameInputProps = {
	store: FilesStore;
	entity: Entity;
	onCollision: (draft: string) => void;
};

function RenameInput({ store, entity, onCollision }: RenameInputProps) {
	const ref = useRef<HTMLInputElement>(null);
	const draft =
		store.rename.status !== RenameStatus.Idle && "draft" in store.rename
			? store.rename.draft
			: readName(entity);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.focus();
		const range = initialSelectionRange(el.value);
		el.setSelectionRange(range.start, range.end);
	}, []);

	return (
		<input
			ref={ref}
			type="text"
			className="bs-input bs-input--sm content-row__rename-input"
			data-testid="rename-input"
			value={draft}
			aria-label={t("brainstorm.files.rename.inputLabel", { name: readName(entity) })}
			onClick={(e) => e.stopPropagation()}
			onChange={(e) => store.editRenameDraft(e.target.value)}
			onBlur={() => {
				const collision = store.commitRename();
				if (collision !== null) onCollision(collision);
			}}
			// keyboard-exempt: input-local rename commit/cancel — Enter commits, Escape
			// cancels the inline rename field; field-scoped, not an app shortcut.
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					const collision = store.commitRename();
					if (collision !== null) onCollision(collision);
				} else if (e.key === "Escape") {
					e.preventDefault();
					store.cancelRename();
				}
			}}
		/>
	);
}
