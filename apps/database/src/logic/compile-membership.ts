/**
 * Compile a *saved* List into its effective membership against an in-memory
 * vault: resolve the dynamic `source` predicate set, layer the manual
 * `members.include` / `members.exclude` overrides, and hand back both the
 * effective id `Set` and a reusable `(entity) => boolean` membership
 * predicate.
 *
 * This is the single home for the `evaluateSource → applyMemberOverrides`
 * pipeline that the renderer, the member-count badge, the owning-list lookup,
 * and the filtered-entities cache all need. Before this module each of those
 * sites re-spelled `effective = (source ∪ include) \ exclude` inline (four
 * copies — past the DRY ceiling), so a future change to membership semantics
 * had four places to drift. The canonical formula lives in `@brainstorm-os/sdk`
 * (`effectiveMembers`, via `applyMemberOverrides`); this module is the
 * List-shaped front door to it.
 *
 * Long-term keystone: the same `List` shape feeds both this in-memory
 * compiler and the entities-service SQL path (Stage 9.3). A caller that
 * speaks `compileMembership` / `membershipPredicate` is substitution-ready —
 * swapping the resolver for the service is invisible to it.
 */

import type { List } from "../types/list";
import { applyMemberOverrides, evaluateSource } from "./evaluate-source";
import type { EntityRow, InMemoryEntities } from "./in-memory-entities";

/** Resolve a saved List's effective member id set:
 *  `effective = (source ∪ include) \ exclude`. A `null` source contributes
 *  no dynamic members, so the result is `include \ exclude` — the pure-Set
 *  (hand-curated) case. */
export function compileMembership(list: List, db: InMemoryEntities): Set<string> {
	const sourceIds = evaluateSource(list.source, db);
	return applyMemberOverrides(sourceIds, list.members.include, list.members.exclude);
}

/** A reusable `(entity) => boolean` membership predicate for a saved List —
 *  the in-memory entity filter a view applies before sort / group / search.
 *  Resolves the effective id set once, then closes over it so the returned
 *  predicate is O(1) per row. */
export function membershipPredicate(
	list: List,
	db: InMemoryEntities,
): (entity: EntityRow) => boolean {
	const effective = compileMembership(list, db);
	return (entity: EntityRow) => effective.has(entity.id);
}

/** Effective member count for a saved List — the badge value. Avoids
 *  materialising a predicate when only the size is wanted. */
export function memberCountOf(list: List, db: InMemoryEntities): number {
	return compileMembership(list, db).size;
}
