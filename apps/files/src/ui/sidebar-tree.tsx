/**
 * The left navigation sidebar — folder tree (recursive), drop targets,
 * collapsible sections. Navigation panels live on the left per the
 * project-wide app-panel-sides convention.
 */

import { DragPayloadKind } from "@brainstorm-os/sdk-types";
import {
	type TreeNode as KbnTreeNode,
	type TreeItemProps,
	useTreeKeyboard,
} from "@brainstorm-os/sdk/a11y";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { DropSemantic, effectForSemantic, useDropTarget } from "@brainstorm-os/sdk/object-dnd";
import { useMemo, useState } from "react";
import { t } from "../i18n";
import { flattenVisibleTree } from "../logic/tree-flatten";
import type { FilesStore } from "../store/use-files-store";
import { FOLDER_TYPE, ROOT_FOLDER_ID, readName } from "../types/entity";
import { Caret, CaretDirection } from "./affordance";
import { readEntityIcon } from "./entity-view";
import { EntityIcon } from "./entity-visuals";

const DND_MIME = "application/x-brainstorm-entity";

export type SidebarTreeProps = {
	store: FilesStore;
	onCycle: (movingId: string, destId: string) => void;
};

export function SidebarTree({ store, onCycle }: SidebarTreeProps) {
	// KBN-A-files: the folder tree adopts the SDK `useTreeKeyboard` reducer.
	// The flat visible-node list (collapsed subtrees omitted) drives ArrowUp/Down
	// order; ArrowLeft/Right collapse/expand; Enter/move navigates into the
	// folder (selecting a folder === showing it, matching the click model).
	const nodes = useMemo(
		() => flattenVisibleTree(store.tree, store.expandedFolders),
		[store.tree, store.expandedFolders],
	);
	const { containerProps, getNodeProps } = useTreeKeyboard({
		nodes,
		activeId: store.nav.current,
		onActiveIdChange: store.navigateToFolder,
		onToggle: (folderId) => store.toggleFolderExpansion(folderId),
		onActivate: store.navigateToFolder,
	});
	return (
		<ul {...containerProps} className="sidebar__list sidebar__tree" id="sidebar-tree">
			<TreeNode
				store={store}
				id={ROOT_FOLDER_ID}
				depth={0}
				onCycle={onCycle}
				getNodeProps={getNodeProps}
			/>
		</ul>
	);
}

type TreeNodeProps = {
	store: FilesStore;
	id: string;
	depth: number;
	onCycle: (movingId: string, destId: string) => void;
	getNodeProps: (node: KbnTreeNode) => TreeItemProps;
};

