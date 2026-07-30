/**
 * Paths → tree (9.7.12). A `CodeFile/v1` has no hierarchy of its own: `path`
 * is a free-form vault-relative organizing string, so a FOLDER is nothing but
 * a shared `/`-separated prefix of the paths that exist. This module derives
 * the folder nodes from those prefixes and flattens the visible tree into the
 * preorder array the SDK `useTreeKeyboard` reducer walks — the direct
 * analogue of Files' `tree-flatten.ts`, minus the entity store (there are no
 * folder entities to model, and deliberately so: a second source of truth
 * would fight `path` and break the agent's already-nested output).
 *
 * Pure — no DOM, no service, no React. The app owns the collapsed set and the
 * pending-folder set and feeds them in.
 */

export enum PathNodeKind {
	Folder = "folder",
	File = "file",
}

/** The minimum a caller must supply per file: its entity id + its path. */
export interface PathTreeEntry {
	id: string;
	path: string;
}

export interface PathTreeNode {
	/** Stable node id — the entity id for a file, `dir:<path>` for a folder.
	 *  Unique across both kinds because an entity id never carries `/`. */
	id: string;
	kind: PathNodeKind;
	/** Full path for a file; the folder prefix (no trailing `/`) for a folder. */
	path: string;
	/** Last path segment — what the row labels. */
	name: string;
	level: number;
	parentId: string | null;
	expanded: boolean;
	hasChildren: boolean;
	/** The entity id, for a file node; `null` on folders. */
	fileId: string | null;
	/** Folder nodes: no file lives anywhere beneath it (so it exists only as a
	 *  pending UI-only folder and may be dismissed without touching the vault). */
	empty: boolean;
}

const FOLDER_NODE_PREFIX = "dir:";
export const PATH_SEPARATOR = "/";

/** The tree-node id for a folder prefix. */
export function folderNodeId(path: string): string {
	return `${FOLDER_NODE_PREFIX}${path}`;
}

/** The folder prefix a folder node id denotes, or `null` for a file node. */
export function folderPathFromNodeId(nodeId: string): string | null {
	return nodeId.startsWith(FOLDER_NODE_PREFIX) ? nodeId.slice(FOLDER_NODE_PREFIX.length) : null;
}

/** Split a path into its non-empty segments (`a//b.ts` → `["a", "b.ts"]`), so
 *  a hand-typed stray/leading slash never mints an unnamed folder. */
export function pathSegments(path: string): string[] {
	return path.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
}

/** The folder a path lives in — `""` for a root-level path. */
export function dirOf(path: string): string {
	const segments = pathSegments(path);
	segments.pop();
	return segments.join(PATH_SEPARATOR);
}

/** The last segment of a path (its display name). */
export function baseOf(path: string): string {
	const segments = pathSegments(path);
	return segments[segments.length - 1] ?? path;
}

/** Join a folder prefix and a name; `""` prefix yields a root-level path. */
export function joinPath(dir: string, name: string): string {
	const prefix = pathSegments(dir).join(PATH_SEPARATOR);
	return prefix.length === 0 ? name : `${prefix}${PATH_SEPARATOR}${name}`;
}

/** Every ancestor folder prefix of `path`, outermost first (the path's own
 *  folder last). A file path contributes its containing folders; a folder
 *  path contributes its own chain including itself. */
export function ancestorFolders(path: string, includeSelf = false): string[] {
	const segments = pathSegments(path);
	if (!includeSelf) segments.pop();
	const out: string[] = [];
	let acc = "";
	for (const segment of segments) {
		acc = acc.length === 0 ? segment : `${acc}${PATH_SEPARATOR}${segment}`;
		out.push(acc);
	}
	return out;
}

/** Is `path` inside `folder` (at any depth)? The root (`""`) contains every
 *  path; a folder never contains itself. Case-insensitive, matching the
 *  collision rule `validateRenamePath` already enforces on paths. */
export function isUnder(path: string, folder: string): boolean {
	if (folder.length === 0) return true;
	return path.toLowerCase().startsWith(`${folder.toLowerCase()}${PATH_SEPARATOR}`);
}

