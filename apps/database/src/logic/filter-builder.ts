/**
 * Filter v2 — a pure model for a multi-rule predicate builder. Surviving
 * keystone: the renderer (the throwaway context-menu chain today, fancy-
 * menus later) only ever speaks `FilterRule` / `FilterDraft`; this module
 * is the single place that maps a flat AND/OR rule list to the
 * `PropertyPredicate` / `FilterNode` shape the evaluator + (Stage 9.3) SQL
 * compiler consume. v1's single-`$contains`-rule output is a strict subset
 * here, so existing persisted views round-trip without migration.
 *
 * v2.1a adds the `$in`-family multi-value ops (`is any of` / `has all
 * of` / `is none of`) — a comma-separated value input, no shape change.
 *
 * v2.1b adds **nested groups**: a `FilterDraft` carries an optional
 * `groups` list of child `FilterDraft`s, so the model now expresses an
 * arbitrarily deep AND/OR tree (e.g. `A AND (B OR C)`). The shape is
 * **additive** — a draft with no `groups` is byte-for-byte the old flat
 * draft, so every persisted view + existing call site round-trips with
 * zero migration. The converters recurse, so a nested filter authored on
 * one client (or synced in) is now reconstructed losslessly instead of
 * being silently flattened. The throwaway menu chain authors one nesting
 * level; the model + converters handle any depth (fancy-menus later
 * exposes the full tree).
 */

import {
	FilterGroupOp,
	type FilterNode,
	FilterNodeKind,
	type PropertyPredicate,
	type PropertyRef,
	isPropertyRef,
} from "../types/predicate";

export enum FilterOp {
	Contains = "contains",
	NotContains = "notContains",
	Eq = "eq",
	Neq = "neq",
	Gt = "gt",
	Lt = "lt",
	Gte = "gte",
	Lte = "lte",
	Like = "like",
	NotLike = "notLike",
	In = "in",
	AllIn = "allIn",
	NotIn = "notIn",
	Exists = "exists",
	Empty = "empty",
	/** Date is within a live-rolling relative range (9.12.20). Its `value` is
	 *  a `RelativeDateRange` token, not a literal date; offered only for Date
	 *  properties (the menu scopes it). */
	RelativeDate = "relativeDate",
}

/** What a reference right-hand side points at. Wire-compatible with the
 *  pre-enum `"prop"` / `"now"` literals. */
export enum FilterRefKind {
	Prop = "prop",
	Now = "now",
	/** The entity the view is embedded in (9.12.24) — "this object". */
	Host = "host",
}

/** A comparison right-hand side that references something else instead of a
 *  typed-in value (9.12.21): another property on the same row, the clock, or
 *  the host object an embedded view renders inside (9.12.24). */
export type FilterCompareTo =
	| { kind: FilterRefKind.Prop; propertyId: string }
	| { kind: FilterRefKind.Now }
	| { kind: FilterRefKind.Host };

/** The comparison ops that accept a `compareTo` reference (`due < now()`,
 *  `assignee is owner`). The list ops + text ops stay literal-only. */
const REF_OPS: ReadonlySet<FilterOp> = new Set([
	FilterOp.Eq,
	FilterOp.Neq,
	FilterOp.Gt,
	FilterOp.Lt,
	FilterOp.Gte,
	FilterOp.Lte,
]);

export function opAcceptsRef(op: FilterOp): boolean {
	return REF_OPS.has(op);
}

/** The ops a "this object" (`$host`) right-hand side makes sense for: identity
 *  (`is` / `is not`) on a single ref, membership (`contains`) on a relation. */
const HOST_REF_OPS: ReadonlySet<FilterOp> = new Set([
	FilterOp.Eq,
	FilterOp.Neq,
	FilterOp.Contains,
	FilterOp.NotContains,
]);

export function opAcceptsHostRef(op: FilterOp): boolean {
	return HOST_REF_OPS.has(op);
}

function refAllowed(compareTo: FilterCompareTo, op: FilterOp): boolean {
	return compareTo.kind === FilterRefKind.Host ? opAcceptsHostRef(op) : opAcceptsRef(op);
}

/** The multi-value ops whose raw input is a comma-separated list rather
 *  than one scalar. Centralised so the parse / inverse / describe paths
 *  all agree on which ops mean "a list". */
const LIST_OPS: ReadonlySet<FilterOp> = new Set([FilterOp.In, FilterOp.AllIn, FilterOp.NotIn]);

export function opIsList(op: FilterOp): boolean {
	return LIST_OPS.has(op);
}

