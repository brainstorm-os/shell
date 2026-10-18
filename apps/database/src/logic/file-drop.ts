/**
 * OS files dropped on a Database view (9.8.17, Database half). The SDK
 * imports each file as a `File/v1` object; this decides whether the active
 * collection accepts the drop and pins the new files into its members.
 *
 * A vault-derived list is regenerated from the vault, so it has no editable
 * members: it accepts a drop only when its own source already shows files
 * (the "Files" type list). Any user collection accepts, pinning each new file
 * unless its type source already matches.
 */

import { FILE_ENTITY_TYPE } from "@brainstorm-os/sdk/os-file-drop";
import { type List, ListSourceKind, type MemberOverrides } from "../types";
import { addToList } from "./members";

export function sourceShowsFiles(list: List): boolean {
	const source = list.source;
	return source?.kind === ListSourceKind.ByType && source.types.includes(FILE_ENTITY_TYPE);
}

export function acceptsFileDrop(list: List | null | undefined, isVaultDerived: boolean): boolean {
	if (!list) return false;
	return !isVaultDerived || sourceShowsFiles(list);
}

/** The list's members with every new file pinned (none when the source
 *  already shows files, or for a vault-derived list). */
export function membersWithDroppedFiles(
	list: List,
	isVaultDerived: boolean,
	fileIds: ReadonlyArray<string>,
	now: number = Date.now(),
): MemberOverrides | null {
	if (isVaultDerived || fileIds.length === 0) return null;
	const matchesSource = sourceShowsFiles(list);
	let members = list.members;
	for (const id of fileIds) {
		members = addToList(members, id, { matchesSource, by: "user", now }).members;
	}
	return members === list.members ? null : members;
}
