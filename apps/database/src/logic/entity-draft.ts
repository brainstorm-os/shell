/**
 * Entity-draft computer — builds the starting shape for a new entity
 * created from "+ New" on a List/view, by pulling pinnable property values
 * out of the List's source and the View's filter overlay.
 *
 * Spec: §Criteria inheritance.
 *
 * Rules in one paragraph: walk the AND-chain of `source ∪ view.filters`,
 * pulling out predicates that pin a property to a single value. Predicates
 * inside an OR branch are NOT pinned (the entity could satisfy any one
 * branch — we can't pick which). Multi-path predicates fan out to one
 * property per path. Date-range predicates pin to the lower bound (start
 * of range), not the upper.
 *
 * The draft is the entity-shape that goes into `entities.createEntity` —
 * type + property values, no id, no timestamps. Downstream the entities
 * service writes the actual entity; this function never persists.
 */

import { CompositeOp, type ListSource, ListSourceKind } from "../types/list-source";
import {
	FilterGroupOp,
	type FilterNode,
	FilterNodeKind,
	type PropertyPredicate,
	type PropertyRef,
	type ScalarValue,
	isHostRef,
	isPropertyRef,
} from "../types/predicate";

/** A value emitted into an entity draft. Scalar for single-value properties;
 *  scalar array for multi-value properties (whose schema has `count.max > 1`).
 *
 *  Property *value envelopes* (the `{ value, ...meta }` shape introduced in
 *  §Value envelopes) are wrapped by
 *  the entities service at write time using the PropertySchema's
 *  `valueMeta`. The draft computer emits the bare scalar / scalar[] form
 *  because criteria predicates only carry scalars — the envelope's meta
 *  fields are downstream concerns. */
export type DraftValue = ScalarValue | ScalarValue[];

export type EntityDraft = {
	type?: string;
	properties: Record<string, DraftValue>;
};

export type DraftInputs = {
	source: ListSource | null;
	viewFilters: FilterNode | null;
	defaultTypeUrl: string | null;
	/** The host an embedded view renders inside (9.12.24): a `$host` pin
	 *  ("author contains this object") pre-fills the new row with it. */
	hostEntityId?: string;
};

/**
 * Build the entity draft for a new item created from "+ New" on a view.
 * See §Criteria inheritance.
 *
 * Type resolution: the view's `defaultTypeUrl` wins; if absent, fall back
 * to a single-type `byType` source's type. With neither, `type` is omitted
 * and the caller's UI is expected to surface "pick a default type" before
 * enabling the "+" button.
 */
export function draftForList(inputs: DraftInputs): EntityDraft {
	const properties: Record<string, DraftValue> = {};

	const host = inputs.hostEntityId;
	for (const pred of collectAndOnlyPredicates(inputs.source)) {
		pinFromPredicate(pred, properties, host);
	}
	for (const pred of collectAndOnlyPredicatesFromFilterNode(inputs.viewFilters)) {
		pinFromPredicate(pred, properties, host);
	}

	const draft: EntityDraft = { properties };
	const type =
		inputs.defaultTypeUrl ??
		(inputs.source?.kind === ListSourceKind.ByType && inputs.source.types.length === 1
			? inputs.source.types[0]
			: undefined);
	if (type !== undefined) draft.type = type;
	return draft;
}

/**
 * Walk a `ListSource` tree, emitting the predicates reachable via
 * AND-only paths. `byType` is handled at the draft level (type, not
 * properties); `byFilter` contributes its `where` as-is; `byLink`
 * contributes nothing (a new entity isn't an inverse of the anchor —
 * the caller may dispatch a separate link-creation step); `byVocabulary`
 * needs a PropertySchema lookup to know which property path holds the
 * vocab reference and is therefore deferred to the consumer (the
 * entities service can extend with that lookup once exposed); `composite`
 * recurses only on AND.
 */
export function collectAndOnlyPredicates(source: ListSource | null): PropertyPredicate[] {
	if (source === null) return [];
	switch (source.kind) {
		case ListSourceKind.ByType:
		case ListSourceKind.ByLink:
		case ListSourceKind.ByVocabulary:
			return [];
		case ListSourceKind.ByFilter:
			return [source.where];
		case ListSourceKind.Composite:
			if (source.op !== CompositeOp.And) return [];
			return source.sources.flatMap(collectAndOnlyPredicates);
	}
}

/**
 * Walk a `FilterNode` tree, emitting the leaf predicates reachable via
 * AND-only paths. OR groups contribute nothing.
 */
export function collectAndOnlyPredicatesFromFilterNode(
	node: FilterNode | null,
): PropertyPredicate[] {
	if (node === null) return [];
	if (node.kind === FilterNodeKind.Predicate) return [node.predicate];
	if (node.op !== FilterGroupOp.And) return [];
	return node.children.flatMap(collectAndOnlyPredicatesFromFilterNode);
}

/** The concrete value a predicate RHS pins, or `undefined`: literals pass,
 *  `$host` becomes the host id (if any), every other ref pins nothing. */
function pinnable(
	value: ScalarValue | PropertyRef,
	host: string | undefined,
): ScalarValue | undefined {
	if (!isPropertyRef(value)) return value;
	return isHostRef(value) ? host : undefined;
}

/** Drain a `PropertyPredicate` into `out` if it pins a property. Mutates `out`. */
function pinFromPredicate(
	pred: PropertyPredicate,
	out: Record<string, DraftValue>,
	host: string | undefined,
): void {
	if ("$and" in pred) {
		for (const child of pred.$and) pinFromPredicate(child, out, host);
		return;
	}
	// $or / $not — non-pinnable; user picks at create time.
	if ("$or" in pred || "$not" in pred) return;

	if ("$eq" in pred) {
		for (const [path, value] of Object.entries(pred.$eq)) {
			// A computed RHS (another property / the clock) isn't a concrete
			// default the new entity should hold — skip it (9.12.21); the host
			// is, when there is one (9.12.24).
			const pinned = pinnable(value, host);
			if (pinned !== undefined) out[path] = pinned;
		}
		return;
	}
	if ("$in" in pred) {
		for (const [path, values] of Object.entries(pred.$in)) {
			if (values.length === 1 && values[0] !== undefined) {
				out[path] = values[0];
			}
		}
		return;
	}
	if ("$contains" in pred) {
		for (const [path, raw] of Object.entries(pred.$contains)) {
			const value = pinnable(raw, host);
			if (value === undefined) continue;
			const existing = out[path];
			if (Array.isArray(existing)) {
				out[path] = existing.includes(value) ? existing : [...existing, value];
			} else if (existing === undefined) {
				out[path] = [value];
			}
		}
		return;
	}
	if ("$allIn" in pred) {
		for (const [path, values] of Object.entries(pred.$allIn)) {
			out[path] = [...values];
		}
		return;
	}
	if ("$gte" in pred) {
		// Date / number range — pin to the lower bound iff no other inheritance
		// has set this path yet. A subsequent $lte does not override.
		for (const [path, value] of Object.entries(pred.$gte)) {
			if (out[path] === undefined && !isPropertyRef(value)) out[path] = value;
		}
		return;
	}
	if ("$lte" in pred) {
		for (const [path, value] of Object.entries(pred.$lte)) {
			if (out[path] === undefined && !isPropertyRef(value)) out[path] = value;
		}
		return;
	}
	// $neq / $notContains / $notIn / $notLike / $like / $gt / $lt / $exists
	// / $empty / $notLike — none pin a single value the new entity should
	// hold, so they're skipped.
}