export type FilterRule = {
	propertyId: string;
	op: FilterOp;
	/** Raw text from the value input; coerced per-op at compile time. Unused
	 *  for value-less ops (`exists` / `empty`) and when `compareTo` is set. */
	value: string;
	/** When set (comparison ops only), the right-hand side is a reference —
	 *  another property or the clock — not the literal `value` (9.12.21). */
	compareTo?: FilterCompareTo;
};

export type FilterDraft = {
	op: FilterGroupOp;
	rules: FilterRule[];
	/** Nested sub-groups (v2.1b). Each is a full `FilterDraft` with its
	 *  own `op`, joined into this group's `children` alongside `rules`.
	 *  Absent / `[]` ⇒ the flat pre-v2.1b draft (no migration needed). */
	groups?: FilterDraft[];
	/** Negate the whole group (9.12.21) — compiles to `$not` around the
	 *  group's AND/OR predicate. Absent / `false` ⇒ the plain group. */
	negate?: boolean;
};

/** Menu-facing catalogue: stable order, human label, and whether the op
 *  takes a value (drives whether the chain prompts for one). */
export const FILTER_OPERATORS: ReadonlyArray<{
	op: FilterOp;
	label: string;
	needsValue: boolean;
}> = [
	{ op: FilterOp.Contains, label: "contains", needsValue: true },
	{ op: FilterOp.NotContains, label: "does not contain", needsValue: true },
	{ op: FilterOp.Eq, label: "is", needsValue: true },
	{ op: FilterOp.Neq, label: "is not", needsValue: true },
	{ op: FilterOp.Gt, label: "greater than", needsValue: true },
	{ op: FilterOp.Lt, label: "less than", needsValue: true },
	{ op: FilterOp.Gte, label: "greater or equal", needsValue: true },
	{ op: FilterOp.Lte, label: "less or equal", needsValue: true },
	{ op: FilterOp.Like, label: "matches (% wildcard)", needsValue: true },
	{ op: FilterOp.NotLike, label: "does not match", needsValue: true },
	{ op: FilterOp.In, label: "is any of", needsValue: true },
	{ op: FilterOp.AllIn, label: "has all of", needsValue: true },
	{ op: FilterOp.NotIn, label: "is none of", needsValue: true },
	{ op: FilterOp.Exists, label: "is set", needsValue: false },
	{ op: FilterOp.Empty, label: "is empty", needsValue: false },
	{ op: FilterOp.RelativeDate, label: "is in", needsValue: true },
];

const NEEDS_VALUE = new Set(FILTER_OPERATORS.filter((o) => o.needsValue).map((o) => o.op));

export function opNeedsValue(op: FilterOp): boolean {
	return NEEDS_VALUE.has(op);
}

export function opLabel(op: FilterOp): string {
	return FILTER_OPERATORS.find((o) => o.op === op)?.label ?? op;
}

/** A rule is committable when it names a property and — for value ops —
 *  carries a non-empty value. Incomplete rules are silently dropped at
 *  compile time so a half-built rule never filters everything out. */
export function isRuleComplete(rule: FilterRule): boolean {
	if (!rule.propertyId) return false;
	if (!opNeedsValue(rule.op)) return true;
	// A comparison referencing another property / the clock needs no literal.
	if (rule.compareTo && refAllowed(rule.compareTo, rule.op)) {
		return rule.compareTo.kind !== FilterRefKind.Prop || rule.compareTo.propertyId !== "";
	}
	if (opIsList(rule.op)) return coerceList(rule.value).length > 0;
	return rule.value.trim() !== "";
}

/** The `PropertyRef` a comparison rule's `compareTo` resolves to, or `null`
 *  when the rule is a plain literal (or the ref is incomplete). */
function refOperand(rule: FilterRule): PropertyRef | null {
	if (!rule.compareTo || !refAllowed(rule.compareTo, rule.op)) return null;
	switch (rule.compareTo.kind) {
		case FilterRefKind.Now:
			return { $now: true };
		case FilterRefKind.Host:
			return { $host: true };
		case FilterRefKind.Prop:
			return rule.compareTo.propertyId ? { $prop: rule.compareTo.propertyId } : null;
	}
}

/** Split a comma-separated input into coerced scalars: trimmed, empties
 *  dropped (so `a, , b` is `["a","b"]` not three entries), each run
 *  through the same scalar coercion as single-value ops so `1, 2` is
 *  numeric and `true, false` boolean. A list with no real entries is
 *  empty → the rule reads as incomplete and is dropped at compile. */
function coerceList(raw: string): Array<string | number | boolean> {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.map(coerceScalar);
}

