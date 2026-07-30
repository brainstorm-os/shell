/**
 * The FILES sidebar as a folder TREE (9.7.12).
 *
 * A `CodeFile/v1` carries no hierarchy — a folder is a shared `/`-prefix of
 * the paths that exist — so the rows come from the pure `buildPathTree`
 * projection and the keyboard model is the SDK tree reducer
 * (`useTreeKeyboard`: role=tree/treeitem, aria-level, aria-expanded,
 * ArrowUp/Down over the VISIBLE flat array, ArrowLeft/Right collapse/expand,
 * Enter/Space activate). Mirrors `apps/files/src/ui/sidebar-tree.tsx`, the one
 * worked example.
 *
 * Selection follows focus on FILE rows (select === open, the behaviour this
 * sidebar always had); moving onto a FOLDER row only moves focus — a folder
 * has nothing to open, and Enter/Space toggles it instead.
 */

import { NavigationMode, navModeFromEvent } from "@brainstorm-os/sdk";
import type { DropEffect, ObjectDragPayload } from "@brainstorm-os/sdk-types";
import { type TreeItemProps, useTreeKeyboard } from "@brainstorm-os/sdk/a11y";
import { setObjectDragData } from "@brainstorm-os/sdk/entity-drag";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { type ContextMenuItem, openContextMenu, sdkMenuIcon } from "@brainstorm-os/sdk/menus";
import { DropSemantic, effectForSemantic, useDropTarget } from "@brainstorm-os/sdk/object-dnd";
import { ObjectMenuMoreButton, openObjectMenu } from "@brainstorm-os/sdk/object-menu";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import type { CodeFileRow } from "../logic/code-projection";
import { fileName } from "../logic/code-view";
import { PathNodeKind, type PathTreeNode, buildPathTree, dirOf } from "../logic/path-tree";
import { CODE_FILE_ENTITY_TYPE } from "../runtime";
import { EntityIcon } from "./entity-icon";
import type { codeFileObjectMenuContext } from "./object-menu-context";

/** Indent per tree level — wide enough that a nested row reads as nested,
 *  narrow enough that a 3-deep path still fits the 248px panel. */
const INDENT_PX = 14;
/** Inline-start inset of a level-0 row (the caret column's left edge). */
const BASE_INSET_PX = 6;

/** Intra-app folder drags ride their own MIME: a folder is not an entity, so
 *  it can't travel on the shared object payload. */
const FOLDER_DRAG_MIME = "application/x-brainstorm-code-folder";

export interface FileTreeProps {
	rows: CodeFileRow[];
	selectedId: string | null;
	/** Ids carrying unsaved in-memory edits. */
	dirtyIds: ReadonlySet<string>;
	/** Folder prefixes whose subtree is hidden. */
	collapsed: ReadonlySet<string>;
	/** UI-only folders holding no file yet. */
	pendingFolders: readonly string[];
	canCreate: boolean;
	onToggleFolder: (folderPath: string) => void;
	/** The folder the next create should land in changed (a row took focus). */
	onFocusFolderChange: (folderPath: string) => void;
	onOpen: (row: CodeFileRow, mode: NavigationMode) => void;
	onCreateFile: (folderPath: string) => void | Promise<void>;
	onCreateFolder: (folderPath: string) => void;
	onRenameFolder: (folderPath: string) => void;
	onRemoveFolder: (folderPath: string) => void;
	/** Move files into `folderPath` (`""` = the root). */
	onMoveFiles: (entityIds: readonly string[], folderPath: string) => void;
	onMoveFolder: (folderPath: string, destFolder: string) => void;
	menuContext: (row: CodeFileRow) => ReturnType<typeof codeFileObjectMenuContext>;
}

