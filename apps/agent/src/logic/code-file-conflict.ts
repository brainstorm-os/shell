/**
 * POLISH-FN-4 — a proposed code file whose `path` is ALREADY TAKEN.
 *
 * `brainstorm/CodeFile/v1` has no uniqueness constraint on `path`: the vault
 * will happily hold two rows spelling the same filename. Approving a
 * `propose-code-file` card used to be exactly one `entities.create`, so
 * re-approving the same draft (or approving a redraft of a file the agent
 * already wrote) minted a SECOND file at that path — the Code editor listed
 * both, and `apps:list-vault-app-sources` counted both, which is how a six-file
 * app came to report "8 files".
 *
 * The product decision is that neither a silent overwrite nor a silent rename
 * is acceptable: the tray exists so the USER decides. So this module is the
 * detection half — the card asks it whether the drafted path is taken and, if
 * it is, offers the two named outcomes ({@link CodeFileConflictChoice}). The
 * persist step (`propose-persist.ts`) re-runs the same check and REFUSES a
 * create when a conflict exists and no choice was made, so the invariant
 * ("never two entities at one path") holds even if the UI is bypassed or the
 * snapshot raced.
 *
 * Paths are compared case-INSENSITIVELY, matching the Code editor's own
 * `validateRenamePath` and the installer's `resolveBundleLayout`: macOS and
 * Windows filesystems fold case, so `Manifest.json` and `manifest.json` are one
 * file the moment an app is installed from them.
 *
 * Pure — no DOM, no service, no React.
 */

import { firstFreeName, splitFileSuffix } from "@brainstorm-os/sdk/path-names";
import { CODE_FILE_ENTITY_TYPE } from "./propose-code-file";

/** What the user chose to do about a path that is already taken. There is no
 *  "create anyway" member on purpose — that is the bug this enum exists to
 *  make unrepresentable. */
export enum CodeFileConflictChoice {
	/** Write the draft's content into the file that is already there. */
	Update = "update",
	/** Keep both: create at the next free path (`manifest-2.json`). */
	SaveCopy = "save-copy",
}

/** The minimum the conflict check needs about a code file that already exists:
 *  its entity id (the Update target) and its path (what is displayed). */
export type CodeFilePathRow = {
	id: string;
	path: string;
};

/** The shape of a live vault snapshot row this module reads. */
type SnapshotRow = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
};

const PATH_SEPARATOR = "/";

/** The comparison key for a vault path: trimmed + case-folded. */
export function codeFilePathKey(path: string): string {
	return path.trim().toLowerCase();
}

/** Every `CodeFile/v1` in a live vault snapshot, as `{id, path}`. Soft-deleted
 *  rows never reach the snapshot (the entities repo filters `deleted_at IS
 *  NULL`), so a path whose file was deleted is free again — deliberately: a
 *  tombstone must not block a legitimate create. */
export function codeFilePathsFrom(entities: readonly SnapshotRow[]): CodeFilePathRow[] {
	const rows: CodeFilePathRow[] = [];
	for (const entity of entities) {
		if (entity.type !== CODE_FILE_ENTITY_TYPE) continue;
		const path = entity.properties.path;
		if (typeof path !== "string" || path.trim().length === 0) continue;
		rows.push({ id: entity.id, path });
	}
	return rows;
}

/** The file already occupying `path`, or null. Case-insensitive; an empty /
 *  whitespace-only path never conflicts (the card's approve is disabled on it
 *  anyway). */
export function findCodeFilePathConflict(
	existing: readonly CodeFilePathRow[],
	path: string,
): CodeFilePathRow | null {
	const key = codeFilePathKey(path);
	if (key.length === 0) return null;
	return existing.find((row) => codeFilePathKey(row.path) === key) ?? null;
}

/** The next free spelling of `path`, keeping its folder and extension:
 *  `hello-app/manifest.json` → `hello-app/manifest-2.json`. Mirrors the Code
 *  editor's `nextUntitledPath` (both walk `firstFreeName`), so "Save a copy"
 *  in the tray and "New file" in the editor name collisions identically. */
export function nextFreeCodeFilePath(existing: readonly CodeFilePathRow[], path: string): string {
	const trimmed = path.trim();
	const cut = trimmed.lastIndexOf(PATH_SEPARATOR);
	const dir = cut === -1 ? "" : trimmed.slice(0, cut + 1);
	const { base, suffix } = splitFileSuffix(trimmed.slice(cut + 1));
	const taken = new Set(existing.map((row) => codeFilePathKey(row.path)));
	return dir + firstFreeName(base, suffix, (name) => taken.has(codeFilePathKey(dir + name)));
}

/**
 * Claim `path` for an approve that is ABOUT to run — `false` when another
 * approve already holds it, which the caller must treat as a conflict rather
 * than a create.
 *
 * This is the narrowest of the three windows POLISH-FN-4 has to close, and the
 * only one nothing else covers: two cards at one path, the second approved
 * before the first `entities.create` has resolved. The live snapshot cannot
 * have caught up, and neither has the session list (it is appended only once
 * the write lands), so the paths in flight are the sole record that the second
 * card's path is already spoken for. Synchronous by construction — the app
 * holds the set in a ref, because a claim that becomes visible a render later
 * is a claim that arrives too late.
 */
export function claimCodeFilePath(inFlight: Set<string>, path: string): boolean {
	const key = codeFilePathKey(path);
	if (inFlight.has(key)) return false;
	inFlight.add(key);
	return true;
}

/** Drop the claim, whatever the approval's outcome was. */
export function releaseCodeFilePath(inFlight: Set<string>, path: string): void {
	inFlight.delete(codeFilePathKey(path));
}

/** Union of the vault's code files and the ones persisted during this session,
 *  de-duplicated by path key (the vault row wins — it is the settled truth).
 *  The session half closes the window where a file has been created but the
 *  live snapshot has not round-tripped yet: without it, approving two cards at
 *  one path in quick succession creates two rows, which is the exact defect. */
export function mergeCodeFilePaths(
	vault: readonly CodeFilePathRow[],
	session: readonly CodeFilePathRow[],
): CodeFilePathRow[] {
	const merged = [...vault];
	const seen = new Set(vault.map((row) => codeFilePathKey(row.path)));
	for (const row of session) {
		const key = codeFilePathKey(row.path);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(row);
	}
	return merged;
}
