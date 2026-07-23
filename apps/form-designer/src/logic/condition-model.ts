/**
 * Condition model (8.10.4) — the translation layer between the Builder's
 * single-clause condition editor and the canonical `PropertyPredicate`
 * that rides a form field's `condition`.
 *
 * The Fill-mode evaluation of that predicate is the SHARED
 * `@brainstorm-os/sdk/predicate-eval` stack (see `visibility-rules.ts`);
 * this module only maps the small UI shape — "show this field when
 * <field> <operator> <value>" — onto that language and back. A predicate
 * the simple editor cannot represent (a composite `$and`/`$or`, or an
 * operator outside the four below) round-trips as `null`, so the UI
 * degrades to a read-only "advanced condition" affordance rather than
 * silently rewriting it. Pure (no DOM) so it gets node-env coverage.
 */

import { type PropertyPredicate, type ScalarValue, isPropertyRef } from "@brainstorm-os/sdk-types";

/** The four operators the single-clause editor exposes. `Is`/`IsNot`
 *  take a value; `IsSet`/`IsEmpty` are unary. */
export enum ConditionOp {
	Is = "is",
	IsNot = "isNot",
	IsSet = "isSet",
	IsEmpty = "isEmpty",
}

/** A UI-editable single condition: show the field when the referenced
 *  field's value satisfies `op` (against `value` for the binary ops). */
export type ConditionClause = {
	/** Property key of the field whose value is tested. */
	when: string;
	op: ConditionOp;
	/** Only read for `Is` / `IsNot`. */
	value?: ScalarValue;
};

export const CONDITION_OPS: readonly ConditionOp[] = Object.freeze([
	ConditionOp.Is,
	ConditionOp.IsNot,
	ConditionOp.IsSet,
	ConditionOp.IsEmpty,
]);

/** Whether the operator reads a right-hand value (so the editor shows the
 *  value control) — `Is` / `IsNot` do, the unary ops don't. */
export function opNeedsValue(op: ConditionOp): boolean {
	return op === ConditionOp.Is || op === ConditionOp.IsNot;
}

/** Map a UI clause to the canonical predicate. An empty `when` (no field
 *  chosen yet) yields `undefined` — i.e. no condition, always visible. */
export function clauseToPredicate(clause: ConditionClause): PropertyPredicate | undefined {
	if (!clause.when) return undefined;
	const value: ScalarValue = clause.value ?? null;
	switch (clause.op) {
		case ConditionOp.Is:
			return { $eq: { [clause.when]: value } };
		case ConditionOp.IsNot:
			return { $neq: { [clause.when]: value } };
		case ConditionOp.IsSet:
			return { $exists: { [clause.when]: true } };
		case ConditionOp.IsEmpty:
			return { $empty: { [clause.when]: true } };
		default:
			return undefined;
	}
}

/** Best-effort parse of a persisted predicate back into a UI clause.
 *  Only the four single-clause shapes this editor emits are recognised;
 *  anything else (composite, unknown op, a computed `PropertyRef` RHS)
 *  returns `null` so the caller treats it as an advanced condition. */
export function predicateToClause(pred: PropertyPredicate | undefined): ConditionClause | null {
	if (!pred || typeof pred !== "object") return null;
	const binary = (map: Record<string, unknown>, op: ConditionOp): ConditionClause | null => {
		const keys = Object.keys(map);
		if (keys.length !== 1) return null;
		const when = keys[0] as string;
		const raw = map[when];
		if (isPropertyRef(raw)) return null;
		return { when, op, value: raw as ScalarValue };
	};
	const unary = (map: Record<string, unknown>, op: ConditionOp): ConditionClause | null => {
		const keys = Object.keys(map);
		if (keys.length !== 1) return null;
		return { when: keys[0] as string, op };
	};
	if ("$eq" in pred) return binary(pred.$eq, ConditionOp.Is);
	if ("$neq" in pred) return binary(pred.$neq, ConditionOp.IsNot);
	if ("$exists" in pred) return unary(pred.$exists, ConditionOp.IsSet);
	if ("$empty" in pred) return unary(pred.$empty, ConditionOp.IsEmpty);
	return null;
}