export function FileTree(props: FileTreeProps): ReactElement {
	const {
		rows,
		selectedId,
		collapsed,
		pendingFolders,
		canCreate,
		onToggleFolder,
		onFocusFolderChange,
		onOpen,
		onCreateFile,
		onCreateFolder,
	} = props;

	const nodes = useMemo(
		() =>
			buildPathTree(
				rows.map((row) => ({ id: row.id, path: row.path })),
				{ collapsed, extraFolders: pendingFolders },
			),
		[rows, collapsed, pendingFolders],
	);
	const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

	// The tree's roving focus. Selection drives it (opening a file from the
	// quick-open palette or a chord must move the highlight), but a folder row
	// can hold focus on its own — hence its own id rather than `selectedId`.
	const [activeId, setActiveId] = useState<string | null>(selectedId);
	useEffect(() => {
		if (selectedId !== null) setActiveId(selectedId);
	}, [selectedId]);
	const active = useMemo(() => nodes.find((n) => n.id === activeId) ?? null, [nodes, activeId]);

	// Where a create lands: the focused folder, or the focused file's folder —
	// the explorer convention. Published upward so the header "+" agrees with
	// the sidebar's own affordances.
	const focusFolder = active
		? active.kind === PathNodeKind.Folder
			? active.path
			: dirOf(active.path)
		: "";
	useEffect(() => onFocusFolderChange(focusFolder), [focusFolder, onFocusFolderChange]);

	const activate = useCallback(
		(id: string): void => {
			const node = nodes.find((n) => n.id === id);
			if (!node) return;
			if (node.kind === PathNodeKind.Folder) {
				onToggleFolder(node.path);
				return;
			}
			const row = rowById.get(node.id);
			if (row) onOpen(row, NavigationMode.Replace);
		},
		[nodes, rowById, onToggleFolder, onOpen],
	);

	const moveActive = useCallback(
		(id: string): void => {
			setActiveId(id);
			const node = nodes.find((n) => n.id === id);
			if (!node || node.kind === PathNodeKind.Folder) return;
			const row = rowById.get(node.id);
			if (row) onOpen(row, NavigationMode.Replace);
		},
		[nodes, rowById, onOpen],
	);

	const { containerProps, getNodeProps } = useTreeKeyboard({
		nodes,
		activeId,
		onActiveIdChange: moveActive,
		onToggle: (id) => {
			const node = nodes.find((n) => n.id === id);
			if (node?.kind === PathNodeKind.Folder) onToggleFolder(node.path);
		},
		onActivate: activate,
	});

	// The list body is the ROOT drop zone, so dragging a row onto empty space
	// below the tree moves it back to the top level.
	const root = useFolderDrop(props, "");
	const setListRef = useCallback(
		(element: HTMLElement | null) => {
			containerProps.ref(element);
			root.dropRef(element);
		},
		[containerProps.ref, root.dropRef],
	);

	return (
		<nav className="editor__files" aria-label={t("filesRegion")}>
			<div className="editor__files-head">
				<span className="editor__files-heading">{t("filesHeading")}</span>
				{canCreate ? (
					<div className="editor__files-actions">
						<button
							type="button"
							className="bs-btn bs-btn--sm bs-btn--icon"
							data-bs-tooltip={t("newFolderHint")}
							aria-label={t("newFolderHint")}
							onClick={() => onCreateFolder(focusFolder)}
						>
							<Icon name={IconName.FolderPlus} size={15} />
						</button>
						<button
							type="button"
							className="bs-btn bs-btn--sm editor__file-new"
							data-bs-tooltip={t("newFileHint")}
							onClick={() => void onCreateFile(focusFolder)}
						>
							{t("newFile")}
						</button>
					</div>
				) : null}
			</div>
			<div
				{...containerProps}
				{...root.dropProps}
				ref={setListRef}
				className="editor__file-list"
				aria-label={t("filesRegion")}
				data-drop-over={root.isOver ? "true" : undefined}
			>
				{nodes.map((node) =>
					node.kind === PathNodeKind.Folder ? (
						<FolderRow
							key={node.id}
							node={node}
							itemProps={getNodeProps(node)}
							tree={props}
							onFocusRow={setActiveId}
						/>
					) : (
						<FileRow
							key={node.id}
							node={node}
							row={rowById.get(node.id)}
							itemProps={getNodeProps(node)}
							tree={props}
							onFocusRow={setActiveId}
						/>
					),
				)}
			</div>
		</nav>
	);
}

type FolderDropHandle = {
	isOver: boolean;
	dropRef: (element: HTMLElement | null) => void;
	dropProps: {
		onDragOver: (event: React.DragEvent) => void;
		onDragLeave: (event: React.DragEvent) => void;
		onDrop: (event: React.DragEvent) => void;
		"aria-dropeffect"?: DropEffect;
	};
};