/** Coerce the raw input string to the type the evaluator compares against:
 *  `true`/`false` → boolean, a finite numeric string → number, else the
 *  trimmed string. Comparison ops keep a numeric string as a number so
 *  `> 5` is arithmetic, not lexical. `contains` keeps the raw string
 *  (substring / array-membership semantics). */
function coerceScalar(raw: string): string | number | boolean {
	const v = raw.trim();
	if (v === "true") return true;
	if (v === "false") return false;
	if (v !== "" && Number.isFinite(Number(v))) return Number(v);
	return v;
}

export function ruleToPredicate(rule: FilterRule): PropertyPredicate | null {
	if (!isRuleComplete(rule)) return null;
	const p = rule.propertyId;
	switch (rule.op) {
		case FilterOp.Exists:
			return { $exists: { [p]: true } };
		case FilterOp.Empty:
			return { $empty: { [p]: true } };
		case FilterOp.RelativeDate:
			return { $relativeDate: { [p]: rule.value } };
		case FilterOp.Contains:
			return { $contains: { [p]: refOperand(rule) ?? rule.value } };
		case FilterOp.NotContains:
			return { $notContains: { [p]: refOperand(rule) ?? rule.value } };
		case FilterOp.Like:
			return { $like: { [p]: rule.value } };
		case FilterOp.NotLike:
			return { $notLike: { [p]: rule.value } };
		case FilterOp.In:
			return { $in: { [p]: coerceList(rule.value) } };
		case FilterOp.AllIn:
			return { $allIn: { [p]: coerceList(rule.value) } };
		case FilterOp.NotIn:
			return { $notIn: { [p]: coerceList(rule.value) } };
		case FilterOp.Eq:
			return { $eq: { [p]: refOperand(rule) ?? coerceScalar(rule.value) } };
		case FilterOp.Neq:
			return { $neq: { [p]: refOperand(rule) ?? coerceScalar(rule.value) } };
		case FilterOp.Gt:
			return { $gt: { [p]: refOperand(rule) ?? coerceComparable(rule.value) } };
		case FilterOp.Lt:
			return { $lt: { [p]: refOperand(rule) ?? coerceComparable(rule.value) } };
		case FilterOp.Gte:
			return { $gte: { [p]: refOperand(rule) ?? coerceComparable(rule.value) } };
		case FilterOp.Lte:
			return { $lte: { [p]: refOperand(rule) ?? coerceComparable(rule.value) } };
		default:
			return null;
	}
}

/** `$gt`/`$lt`/`$gte`/`$lte` only accept `number | string` (not boolean) —
 *  keep numeric strings numeric, everything else a string. */
function coerceComparable(raw: string): number | string {
	const v = raw.trim();
	return v !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
}

/**
 * Compile a (possibly nested) draft to a `FilterNode` tree. Rule
 * children + recursively-compiled sub-group children are unioned in
 * declaration order. Incomplete rules and sub-groups that compile to
 * nothing are pruned; a group left with no surviving children compiles
 * to `null` (so an empty group never silently filters everything out).
 */
export function draftToFilterNode(draft: FilterDraft): FilterNode | null {
	const ruleChildren: FilterNode[] = draft.rules
		.map(ruleToPredicate)
		.filter((p): p is PropertyPredicate => p !== null)
		.map((predicate) => ({ kind: FilterNodeKind.Predicate as const, predicate }));
	const groupChildren: FilterNode[] = (draft.groups ?? [])
		.map(draftToFilterNode)
		.filter((n): n is FilterNode => n !== null);
	const children = [...ruleChildren, ...groupChildren];
	if (children.length === 0) return null;
	return draft.negate
		? { kind: FilterNodeKind.Group, op: draft.op, children, negate: true }
		: { kind: FilterNodeKind.Group, op: draft.op, children };
}

/** Total complete rules across the whole draft tree — drives the menu's
 *  "Clear" affordance + the empty-state copy. */
export function countDraftRules(draft: FilterDraft): number {
	const here = draft.rules.filter(isRuleComplete).length;
	return (draft.groups ?? []).reduce((sum, g) => sum + countDraftRules(g), here);
}

/** A draft contributes nothing to the query — no complete rule anywhere
 *  in the tree. Equivalent to `draftToFilterNode(draft) === null` but
 *  cheaper + intention-revealing at call sites. */
export function isDraftEmpty(draft: FilterDraft): boolean {
	return countDraftRules(draft) === 0;
}

