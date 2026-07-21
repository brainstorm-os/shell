/**
 * Collection contract (9.3.5.1) — the cross-app, dependency-free core of
 * the single-object-space / collections model
 * (21-objects-and-collections.md).
 *
 * A **Collection** is `brainstorm/List/v1` promoted product-wide: a
 * schema-bearing, membership-defining, view-owning object. This file owns
 * only the pieces that are genuinely shared and free of app-local deps —
 * the membership sub-contract + the derived-mode enum. The full
 * `Collection` / `ListSource` / `ListView` shapes still live app-side
 * because they reference an app-local `Icon` / `PropertyPredicate`;
 * promoting those is 9.3.5.1b (needs the Icon/Predicate reconciliation).
 */

/** Stable Block-Protocol type id for a Collection. Unchanged on disk. */
export const COLLECTION_TYPE_URL = "brainstorm/List/v1" as const;

/** Who recorded a manual membership override — for the audit record. */
export type MemberOverrideSource = "user" | `app:${string}`;

export type MemberInclude = {
	entityId: string;
	addedAt: number;
	by: MemberOverrideSource;
	reason?: string;
};

export type MemberExclude = {
	entityId: string;
	removedAt: number;
	by: MemberOverrideSource;
	reason?: string;
};

/** Manual overrides layered on a Collection's dynamic `source`.
 *  `effective = (source ∪ include) \ exclude` (see `effectiveMembers`
 *  in `@brainstorm-os/sdk`). */
export type MemberOverrides = {
	include: MemberInclude[];
	exclude: MemberExclude[];
};

/** Hard cap on `members.include.length + members.exclude.length` per
 *  Collection. See §The `members`
 *  overrides. */
export const MEMBERS_HARD_CAP = 5000 as const;

/** Derived UX label for a Collection's shape — never stored; a function
 *  of `source` + `members`. See
 *  §The three modes. */
export enum ListMode {
	Query = "query",
	Manual = "manual",
	Hybrid = "hybrid",
}