/** One folder's drop behaviour over BOTH transports: the shared object
 *  payload (a file row from this tree — and, for free, a code file dragged in
 *  from another app) via the SDK `useDropTarget`, plus the app-local folder
 *  MIME for folder-into-folder moves. */
function useFolderDrop(tree: FileTreeProps, folderPath: string): FolderDropHandle {
	const { onMoveFiles, onMoveFolder } = tree;
	const [folderOver, setFolderOver] = useState(false);
	const object = useDropTarget({
		// Native hover can't read the payload types (blanked for security), so
		// gate leniently on hover and strictly on drop.
		accepts: (info) => info.itemTypes.length === 0 || info.itemTypes.includes(CODE_FILE_ENTITY_TYPE),
		dropEffectFor: () => effectForSemantic(DropSemantic.Move),
		onDrop: (payload: ObjectDragPayload) => {
			const ids = payload.items
				.filter((item) => item.entityType === CODE_FILE_ENTITY_TYPE)
				.map((item) => item.entityId);
			if (ids.length > 0) onMoveFiles(ids, folderPath);
		},
	});

	const carriesFolder = (event: React.DragEvent): boolean =>
		event.dataTransfer.types.includes(FOLDER_DRAG_MIME);

	return {
		isOver: object.isOver || folderOver,
		dropRef: object.dropRef,
		dropProps: {
			...object.dropProps,
			onDragOver: (event) => {
				if (carriesFolder(event)) {
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "move";
					setFolderOver(true);
					return;
				}
				object.dropProps.onDragOver(event);
			},
			onDragLeave: (event) => {
				setFolderOver(false);
				object.dropProps.onDragLeave(event);
			},
			onDrop: (event) => {
				setFolderOver(false);
				if (carriesFolder(event)) {
					event.preventDefault();
					event.stopPropagation();
					const source = event.dataTransfer.getData(FOLDER_DRAG_MIME);
					if (source.length > 0) onMoveFolder(source, folderPath);
					return;
				}
				object.dropProps.onDrop(event);
			},
		},
	};
}

function indentStyle(level: number): React.CSSProperties {
	return { paddingInlineStart: `${BASE_INSET_PX + level * INDENT_PX}px` };
}

/** The shared ⋯ chrome, reused verbatim for the folder rows the entity-bound
 *  `<ObjectMenuMoreButton>` can't serve (a folder is not an object). */
function MoreDots(): ReactElement {
	return (
		<>
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
			<span className="bs-object-menu__more-dot" />
		</>
	);
}

function FolderRow({
	node,
	itemProps,
	tree,
	onFocusRow,
}: {
	node: PathTreeNode;
	itemProps: TreeItemProps;
	tree: FileTreeProps;
	onFocusRow: (id: string) => void;
}): ReactElement {
	const drop = useFolderDrop(tree, node.path);
	const moreRef = useRef<HTMLButtonElement>(null);
	const { onToggleFolder, onCreateFile, onCreateFolder, onRenameFolder, onRemoveFolder, canCreate } =
		tree;
	const menuLabel = t("folderMenuLabel", { name: node.name });

	const openMenu = useCallback(
		(point: { x: number; y: number }, anchor?: HTMLElement): void => {
			const items: ContextMenuItem[] = [];
			if (canCreate) {
				items.push(
					{
						id: "new-file",
						label: t("newFileHere"),
						icon: sdkMenuIcon(IconName.Plus),
						onSelect: () => void onCreateFile(node.path),
					},
					{
						id: "new-folder",
						label: t("newFolder"),
						icon: sdkMenuIcon(IconName.FolderPlus),
						onSelect: () => onCreateFolder(node.path),
					},
					{ id: "sep", label: "", divider: true },
				);
			}
			items.push({
				id: "rename",
				label: t("folderRename"),
				icon: sdkMenuIcon(IconName.Pencil),
				onSelect: () => onRenameFolder(node.path),
			});
			if (node.empty) {
				items.push({
					id: "remove",
					label: t("folderRemove"),
					icon: sdkMenuIcon(IconName.Trash),
					destructive: true,
					onSelect: () => onRemoveFolder(node.path),
				});
			}
			openContextMenu(point, items, { menuLabel, ...(anchor ? { anchor } : {}) });
		},
		[node, menuLabel, canCreate, onCreateFile, onCreateFolder, onRenameFolder, onRemoveFolder],
	);

	return (
		<div
			{...itemProps}
			{...drop.dropProps}
			ref={drop.dropRef}
			className="editor__file editor__folder bs-object-menu__host bs-object-menu__host--row"
			data-drop-over={drop.isOver ? "true" : undefined}
			data-folder-path={node.path}
			draggable
			onDragStart={(event) => {
				event.dataTransfer.setData(FOLDER_DRAG_MIME, node.path);
				event.dataTransfer.effectAllowed = "move";
			}}
			onFocus={() => onFocusRow(node.id)}
			onClick={() => {
				onFocusRow(node.id);
				onToggleFolder(node.path);
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				openMenu({ x: event.clientX, y: event.clientY });
			}}
		>
			<span className="editor__file-open editor__folder-face" style={indentStyle(node.level)}>
				<Icon
					name={node.expanded ? IconName.CaretDown : IconName.CaretRight}
					size={12}
					className="editor__folder-caret"
				/>
				<Icon name={IconName.Folder} size={15} className="editor__file-icon" />
				<span className="editor__file-name">{node.name}</span>
			</span>
			<button
				ref={moreRef}
				type="button"
				className="bs-object-menu__more"
				aria-haspopup="menu"
				aria-label={menuLabel}
				data-bs-tooltip={menuLabel}
				tabIndex={-1}
				onClick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					const anchor = moreRef.current;
					if (!anchor) return;
					const rect = anchor.getBoundingClientRect();
					openMenu({ x: rect.left, y: rect.bottom }, anchor);
				}}
			>
				<MoreDots />
			</button>
		</div>
	);
}