const SCALAR_OP_BY_KEY: ReadonlyArray<[string, FilterOp]> = [
	["$contains", FilterOp.Contains],
	["$notContains", FilterOp.NotContains],
	["$eq", FilterOp.Eq],
	["$neq", FilterOp.Neq],
	["$gt", FilterOp.Gt],
	["$lt", FilterOp.Lt],
	["$gte", FilterOp.Gte],
	["$lte", FilterOp.Lte],
	["$like", FilterOp.Like],
	["$notLike", FilterOp.NotLike],
	["$in", FilterOp.In],
	["$allIn", FilterOp.AllIn],
	["$notIn", FilterOp.NotIn],
	["$exists", FilterOp.Exists],
	["$empty", FilterOp.Empty],
	["$relativeDate", FilterOp.RelativeDate],
];

function predicateToRule(pred: PropertyPredicate): FilterRule | null {
	for (const [key, op] of SCALAR_OP_BY_KEY) {
		if (key in pred) {
			const map = (pred as Record<string, Record<string, unknown>>)[key];
			if (!map) return null;
			const propertyId = Object.keys(map)[0];
			if (propertyId === undefined) return null;
			const raw = map[propertyId];
			// A computed RHS (another property / the clock) round-trips as a
			// `compareTo` reference rather than a literal value (9.12.21).
			if (isPropertyRef(raw)) {
				const compareTo: FilterCompareTo =
					"$now" in raw
						? { kind: FilterRefKind.Now }
						: "$host" in raw
							? { kind: FilterRefKind.Host }
							: { kind: FilterRefKind.Prop, propertyId: raw.$prop };
				return { propertyId, op, value: "", compareTo };
			}
			let value = "";
			if (opNeedsValue(op) && raw !== true) {
				value = Array.isArray(raw) ? raw.join(", ") : String(raw ?? "");
			}
			return { propertyId, op, value };
		}
	}
	return null;
}

/** Inverse of `draftToFilterNode` so re-opening the builder shows the
 *  live tree. A bare predicate node is a one-rule AND draft; a group's
 *  predicate children become `rules` and its **group children recurse
 *  into `groups`** (v2.1b — previously these were silently dropped, so a
 *  nested filter re-opened as a lie). `$not` / unknown predicates that
 *  don't map back to a rule are skipped, not invented. Round-trips the
 *  `$in`-family (v2.1a). */
export function filterNodeToDraft(node: FilterNode | null): FilterDraft {
	if (node === null) return { op: FilterGroupOp.And, rules: [] };
	if (node.kind === FilterNodeKind.Predicate) {
		const rule = predicateToRule(node.predicate);
		return { op: FilterGroupOp.And, rules: rule ? [rule] : [] };
	}
	const rules: FilterRule[] = [];
	const groups: FilterDraft[] = [];
	for (const child of node.children) {
		if (child.kind === FilterNodeKind.Predicate) {
			const rule = predicateToRule(child.predicate);
			if (rule) rules.push(rule);
		} else {
			groups.push(filterNodeToDraft(child));
		}
	}
	const base = groups.length > 0 ? { op: node.op, rules, groups } : { op: node.op, rules };
	return node.negate ? { ...base, negate: true } : base;
}

/** Compact one-line description for the menu, e.g. `status is "Done"`,
 *  `due less than now`, `assignee is owner`, or `author contains this object`.
 *  A `compareTo` reference shows the referenced property / `now` / the host
 *  label unquoted; a literal stays quoted. */
export function describeRule(
	rule: FilterRule,
	propertyLabel: string,
	valueLabel?: string,
	refLabelOf?: (propertyId: string) => string,
	hostLabel = "this object",
): string {
	const head = `${propertyLabel} ${opLabel(rule.op)}`;
	if (!opNeedsValue(rule.op)) return head;
	if (rule.compareTo && refAllowed(rule.compareTo, rule.op)) {
		const ref =
			rule.compareTo.kind === FilterRefKind.Now
				? "now"
				: rule.compareTo.kind === FilterRefKind.Host
					? hostLabel
					: (refLabelOf?.(rule.compareTo.propertyId) ?? rule.compareTo.propertyId);
		return `${head} ${ref}`;
	}
	return `${head} "${valueLabel ?? rule.value}"`;
}

/** One-line summary of a sub-group for the menu, e.g.
 *  `(2 rules · ANY)` / `(empty group)`. The join word matches the
 *  group's own `op`, not the parent's. */
export function describeGroup(group: FilterDraft): string {
	const n = countDraftRules(group);
	if (n === 0) return "(empty group)";
	const join = group.op === FilterGroupOp.And ? "ALL" : "ANY";
	return `(${n} ${n === 1 ? "rule" : "rules"} · ${join})`;
}
