/**
 * Property-predicate language (9.3.5.1b) — the cross-app query/filter
 * predicate used by `ListSource.byFilter`, a `ListView` filter overlay, and
 * `EntityQuery.where`. Promoted here from the app-local
 * `apps/database/src/types/predicate.ts` so there is ONE canonical shape.
 *
 * Mirrors `PropertyPredicate` from
 * 18-storage-and-search.md;
 * the entities service compiles this same shape to SQL
 * (`packages/shell/src/main/storage/entities-repo`). The pre-9.3.5.1b
 * `EntityQuery.where` in `index.ts` declared a thin 7-operator subset
 * inline — this file is the superset that supersedes it. The entities-repo
 * compiler matches the operators it understands and falls through to
 * "match nothing" for any it doesn't, so the wider operator set is safe.
 *
 * Leaf module (no imports) so `index.ts` and app-local re-export shims can
 * depend on it without a cycle through the barrel.
 */

/** A path into an entity's properties. For multi-value properties stored as
 *  arrays of `{value, label?}`, paths can target `phones.value` / `phones.label`
 *  per §Querying. */
export type PropertyPath = string;

/** Scalar values that show up on the right-hand side of a predicate. */
export type ScalarValue = string | number | boolean | null;

/** A computed right-hand side for a comparison op (9.12.21). Lets a predicate
 *  compare a property to *another property on the same entity* (`$prop`) or to
 *  the current clock (`$now`, resolved at evaluation/compile time) instead of a
 *  fixed literal — e.g. `due < now()` or `assignee = owner`. Comparison ops
 *  accept a `PropertyRef` anywhere a literal is allowed; the evaluator and the
 *  SQL compiler resolve it the same way.
 *
 *  `$host` (9.12.24) resolves to the id of the HOST entity an embedded view is
 *  rendered inside (a Database block dropped into a page: "Books where author
 *  contains this page"). It is supplied by the evaluation context, never the
 *  row; with no host in context a predicate that references `$host` matches
 *  NOTHING — the SQL compiler, which has no host, always compiles it to
 *  match-nothing. */
export type PropertyRef = { $prop: PropertyPath } | { $now: true } | { $host: true };

/** A comparison right-hand side: either a literal or a computed `PropertyRef`. */
export type Comparand = number | string | PropertyRef;

export type PropertyPredicate =
	| { $eq: Record<PropertyPath, ScalarValue | PropertyRef> }
	| { $neq: Record<PropertyPath, ScalarValue | PropertyRef> }
	| { $contains: Record<PropertyPath, ScalarValue | PropertyRef> }
	| { $notContains: Record<PropertyPath, ScalarValue | PropertyRef> }
	| { $gt: Record<PropertyPath, Comparand> }
	| { $lt: Record<PropertyPath, Comparand> }
	| { $gte: Record<PropertyPath, Comparand> }
	| { $lte: Record<PropertyPath, Comparand> }
	| { $in: Record<PropertyPath, ScalarValue[]> }
	| { $allIn: Record<PropertyPath, ScalarValue[]> }
	| { $notIn: Record<PropertyPath, ScalarValue[]> }
	| { $exists: Record<PropertyPath, true> }
	| { $empty: Record<PropertyPath, true> }
	| { $like: Record<PropertyPath, string> }
	| { $notLike: Record<PropertyPath, string> }
	/** Live-rolling relative-date membership (9.12.20). The RHS is a relative-date
	 *  range *token* (e.g. `"last7Days"`), NOT a snapshotted absolute window — the
	 *  in-app evaluator resolves it against the current clock on every pass, so the
	 *  filter re-evaluates continuously. The SQL compiler (shell `byFilter`) does
	 *  not understand this operator and falls through to match-nothing, so it is a
	 *  client-side view-overlay filter only; kept a plain string here so this leaf
	 *  module stays dependency-free of the app's `RelativeDateRange` enum. */
	| { $relativeDate: Record<PropertyPath, string> }
	| { $and: PropertyPredicate[] }
	| { $or: PropertyPredicate[] }
	| { $not: PropertyPredicate };

/** True when a comparison operand is a computed `PropertyRef` rather than a
 *  literal. Shared by the evaluator + SQL compiler + filter-builder so all
 *  three branch on the same shape (9.12.21). */
export function isPropertyRef(v: unknown): v is PropertyRef {
	return typeof v === "object" && v !== null && ("$prop" in v || "$now" in v || "$host" in v);
}

/** True when the ref resolves to the evaluation context's host entity. */
export function isHostRef(v: unknown): v is { $host: true } {
	return isPropertyRef(v) && "$host" in v;
}

/** True when any leaf of `pred` compares against `$host`. A host-relative
 *  predicate evaluated with no host must match nothing — including under
 *  `$not` / `$neq` / `$notContains`, which a per-leaf `false` would invert into
 *  match-everything — so evaluators gate on this before walking rows. */
export function predicateReferencesHost(pred: PropertyPredicate): boolean {
	if ("$and" in pred) return pred.$and.some(predicateReferencesHost);
	if ("$or" in pred) return pred.$or.some(predicateReferencesHost);
	if ("$not" in pred) return predicateReferencesHost(pred.$not);
	for (const map of Object.values(pred) as unknown[]) {
		if (!map || typeof map !== "object") continue;
		for (const rhs of Object.values(map as Record<string, unknown>)) {
			if (isHostRef(rhs)) return true;
		}
	}
	return false;
}

/** Filter UI tree — a stack of predicates organised in AND/OR groups.
 *  Compiles to a `PropertyPredicate` (single-rooted) at write time. */
export enum FilterNodeKind {
	Predicate = "predicate",
	Group = "group",
}

export enum FilterGroupOp {
	And = "and",
	Or = "or",
}

export type FilterPredicateNode = {
	kind: FilterNodeKind.Predicate;
	predicate: PropertyPredicate;
};

export type FilterGroupNode = {
	kind: FilterNodeKind.Group;
	op: FilterGroupOp;
	children: FilterNode[];
	/** Negate the whole group (9.12.21) — compiles to `$not` around the
	 *  group's AND/OR predicate. Absent / `false` ⇒ the plain group. */
	negate?: boolean;
};

export type FilterNode = FilterPredicateNode | FilterGroupNode;
