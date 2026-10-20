/**
 * Pure decision half of `toggleEntityInList` (the inspector's ✕ / picker
 * commit). Separated from the host-side mutator so vitest can prove the
 * "given current state + intent, what's the next state and toast" rule
 * without booting the whole app. The host then does the immutable
 * state-array replacement + render + persist.
 */

import type { List } from "../types/list";
import { sourceMatches } from "./collections-for-entity";
import type { InMemoryEntities } from "./in-memory-entities";
import { isListLocked } from "./list-lock";
import {
	AddOutcome,
	type AddResult,
	RemoveOutcome,
	type RemoveResult,
	addToList,
	removeFromList,
} from "./members";

/** Describes the outcome verb the caller should put in the flashed
 *  status toast. Mirrors `AddOutcome` / `RemoveOutcome` so renaming the
 *  enums propagates here. Returned verbatim so the host can pass it to
 *  `t()` without translating an enum to a string. */
export enum ToggleVerb {
	Added = "Added",
	ReAdded = "Re-added",
	Excluded = "Excluded",
	Removed = "Removed",
	NoChange = "No change",
}

export type ToggleMembershipDecision =
	| {
			/** A real mutation — replace this list in state.lists, re-render. */
			kind: "commit";
			next: List;
			verb: ToggleVerb;
	  }
	| {
			/** No state change (no-op or guard miss). The caller can skip
			 *  persistence + render. `reason` is for the host log only. */
			kind: "skip";
			reason: "no-op" | "vault-derived" | "list-not-found" | "locked";
	  };

export type ToggleMembershipInput = {
	listId: string;
	entityId: string;
	add: boolean;
	lists: ReadonlyArray<List>;
	db: InMemoryEntities;
	isVaultDerived: (listId: string) => boolean;
	now?: number;
};

/**
 * Compute the next List and the toast verb for a single toggle.
 *
 * - Returns `{kind: "skip"}` for read-only lists (vault-derived) or
 *   missing ids — the picker shouldn't have offered them in the first
 *   place, but defensive guards keep mis-fires harmless.
 * - Returns `{kind: "commit", next, verb}` otherwise, with `next.members`
 *   reflecting the minimum write `addToList` / `removeFromList` computed
 *   against `matchesSource`. `next.updatedAt` is bumped to `now`.
 */
export function decideToggleMembership(input: ToggleMembershipInput): ToggleMembershipDecision {
	const list = input.lists.find((l) => l.id === input.listId);
	if (!list) return { kind: "skip", reason: "list-not-found" };
	if (input.isVaultDerived(list.id)) return { kind: "skip", reason: "vault-derived" };
	if (isListLocked(list)) return { kind: "skip", reason: "locked" };

	const matchesSource = sourceMatches(input.entityId, list, input.db);
	const ctx = {
		matchesSource,
		by: "user" as const,
		...(input.now !== undefined ? { now: input.now } : {}),
	};

	const result: AddResult | RemoveResult = input.add
		? addToList(list.members, input.entityId, ctx)
		: removeFromList(list.members, input.entityId, ctx);

	if (result.outcome === AddOutcome.NoOp || result.outcome === RemoveOutcome.NoOp) {
		return { kind: "skip", reason: "no-op" };
	}

	const next: List = {
		...list,
		members: result.members,
		updatedAt: input.now ?? Date.now(),
	};

	return { kind: "commit", next, verb: verbFor(result.outcome) };
}

function verbFor(outcome: AddOutcome | RemoveOutcome): ToggleVerb {
	switch (outcome) {
		case AddOutcome.Included:
			return ToggleVerb.Added;
		case AddOutcome.UnExcluded:
			return ToggleVerb.ReAdded;
		case RemoveOutcome.Excluded:
			return ToggleVerb.Excluded;
		case RemoveOutcome.UnIncluded:
			return ToggleVerb.Removed;
		case AddOutcome.NoOp:
		case RemoveOutcome.NoOp:
			return ToggleVerb.NoChange;
	}
}
