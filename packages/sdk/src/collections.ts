/**
 * Pure Collection membership resolver (9.3.5.1). The canonical
 * implementation of `effective(L) = (source ∪ include) \ exclude` from
 * , shared so every
 * downstream rung (per-app store migration, multi-membership UX, the
 * entities-service `list`-scoped effective-schema composition) computes
 * membership identically.
 *
 * Source resolution itself (running the `ListSource` query against the
 * entities store) stays on the entities-service / app side — this is the
 * dependency-free override-application half, mirroring how
 * `validatePropertyDef` is the pure half of the property contract.
 */

import {
	MEMBERS_HARD_CAP,
	type MemberExclude,
	type MemberInclude,
	type MemberOverrideSource,
	type MemberOverrides,
} from "@brainstorm-os/sdk-types";

/** Minimal structural override shape — `MemberOverrides` from
 *  `@brainstorm-os/sdk-types` satisfies it, and so does the lighter
 *  `{ entityId }[]` form callers already hold; only `entityId` is read. */
export type MemberRefs = {
	include: ReadonlyArray<{ entityId: string }>;
	exclude: ReadonlyArray<{ entityId: string }>;
};

/**
 * Apply a Collection's manual overrides to its source-resolved member
 * set. `include` is unioned in (covers a member the source query misses
 * or a Manual/`null`-source collection); `exclude` is removed last so an
 * explicit exclude always wins over both the source and an include of
 * the same id.
 */
export function effectiveMembers(resolved: Iterable<string>, members: MemberRefs): Set<string> {
	const out = new Set(resolved);
	for (const m of members.include) out.add(m.entityId);
	for (const m of members.exclude) out.delete(m.entityId);
	return out;
}

/* ── Membership mutation (one intent → minimum override write) ─────────────
 * Promoted from `apps/database/src/logic/members.ts` (9.3.5.V 7c) so the
 * shell `collections` host service and the Database app share one algorithm.
 * `matchesSource` is a caller-supplied predicate ("does the List's source
 * already match this entity?"), so the same code serves the source-aware
 * Database inspector and the manual-only cross-app surface (which passes
 * `matchesSource: false` — it toggles only the explicit `include` layer).
 * Spec: §Operations on a List.
 */

export enum AddOutcome {
	NoOp = "no-op",
	UnExcluded = "un-excluded",
	Included = "included",
}

export enum RemoveOutcome {
	NoOp = "no-op",
	UnIncluded = "un-included",
	Excluded = "excluded",
}

export type AddResult = { members: MemberOverrides; outcome: AddOutcome };
export type RemoveResult = { members: MemberOverrides; outcome: RemoveOutcome };

export type MutationContext = {
	/** Whether the List's source — if any — already matches the target
	 *  entity. The algorithm never runs a query itself; the caller computes
	 *  this (or passes `false` for a manual-only toggle). */
	matchesSource: boolean;
	/** Who initiated the change — for the audit record. */
	by: MemberOverrideSource;
	/** Optional free-text reason persisted with the record. */
	reason?: string;
	/** Override the clock for deterministic tests. Defaults to `Date.now()`. */
	now?: number;
};

export class MembersCapacityError extends Error {
	constructor() {
		super(`members.include + members.exclude would exceed the ${MEMBERS_HARD_CAP}-entry hard cap`);
		this.name = "MembersCapacityError";
	}
}

function hasInclude(members: MemberRefs, entityId: string): boolean {
	return members.include.some((m) => m.entityId === entityId);
}

function hasExclude(members: MemberRefs, entityId: string): boolean {
	return members.exclude.some((m) => m.entityId === entityId);
}

function clockOf(ctx: MutationContext): number {
	return typeof ctx.now === "number" ? ctx.now : Date.now();
}

/**
 * Add an entity to a List's effective membership.
 *
 *   1. If e ∈ exclude, drop it.
 *   2. If after step 1 e is still not effective — !matchesSource AND
 *      e ∉ include — append to include.
 *
 *   outcome = Included if step 2 ran · UnExcluded if only step 1 ran · NoOp.
 */
export function addToList(
	members: MemberOverrides,
	entityId: string,
	ctx: MutationContext,
): AddResult {
	const wasInExclude = hasExclude(members, entityId);
	const wasInInclude = hasInclude(members, entityId);

	let nextExclude = members.exclude;
	if (wasInExclude) {
		nextExclude = members.exclude.filter((m) => m.entityId !== entityId);
	}

	let nextInclude = members.include;
	let appendedInclude = false;
	if (!ctx.matchesSource && !wasInInclude) {
		if (members.include.length + nextExclude.length >= MEMBERS_HARD_CAP) {
			throw new MembersCapacityError();
		}
		const record: MemberInclude = {
			entityId,
			addedAt: clockOf(ctx),
			by: ctx.by,
			...(ctx.reason !== undefined ? { reason: ctx.reason } : {}),
		};
		nextInclude = [...members.include, record];
		appendedInclude = true;
	}

	if (!wasInExclude && !appendedInclude) {
		return { members, outcome: AddOutcome.NoOp };
	}

	return {
		members: { include: nextInclude, exclude: nextExclude },
		outcome: appendedInclude ? AddOutcome.Included : AddOutcome.UnExcluded,
	};
}

/**
 * Remove an entity from a List's effective membership. Symmetric to
 * `addToList`:
 *
 *   1. If e ∈ include, drop it.
 *   2. If after step 1 e is still effective — matchesSource AND e ∉ exclude
 *      — append to exclude.
 *
 *   outcome = Excluded if step 2 ran · UnIncluded if only step 1 ran · NoOp.
 */
export function removeFromList(
	members: MemberOverrides,
	entityId: string,
	ctx: MutationContext,
): RemoveResult {
	const wasInInclude = hasInclude(members, entityId);
	const wasInExclude = hasExclude(members, entityId);

	let nextInclude = members.include;
	if (wasInInclude) {
		nextInclude = members.include.filter((m) => m.entityId !== entityId);
	}

	let nextExclude = members.exclude;
	let appendedExclude = false;
	if (ctx.matchesSource && !wasInExclude) {
		if (nextInclude.length + members.exclude.length >= MEMBERS_HARD_CAP) {
			throw new MembersCapacityError();
		}
		const record: MemberExclude = {
			entityId,
			removedAt: clockOf(ctx),
			by: ctx.by,
			...(ctx.reason !== undefined ? { reason: ctx.reason } : {}),
		};
		nextExclude = [...members.exclude, record];
		appendedExclude = true;
	}

	if (!wasInInclude && !appendedExclude) {
		return { members, outcome: RemoveOutcome.NoOp };
	}

	return {
		members: { include: nextInclude, exclude: nextExclude },
		outcome: appendedExclude ? RemoveOutcome.Excluded : RemoveOutcome.UnIncluded,
	};
}