function TreeNode({ store, id, depth, onCycle, getNodeProps }: TreeNodeProps) {
	const entity = store.tree.get(id);
	if (!entity || entity.type !== FOLDER_TYPE) return null;

	const childFolders = store.tree.listChildFolders(id);
	const expandable = childFolders.length > 0;
	const ownIcon = readEntityIcon(entity);
	const expanded = store.expandedFolders.has(id);
	const itemProps = getNodeProps({
		id,
		level: depth,
		parentId: store.tree.findParentId(id) ?? null,
		expanded,
		hasChildren: expandable,
	});

	function onDrop(event: React.DragEvent) {
		if (!event.dataTransfer.types.includes(DND_MIME)) return;
		event.preventDefault();
		let payload: { ids?: string[]; sourceId?: string };
		try {
			payload = JSON.parse(event.dataTransfer.getData(DND_MIME));
		} catch {
			return;
		}
		if (!Array.isArray(payload.ids) || typeof payload.sourceId !== "string") return;
		const moveSet = payload.ids.filter((m) => m !== id);
		if (moveSet.length === 0) return;
		// 9.8.7 — Alt at drop time = copy (membership-add), parity with the
		// content-list drop handler.
		if (event.altKey) {
			const result = store.copyIds(id, moveSet);
			if (!result.ok && result.reason === "cycle") onCycle(moveSet[0] ?? "", id);
			return;
		}
		const result = store.moveIds(payload.sourceId, id, moveSet);
		if (!result.ok && result.reason === "cycle") onCycle(moveSet[0] ?? "", id);
	}

	// DND-4 — a tree folder accepts a dropped cross-app object and adds it to
	// membership (non-destructive). The SDK hook reads the SHARED entity MIME,
	// distinct from Files' own `DND_MIME`, so the two transports never collide.
	const { dropProps, dropRef, isOver } = useDropTarget({
		accepts: (info) => info.payloadKind === DragPayloadKind.Object,
		dropEffectFor: () => effectForSemantic(DropSemantic.AddMembership),
		onDrop: (payload) => {
			const ids = payload.items.map((item) => item.entityId).filter((m) => m !== id);
			if (ids.length > 0) store.addMembers(id, ids);
		},
	});

	return (
		<li>
			{/* kbn-onclick-exempt: role + roving tabindex come from `getNodeProps` (spread); keyboard activation is the container's `useTreeKeyboard` reducer */}
			<div
				{...itemProps}
				ref={dropRef}
				className="sidebar__tree-row"
				data-id={id}
				data-cross-over={isOver ? "true" : undefined}
				style={{ paddingLeft: `${8 + depth * 12}px` }}
				onClick={() => store.navigateToFolder(id)}
				onDragOver={(e) => {
					if (e.dataTransfer.types.includes(DND_MIME)) {
						e.preventDefault();
						e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
						return;
					}
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
					className={
						expandable
							? "sidebar__chevron sidebar__chevron--expand"
							: "sidebar__chevron sidebar__chevron--hidden"
					}
					aria-hidden="true"
					tabIndex={-1}
					onClick={(e) => {
						e.stopPropagation();
						if (expandable) store.toggleFolderExpansion(id);
					}}
				>
					{expandable ? (
						<Caret direction={expanded ? CaretDirection.Down : CaretDirection.Right} size={12} />
					) : null}
				</button>
				{/* A folder tree is a navigation surface where a folder glyph is the
				    object's natural identity, so the no-default-type-icon rule (which
				    governs arbitrary entity lists) gives way to a Folder fallback here —
				    without it the rows lose their icon column and the names misalign. */}
				{ownIcon ? (
					<EntityIcon icon={ownIcon} size={16} className="sidebar__glyph" />
				) : (
					<Icon name={IconName.Folder} size={16} className="sidebar__glyph" />
				)}
				<span className="sidebar__name">{readName(entity)}</span>
			</div>
			{expandable && expanded ? (
				<ul className="sidebar__list" role="group">
					{childFolders.map((child) => (
						<TreeNode
							key={child.id}
							store={store}
							id={child.id}
							depth={depth + 1}
							onCycle={onCycle}
							getNodeProps={getNodeProps}
						/>
					))}
				</ul>
			) : null}
		</li>
	);
}

export type SidebarSectionProps = {
	titleKey: Parameters<typeof t>[0];
	defaultCollapsed?: boolean;
	children: React.ReactNode;
};

export function SidebarSection({
	titleKey,
	defaultCollapsed = false,
	children,
}: SidebarSectionProps) {
	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	return (
		<section className="sidebar__section" data-collapsed={collapsed}>
			<button
				type="button"
				className="sidebar__section-header"
				onClick={() => setCollapsed((c) => !c)}
				aria-expanded={!collapsed}
			>
				<span className="sidebar__section-chevron">
					<Caret direction={collapsed ? CaretDirection.Right : CaretDirection.Down} size={11} />
				</span>
				<span>{t(titleKey)}</span>
			</button>
			{!collapsed ? children : null}
		</section>
	);
}

/**
 * An intentional disabled affordance for a sidebar section whose feature
 * has not shipped yet — replaces the former bare italic placeholder text.
 * Reads as a deliberate "not yet" (muted icon + label + a quiet "Coming
 * soon" tag), not a layout gap or a dangling string.
 */
export function SidebarComingSoon({
	icon,
	labelKey,
}: {
	icon: IconName;
	labelKey: Parameters<typeof t>[0];
}) {
	return (
		<div className="sidebar__coming-soon" aria-disabled="true">
			<Icon name={icon} size={15} className="sidebar__coming-soon-glyph" />
			<span className="sidebar__coming-soon-label">{t(labelKey)}</span>
			<span className="sidebar__coming-soon-tag">{t("brainstorm.files.sidebar.comingSoon")}</span>
		</div>
	);
}