/** Rewrite the leading `from` folder prefix of `path` to `to`. Returns `path`
 *  unchanged when it isn't under `from`; the root prefix is not rewritable
 *  (there is no path text to replace). */
export function rewritePathPrefix(path: string, from: string, to: string): string {
	if (from.length === 0 || !isUnder(path, from)) return path;
	const tail = path.slice(from.length + PATH_SEPARATOR.length);
	return joinPath(to, tail);
}

type DirNode = {
	path: string;
	name: string;
	children: Map<string, DirNode>;
	files: PathTreeEntry[];
};

function makeDir(path: string, name: string): DirNode {
	return { path, name, children: new Map(), files: [] };
}

/** Walk/create the `DirNode` chain for a folder prefix. */
function ensureDir(root: DirNode, segments: readonly string[]): DirNode {
	let node = root;
	let acc = "";
	for (const segment of segments) {
		acc = acc.length === 0 ? segment : `${acc}${PATH_SEPARATOR}${segment}`;
		const key = segment.toLowerCase();
		let child = node.children.get(key);
		if (!child) {
			child = makeDir(acc, segment);
			node.children.set(key, child);
		}
		node = child;
	}
	return node;
}

function compareNames(a: string, b: string): number {
	return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
}

/** Does any file live anywhere beneath this folder? */
function hasFileBeneath(dir: DirNode): boolean {
	if (dir.files.length > 0) return true;
	for (const child of dir.children.values()) {
		if (hasFileBeneath(child)) return true;
	}
	return false;
}

export interface BuildPathTreeOptions {
	/** Folder prefixes whose subtree is hidden. */
	collapsed?: ReadonlySet<string>;
	/** UI-only folders with no file in them yet (the "New folder" case). They
	 *  exist in local state alone — there is no folder entity to create. */
	extraFolders?: readonly string[];
}

/**
 * Derive the folder tree from `entries`' path prefixes and flatten it to the
 * preorder array of VISIBLE nodes (a collapsed folder's subtree is omitted),
 * so the array order === the on-screen row order — the contract
 * `useTreeKeyboard` relies on to map ArrowUp/Down to the next visible row.
 *
 * Ordering per level: folders before files, then case-insensitive by name.
 */
export function buildPathTree(
	entries: readonly PathTreeEntry[],
	options: BuildPathTreeOptions = {},
): PathTreeNode[] {
	const collapsed = options.collapsed ?? new Set<string>();
	const root = makeDir("", "");
	for (const entry of entries) {
		const segments = pathSegments(entry.path);
		const name = segments.pop();
		if (name === undefined) continue;
		ensureDir(root, segments).files.push(entry);
	}
	for (const folder of options.extraFolders ?? []) {
		const segments = pathSegments(folder);
		if (segments.length > 0) ensureDir(root, segments);
	}

	const out: PathTreeNode[] = [];
	const walk = (dir: DirNode, level: number, parentId: string | null): void => {
		const childDirs = [...dir.children.values()].sort((a, b) => compareNames(a.name, b.name));
		for (const child of childDirs) {
			const id = folderNodeId(child.path);
			const expanded = !collapsed.has(child.path);
			const hasChildren = child.children.size > 0 || child.files.length > 0;
			out.push({
				id,
				kind: PathNodeKind.Folder,
				path: child.path,
				name: child.name,
				level,
				parentId,
				expanded,
				hasChildren,
				fileId: null,
				empty: !hasFileBeneath(child),
			});
			if (expanded) walk(child, level + 1, id);
		}
		const files = [...dir.files].sort((a, b) => compareNames(baseOf(a.path), baseOf(b.path)));
		for (const file of files) {
			out.push({
				id: file.id,
				kind: PathNodeKind.File,
				path: file.path,
				name: baseOf(file.path),
				level,
				parentId,
				expanded: false,
				hasChildren: false,
				fileId: file.id,
				empty: false,
			});
		}
	};
	walk(root, 0, null);
	return out;
}

/** Every folder prefix implied by `paths` (each file's ancestor chain). */
export function foldersOf(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const path of paths) {
		for (const folder of ancestorFolders(path)) seen.add(folder);
	}
	return [...seen];
}
