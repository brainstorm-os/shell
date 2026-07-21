/**
 * Preorder-flatten the visible folder tree into the flat `TreeNode[]` array the
 * SDK `useTreeKeyboard` reducer (KBN-A-files) navigates. A collapsed parent's
 * subtree is omitted, so the flat order === the on-screen order of the
 * recursive `<TreeNode>` render — the contract the reducer relies on to map
 * ArrowUp/Down to the next visible row.
 */

import type { TreeNode } from "@brainstorm-os/sdk/a11y";
import { FOLDER_TYPE, ROOT_FOLDER_ID } from "../types/entity";
import type { FolderTree } from "./folder-tree";

export function flattenVisibleTree(
	tree: FolderTree,
	expandedFolders: ReadonlySet<string>,
): TreeNode[] {
	const out: TreeNode[] = [];
	const walk = (id: string, level: number, parentId: string | null): void => {
		const entity = tree.get(id);
		if (!entity || entity.type !== FOLDER_TYPE) return;
		const children = tree.listChildFolders(id);
		const hasChildren = children.length > 0;
		const expanded = expandedFolders.has(id);
		out.push({ id, level, parentId, expanded, hasChildren });
		if (hasChildren && expanded) {
			for (const child of children) walk(child.id, level + 1, id);
		}
	};
	walk(ROOT_FOLDER_ID, 0, null);
	return out;
}
