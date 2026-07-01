/**
 * List-scoped property resolution — the pure half of the "adding an object to
 * a collection makes it inherit that collection's properties" mechanism
 * (`Scope = { kind: "list", target }`, sdk-types/properties.ts; resolves the
 * open question OQ-LD-2 with the positions documented here).
 *
 * Given an entity, the Lists it could belong to, and the vault property
 * catalog, this returns the **overlay** PropertyDefs the entity inherits from
 * the collections it is a member of — e.g. a book added to "Horror" inherits
 * every property scoped to the Horror list. The inspector then renders these
 * alongside the entity's own properties; editing one writes the value to the
 * entity's own property bag (so the value is HELD if it later leaves the list —
 * leaving a collection is not destructive, per OQ-LD-2).
 *
 * Positions taken (OQ-LD-2):
 *  - **Membership**: manual membership only here (`include` − `exclude`, via
 *    the shared `effectiveMembers`). Query-sourced (ByType/ByFilter) overlays
 *    need the resolved member set, computed app-side; callers that have it can
 *    extend `lists[].members.include` with the resolved ids before calling.
 *  - **Precedence / collisions**: when two collections scope the same property
 *    key, the lists are visited in stable id order and the first wins — one
 *    row per key. (Entity-own > list, per the global precedence, is applied by
 *    the caller, which lists own keys before these overlays.)
 *
 * Pure + dependency-free (over `collections.effectiveMembers`) so it unit-tests
 * in isolation, mirroring `validatePropertyDef` / `effectiveMembers`.
 */

import type { PropertyDef } from "@brainstorm/sdk-types";
import { type MemberRefs, effectiveMembers } from "./collections";

/** The minimal List shape the resolver reads. The app's full List entity
 *  satisfies it; `members` carries the manual override layers. */
export type ScopedList = { id: string; members: MemberRefs };

/** The List ids whose MANUAL membership (include − exclude) contains the
 *  entity, in stable id order. Query-sourced membership is resolved app-side;
 *  a caller with the resolved set folds it into `members.include` first. */
export function listsContainingEntity(
	entityId: string,
	lists: ReadonlyArray<ScopedList>,
): string[] {
	return lists
		.filter((list) => effectiveMembers([], list.members).has(entityId))
		.map((list) => list.id)
		.sort();
}

/** The overlay PropertyDefs an entity inherits from its collections: for every
 *  List it belongs to, each catalog def scoped `{ kind: "list", target: id }`.
 *  Deduped by key (first list in id order wins on a collision). Empty when the
 *  entity is in no scoping collection. */
export function inheritedPropertyDefs(
	entityId: string,
	lists: ReadonlyArray<ScopedList>,
	catalog: ReadonlyArray<PropertyDef> | Readonly<Record<string, PropertyDef>>,
): PropertyDef[] {
	const memberLists = listsContainingEntity(entityId, lists);
	if (memberLists.length === 0) return [];
	const memberSet = new Set(memberLists);

	const defs = Array.isArray(catalog) ? catalog : Object.values(catalog);
	const byList = new Map<string, PropertyDef[]>();
	for (const def of defs) {
		const scope = def.scope;
		if (scope?.kind === "list" && memberSet.has(scope.target)) {
			const bucket = byList.get(scope.target);
			if (bucket) bucket.push(def);
			else byList.set(scope.target, [def]);
		}
	}

	const seen = new Set<string>();
	const out: PropertyDef[] = [];
	for (const listId of memberLists) {
		for (const def of byList.get(listId) ?? []) {
			if (seen.has(def.key)) continue;
			seen.add(def.key);
			out.push(def);
		}
	}
	return out;
}