/** A single file row. The `.editor__file` element is itself the object-menu
 *  host (carrying the tree row semantics + `aria-current` for the open file),
 *  with a right-click opener and the trailing ⋯ `ObjectMenuMoreButton`. */
function FileRow({
	node,
	row,
	itemProps,
	tree,
	onFocusRow,
}: {
	node: PathTreeNode;
	row: CodeFileRow | undefined;
	itemProps: TreeItemProps;
	tree: FileTreeProps;
	onFocusRow: (id: string) => void;
}): ReactElement | null {
	const { onOpen, menuContext, selectedId, dirtyIds } = tree;
	const context = useCallback(() => (row ? menuContext(row) : null), [menuContext, row]);
	const onContextMenu = useCallback(
		(event: React.MouseEvent) => {
			const ctx = context();
			if (!ctx) return;
			event.preventDefault();
			void openObjectMenu({ x: event.clientX, y: event.clientY }, ctx);
		},
		[context],
	);
	if (!row) return null;
	const label = fileName(row.path);
	return (
		<div
			{...itemProps}
			className="editor__file bs-object-menu__host bs-object-menu__host--row"
			aria-current={row.id === selectedId ? "true" : "false"}
			data-file-id={row.id}
			// A locked file is read-only: it can't be moved, so it can't be dragged.
			draggable={!row.locked}
			onDragStart={(event) => {
				setObjectDragData(event.dataTransfer, {
					v: 1,
					sourceApp: "",
					items: [{ entityId: row.id, entityType: CODE_FILE_ENTITY_TYPE, label }],
				});
				event.dataTransfer.effectAllowed = "move";
			}}
			onFocus={() => onFocusRow(row.id)}
			onContextMenu={onContextMenu}
		>
			<button
				type="button"
				className="editor__file-open"
				style={indentStyle(node.level)}
				title={row.path}
				tabIndex={-1}
				onClick={(event) => {
					onFocusRow(row.id);
					onOpen(row, navModeFromEvent(event.nativeEvent));
				}}
				onAuxClick={(event) => {
					if (event.button === 1) onOpen(row, navModeFromEvent(event.nativeEvent));
				}}
			>
				<span className="editor__folder-caret" aria-hidden="true" />
				<EntityIcon icon={row.icon} size={15} fallback={IconName.View} />
				<span className="editor__file-name">{label}</span>
				{dirtyIds.has(row.id) ? (
					<span className="editor__file-dirty" aria-label={t("fileUnsaved")} />
				) : null}
			</button>
			<ObjectMenuMoreButton
				context={context}
				moreActionsLabel={t("menuMoreActions", { name: label })}
			/>
		</div>
	);
}
