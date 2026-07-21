/**
 * Drop-semantic vocabulary + defaults (DND-4, §Part III "the
 * meaning matrix"). What a dropped object BECOMES is the target's decision; this
 * module centralises the shared vocabulary (so it's an enum, not raw strings —
 * per CLAUDE.md), maps each semantic to its cursor affordance, and picks the
 * least-destructive default when a target accepts several. App-specific
 * performance (the actual membership write / property set / move) stays in the
 * app's `useDropTarget` `onDrop`; this is only the shared decision layer.
 */

import { DropEffect } from "@brainstorm-os/sdk-types";

/** What a dropped object becomes at a target (design §Part III). */
export enum DropSemantic {
	/** Inline mention / `brainstorm://` link — no mutation of either side. */
	Reference = "reference",
	/** Live embedded card/block — no mutation. */
	Transclude = "transclude",
	/** Manual `members.include` override on a collection/view/column — no entity
	 *  mutation; the container gains a member. */
	AddMembership = "add-membership",
	/** Write a relation/date/status by dropping onto a slot — mutates the target's
	 *  field (or the dropped item's). */
	SetProperty = "set-property",
	/** Remove from the source container, add to the target — mutates both. */
	Move = "move",
	/** Create a new entity from the dropped one. */
	Copy = "copy",
	/** Combine N dropped objects into a new one. */
	Compose = "compose",
}

/** The cursor affordance a semantic shows during hover. Reference/transclude/
 *  membership/property are non-destructive → `Link`; move → `Move`; the
 *  create-new semantics → `Copy`. */
const SEMANTIC_EFFECT: Record<DropSemantic, DropEffect> = {
	[DropSemantic.Reference]: DropEffect.Link,
	[DropSemantic.Transclude]: DropEffect.Link,
	[DropSemantic.AddMembership]: DropEffect.Link,
	[DropSemantic.SetProperty]: DropEffect.Link,
	[DropSemantic.Move]: DropEffect.Move,
	[DropSemantic.Copy]: DropEffect.Copy,
	[DropSemantic.Compose]: DropEffect.Copy,
};

/** Map a drop semantic to the `DropEffect` cursor affordance (for a target's
 *  `dropEffectFor`). */
export function effectForSemantic(semantic: DropSemantic): DropEffect {
	return SEMANTIC_EFFECT[semantic];
}

/** Least→most destructive order (design "Decision: default = the least-
 *  destructive semantic the target supports"): the non-mutating reference family
 *  first, then a target-field write, then a both-sides move; the create-new
 *  semantics last so neither is ever the silent default ("never copy-by-default";
 *  a move/compose/copy default is an explicit per-target choice, not picked here). */
const DESTRUCTIVENESS: readonly DropSemantic[] = [
	DropSemantic.Reference,
	DropSemantic.Transclude,
	DropSemantic.AddMembership,
	DropSemantic.SetProperty,
	DropSemantic.Move,
	DropSemantic.Compose,
	DropSemantic.Copy,
];

/** The least-destructive semantic among those a target accepts, or `null` for an
 *  empty set. Use when a target supports several and wants the safe default. */
export function leastDestructive(accepted: readonly DropSemantic[]): DropSemantic | null {
	const set = new Set(accepted);
	for (const semantic of DESTRUCTIVENESS) {
		if (set.has(semantic)) return semantic;
	}
	return null;
}
