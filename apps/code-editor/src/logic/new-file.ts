/**
 * New-file naming (9.7.5). Picks a collision-free `untitled*.ts` path
 * against the existing files so the in-app "New file" action never clobbers
 * one. Pure (no DOM / no service); the app wires the create call.
 */

import { sanitizeInlineText } from "@brainstorm-os/sdk/sanitize-text";
import {
	type PathTreeEntry,
	ancestorFolders,
	baseOf,
	dirOf,
	isUnder,
	joinPath,
	pathSegments,
	rewritePathPrefix,
} from "./path-tree";

const BASE = "untitled";
const EXT = "ts";
const FOLDER_BASE = "new-folder";

/** Upper bound on a rename label. The typed name flows into the sidebar row
 *  and the window title, so an unbounded paste (or one carrying control /
 *  bidi-override / zero-width spoofing characters) is clamped + stripped
 *  before it reaches that chrome — `sanitizeInlineText` does both. */
const MAX_RENAME_LENGTH = 200;

/** First `<folder>/<base>[-N]<suffix>` not already taken (case-insensitive). */
function firstFreePath(
	base: string,
	suffix: string,
	folder: string,
	taken: ReadonlySet<string>,
): string {
	for (let n = 1; n < 10_000; n++) {
		const candidate = joinPath(folder, n === 1 ? `${base}${suffix}` : `${base}-${n}${suffix}`);
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
	// Pathological fallback — effectively unreachable.
	return joinPath(folder, `${base}-${taken.size + 1}${suffix}`);
}

/** A path not already taken: `untitled.ts`, then `untitled-2.ts`, … `folder`
 *  scopes the new file to a folder prefix (`""` = the root), so "New file"
 *  with a folder selected lands inside it rather than always at the top. */
export function nextUntitledPath(existingPaths: readonly string[], folder = ""): string {
	return firstFreePath(BASE, `.${EXT}`, folder, new Set(existingPaths.map((p) => p.toLowerCase())));
}

/** A folder path not already taken inside `folder`: `new-folder`, then
 *  `new-folder-2`, … `existingFolders` is every folder prefix that already
 *  exists (derived from the file paths + the pending set). */
export function nextFolderPath(existingFolders: readonly string[], folder = ""): string {
	return firstFreePath(
		FOLDER_BASE,
		"",
		folder,
		new Set(existingFolders.map((f) => f.toLowerCase())),
	);
}

/** Why a proposed rename was rejected (F-238). The app maps each to a
 *  localised message; centralised so the literal isn't re-typed. */
export enum RenameError {
	Empty = "empty",
	Duplicate = "duplicate",
	/** A folder operation whose descendants include a read-only-locked file.
	 *  The lock fleet rule: EVERY write path is gated, not just the editor —
	 *  a folder rename is N file writes, so one locked descendant refuses the
	 *  whole (atomic-from-the-user's-view) action. */
	Locked = "locked",
	/** A folder can't be moved/renamed into its own subtree. */
	Cycle = "cycle",
}

export type RenameResult = { ok: true; path: string } | { ok: false; reason: RenameError };

/** Validate a user-typed rename for the file at `currentPath` against the
 *  other files' `existingPaths`. Pure (no DOM / no service): trims, rejects
 *  an empty name, and rejects a case-insensitive collision with a DIFFERENT
 *  file (renaming to the same path, or to a different-cased spelling of the
 *  current one, is allowed). */
export function validateRenamePath(
	input: string,
	currentPath: string,
	existingPaths: readonly string[],
): RenameResult {
	const path = sanitizeInlineText(input, MAX_RENAME_LENGTH);
	if (path.length === 0) return { ok: false, reason: RenameError.Empty };
	const lower = path.toLowerCase();
	const collides = existingPaths.some((p) => p !== currentPath && p.toLowerCase() === lower);
	if (collides) return { ok: false, reason: RenameError.Duplicate };
	return { ok: true, path };
}

/** One file's path change inside a folder-level operation. */
export interface PathMove {
	id: string;
	from: string;
	to: string;
}

export type FolderPlan =
	| { ok: true; path: string; moves: PathMove[] }
	| { ok: false; reason: RenameError };

/** A file, plus whether its read-only lock is engaged — the input a folder
 *  operation needs to refuse touching a locked descendant. */
export interface FolderPlanFile extends PathTreeEntry {
	locked: boolean;
}

/** Plan a folder rewrite from `currentPath` to the sanitized `nextPath`: the
 *  per-file path moves plus every collision / lock / cycle guard, computed
 *  BEFORE any write so the app either performs the whole rewrite or none of
 *  it. Shared by the folder rename popover and drag-to-move (a move is a
 *  rename to a different parent).
 *
 *  `pendingFolders` are the UI-only empty folders; a rewrite that would land
 *  on one of them is a duplicate just as much as one landing on a real
 *  folder — otherwise two rows would claim the same prefix. */
function planFolderRewrite(
	nextPath: string,
	currentPath: string,
	files: readonly FolderPlanFile[],
	pendingFolders: readonly string[],
): FolderPlan {
	if (pathSegments(nextPath).length === 0) return { ok: false, reason: RenameError.Empty };
	const path = pathSegments(nextPath).join("/");
	if (path.toLowerCase() === currentPath.toLowerCase()) return { ok: true, path, moves: [] };
	if (isUnder(path, currentPath)) return { ok: false, reason: RenameError.Cycle };

	const inside = files.filter((file) => isUnder(file.path, currentPath));
	if (inside.some((file) => file.locked)) return { ok: false, reason: RenameError.Locked };

	// Collisions are judged against everything that STAYS put — the outside
	// files and the pending folders that aren't part of this rewrite.
	const outside = files.filter((file) => !isUnder(file.path, currentPath));
	const takenPaths = new Set(outside.map((file) => file.path.toLowerCase()));
	const takenFolders = new Set(
		[
			...outside.flatMap((file) => ancestorFolders(file.path)),
			...pendingFolders.filter((folder) => !isUnder(folder, currentPath)),
		]
			.filter((folder) => folder.toLowerCase() !== currentPath.toLowerCase())
			.map((folder) => folder.toLowerCase()),
	);
	if (takenFolders.has(path.toLowerCase())) return { ok: false, reason: RenameError.Duplicate };

	const moves: PathMove[] = [];
	for (const file of inside) {
		const to = rewritePathPrefix(file.path, currentPath, path);
		if (takenPaths.has(to.toLowerCase())) return { ok: false, reason: RenameError.Duplicate };
		if (to !== file.path) moves.push({ id: file.id, from: file.path, to });
	}
	return { ok: true, path, moves };
}

/** Validate + plan a user-typed folder rename. The input is the folder's FULL
 *  path (same affordance as a file rename), sanitized on the way in. */
export function planFolderRename(
	input: string,
	currentPath: string,
	files: readonly FolderPlanFile[],
	pendingFolders: readonly string[] = [],
): FolderPlan {
	const typed = sanitizeInlineText(input, MAX_RENAME_LENGTH);
	return planFolderRewrite(typed, currentPath, files, pendingFolders);
}

/** Plan moving `folderPath` into `destFolder` (`""` = the root) — a rename
 *  that keeps the folder's own name and swaps its parent. */
export function planFolderMove(
	folderPath: string,
	destFolder: string,
	files: readonly FolderPlanFile[],
	pendingFolders: readonly string[] = [],
): FolderPlan {
	return planFolderRewrite(
		joinPath(destFolder, baseOf(folderPath)),
		folderPath,
		files,
		pendingFolders,
	);
}

/** Plan moving one FILE into `destFolder` (`""` = the root) — the drag-to-move
 *  path, which is `applyRename` with a new prefix. Returns `null` when the file
 *  is already there (a no-op drop). */
export function planFileMove(
	file: FolderPlanFile,
	destFolder: string,
	files: readonly FolderPlanFile[],
): FolderPlan | null {
	if (file.locked) return { ok: false, reason: RenameError.Locked };
	if (dirOf(file.path).toLowerCase() === destFolder.toLowerCase()) return null;
	const to = joinPath(destFolder, baseOf(file.path));
	const result = validateRenamePath(
		to,
		file.path,
		files.map((f) => f.path),
	);
	if (!result.ok) return { ok: false, reason: result.reason };
	return { ok: true, path: result.path, moves: [{ id: file.id, from: file.path, to: result.path }] };
}
