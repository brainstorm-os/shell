/**
 * Layout resolver (Stage 8.2) — picks the winning `brainstorm/Layout/v1`
 * for a `(entity, context)` render request by the **same layered scope
 * precedence as PropertySchema** (§Resolution):
 *
 *   entity > collection > type > user > org > app-shipped default > shell fallback
 *
 * Most-specific scope wins; ties broken by most-recent-modified; a
 * context-specific layout out-ranks an any-context (`context == null`)
 * one at the same scope. `app-default` and `shell-fallback` are NOT
 * scope-precedence entries — per the doc's algorithm they're separate
 * fallback inputs consulted only when no scoped candidate matched, so
 * **every entity renders something in every context**.
 *
 * Pure (no DOM, no dep) so the shell resolver, the form-designer
 * preview, and tests share one implementation — resolution is per
 * render (doc 27 §Resolution decision), so this never caches. The
 * `Scope` kind `list` **is** "collection" (the doc's word) — the same
 * collection-membership overlay mechanism PropertySchema uses
 * (sdk-types `Scope` comment); kept named `list` to reuse that type
 * verbatim rather than fork a parallel one.
 */

import type { LayoutContext, LayoutDef, Scope } from "@brainstorm-os/sdk-types";

export type LayoutResolveTarget = {
	entityId: string;
	/** The entity's type url(s). Multi-typed objects (collection
	 *  membership, doc 21) match a `type`-scoped layout for *any* of
	 *  their types. */
	types: readonly string[];
	/** Collection ids the entity belongs to — matched by `list`-scoped
	 *  ( == collection-scoped) layouts. */
	collectionIds?: readonly string[];
	userId?: string;
	orgId?: string;
	context: LayoutContext;
};

export type LayoutCandidate = {
	layout: LayoutDef;
	/** Most-recent-modified tiebreak when two same-scope layouts match
	 *  (doc 27 §Resolution). Absent ⇒ treated as oldest (0). */
	updatedAt?: number;
};

export type LayoutFallbacks = {
	/** App-shipped default for the entity's type + context, installed at
	 *  app-default scope on install (doc 27 §App-shipped defaults). */
	appDefault?: LayoutDef;
	/** Schema-driven generic render — the last-resort guarantee that
	 *  every entity renders something. */
	shellFallback?: LayoutDef;
};

/** Provenance of the resolved layout — lets a caller (e.g. the
 *  form-designer "revert to app default") reason about where the
 *  winner came from. Enum, not a bare literal, per convention. */
export enum LayoutResolveSource {
	Scope = "scope",
	AppDefault = "app-default",
	ShellFallback = "shell-fallback",
	None = "none",
}

export type LayoutResolution =
	| { source: LayoutResolveSource.Scope; layout: LayoutDef; scope: Scope; updatedAt: number }
	| { source: LayoutResolveSource.AppDefault; layout: LayoutDef }
	| { source: LayoutResolveSource.ShellFallback; layout: LayoutDef }
	| { source: LayoutResolveSource.None };

/** Most→least specific (doc 27 §Resolution). Lower rank wins. `list`
 *  is the doc's "collection" tier. */
const SCOPE_RANK: Record<Scope["kind"], number> = {
	entity: 0,
	list: 1,
	type: 2,
	user: 3,
	org: 4,
};

/** The precedence order as scope kinds, most→least specific — exported
 *  so callers/tests don't re-encode the chain. */
export const SCOPE_PRECEDENCE = Object.freeze([
	"entity",
	"list",
	"type",
	"user",
	"org",
]) as readonly Scope["kind"][];

/** Does this scope apply to the target entity? A scope whose discriminant
 *  dimension is absent on the target never matches (e.g. an `org` scope
 *  when the entity has no org). */
export function scopeMatches(scope: Scope, t: LayoutResolveTarget): boolean {
	switch (scope.kind) {
		case "entity":
			return scope.target === t.entityId;
		case "type":
			return t.types.includes(scope.target);
		case "list":
			return (t.collectionIds ?? []).includes(scope.target);
		case "user":
			return t.userId !== undefined && scope.target === t.userId;
		case "org":
			return t.orgId !== undefined && scope.target === t.orgId;
		default:
			return false;
	}
}

function contextMatches(layoutCtx: LayoutContext | null, want: LayoutContext): boolean {
	return layoutCtx === null || layoutCtx === want;
}

/**
 * Resolve the layout to render `target.entityId` in `target.context`.
 *
 * Algorithm (doc 27 §Resolution): keep candidates whose scope matches
 * the target AND whose context is the requested one or `null` (any);
 * the winner is the lowest scope rank, then context-specific over
 * any-context, then highest `updatedAt`, then the earliest-listed
 * (stable). If none match: `appDefault`, else `shellFallback`, else
 * `None` — the caller renders the schema-driven generic.
 */
export function resolveLayout(
	target: LayoutResolveTarget,
	candidates: readonly LayoutCandidate[],
	fallbacks: LayoutFallbacks = {},
): LayoutResolution {
	let best: { layout: LayoutDef; rank: number; ctxSpecific: boolean; at: number } | null = null;

	for (const c of candidates) {
		if (!scopeMatches(c.layout.scope, target)) continue;
		if (!contextMatches(c.layout.context, target.context)) continue;
		const rank = SCOPE_RANK[c.layout.scope.kind] ?? Number.POSITIVE_INFINITY;
		const ctxSpecific = c.layout.context !== null;
		const at = c.updatedAt ?? 0;
		const better =
			best === null ||
			rank < best.rank ||
			(rank === best.rank && ctxSpecific && !best.ctxSpecific) ||
			(rank === best.rank && ctxSpecific === best.ctxSpecific && at > best.at);
		if (better) best = { layout: c.layout, rank, ctxSpecific, at };
	}

	if (best !== null) {
		return {
			source: LayoutResolveSource.Scope,
			layout: best.layout,
			scope: best.layout.scope,
			updatedAt: best.at,
		};
	}
	if (fallbacks.appDefault) {
		return { source: LayoutResolveSource.AppDefault, layout: fallbacks.appDefault };
	}
	if (fallbacks.shellFallback) {
		return { source: LayoutResolveSource.ShellFallback, layout: fallbacks.shellFallback };
	}
	return { source: LayoutResolveSource.None };
}
