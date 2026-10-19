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
import { isListLocked } from "./list-lock";
import { MembersCapacityError, addToList } from "./members";

export function sourceShowsFiles(list: List): boolean {
	const source = list.source;
	return source?.kind === ListSourceKind.ByType && source.types.includes(FILE_ENTITY_TYPE);
}

export function acceptsFileDrop(list: List | null | undefined, isVaultDerived: boolean): boolean {
	if (!list || isListLocked(list)) return false;
	return !isVaultDerived || sourceShowsFiles(list);
}

export type DroppedFilesMembers = {
	/** The new members, or `null` when nothing changed. */
	members: MemberOverrides | null;
	/** Files created but not pinned because the list hit the members cap. */
	overCapacity: number;
};

/** The list's members with every new file pinned (none when the source
 *  already shows files, or for a vault-derived list). Pass the list as it
 *  is AFTER the import — membership may have moved while files uploaded. */
export function membersWithDroppedFiles(
	list: List,
	isVaultDerived: boolean,
	fileIds: ReadonlyArray<string>,
	now: number = Date.now(),
): DroppedFilesMembers {
	if (isVaultDerived || isListLocked(list) || fileIds.length === 0)
		return { members: null, overCapacity: 0 };
	const matchesSource = sourceShowsFiles(list);
	let members = list.members;
	let overCapacity = 0;
	for (const id of fileIds) {
		try {
			members = addToList(members, id, { matchesSource, by: "user", now }).members;
		} catch (error) {
			if (!(error instanceof MembersCapacityError)) throw error;
			overCapacity += 1;
		}
	}
	return { members: members === list.members ? null : members, overCapacity };
}
