/**
 * Sidebar grouping for system (infrastructure) type-lists — F-212.
 *
 * The vault-derived sidebar auto-mints one type-list per entity type the
 * vault contains, which lets product plumbing (BrowsingHistories,
 * ListViews, Triggers, Workflows…) read exactly like the user's own
 * collections. The classification itself lives in
 * `@brainstorm/sdk/system-entities`; this module is the pure row model:
 * user lists keep their order on top, system type-lists drop under a
 * collapsed "System" disclosure header rendered below them. User-created
 * collections are NEVER classified system — only vault-derived `ByType`
 * lists whose every source type is infrastructure.
 */

import { isPlumbingEntityType } from "@brainstorm/sdk/system-entities";
import type { List } from "../types/list";
import { ListSourceKind } from "../types/list-source";

export enum SidebarRowKind {
	List = "list",
	SystemHeader = "system-header",
}

export type SidebarNavRow =
	| { kind: SidebarRowKind.List; list: List }
	| { kind: SidebarRowKind.SystemHeader; count: number; open: boolean };

/** A vault-derived type-list whose every source type reads as plumbing —
 *  infrastructure or parent-scoped child content (Messages, Comments —
 *  F-318) — next to the user's own collections, so it drops under the
 *  System disclosure. Grouping only — the lists stay fully browsable. Same
 *  shared predicate the Graph SHOW filter partitions on. */
export function isSystemList(list: List, isVaultDerived: (id: string) => boolean): boolean {
	if (!isVaultDerived(list.id)) return false;
	const source = list.source;
	if (!source || source.kind !== ListSourceKind.ByType) return false;
	if (source.types.length === 0) return false;
	return source.types.every(isPlumbingEntityType);
}

export function partitionSidebarLists(
	lists: ReadonlyArray<List>,
	isVaultDerived: (id: string) => boolean,
): { user: List[]; system: List[] } {
	const user: List[] = [];
	const system: List[] = [];
	for (const list of lists) {
		(isSystemList(list, isVaultDerived) ? system : user).push(list);
	}
	return { user, system };
}

/** The sidebar's render rows: user lists, then — only when system lists
 *  exist — the disclosure header, then (open only) the system lists. */
export function sidebarNavRows(
	lists: ReadonlyArray<List>,
	options: { systemOpen: boolean; isVaultDerived: (id: string) => boolean },
): SidebarNavRow[] {
	const { user, system } = partitionSidebarLists(lists, options.isVaultDerived);
	const rows: SidebarNavRow[] = user.map((list) => ({ kind: SidebarRowKind.List, list }));
	if (system.length === 0) return rows;
	rows.push({
		kind: SidebarRowKind.SystemHeader,
		count: system.length,
		open: options.systemOpen,
	});
	if (options.systemOpen) {
		for (const list of system) rows.push({ kind: SidebarRowKind.List, list });
	}
	return rows;
}
