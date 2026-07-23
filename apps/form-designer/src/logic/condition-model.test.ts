import type { PropertyPredicate } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	type ConditionClause,
	ConditionOp,
	clauseToPredicate,
	opNeedsValue,
	predicateToClause,
} from "./condition-model";

describe("opNeedsValue", () => {
	it("is true only for the binary operators", () => {
		expect(opNeedsValue(ConditionOp.Is)).toBe(true);
		expect(opNeedsValue(ConditionOp.IsNot)).toBe(true);
		expect(opNeedsValue(ConditionOp.IsSet)).toBe(false);
		expect(opNeedsValue(ConditionOp.IsEmpty)).toBe(false);
	});
});

describe("clauseToPredicate", () => {
	it("maps the binary operators to $eq / $neq", () => {
		expect(clauseToPredicate({ when: "country", op: ConditionOp.Is, value: "US" })).toEqual({
			$eq: { country: "US" },
		});
		expect(clauseToPredicate({ when: "country", op: ConditionOp.IsNot, value: "US" })).toEqual({
			$neq: { country: "US" },
		});
	});

	it("maps the unary operators to $exists / $empty", () => {
		expect(clauseToPredicate({ when: "phone", op: ConditionOp.IsSet })).toEqual({
			$exists: { phone: true },
		});
		expect(clauseToPredicate({ when: "phone", op: ConditionOp.IsEmpty })).toEqual({
			$empty: { phone: true },
		});
	});

	it("carries a boolean / number value through unchanged", () => {
		expect(clauseToPredicate({ when: "ok", op: ConditionOp.Is, value: true })).toEqual({
			$eq: { ok: true },
		});
		expect(clauseToPredicate({ when: "qty", op: ConditionOp.Is, value: 3 })).toEqual({
			$eq: { qty: 3 },
		});
	});

	it("treats a missing binary value as null (not undefined)", () => {
		expect(clauseToPredicate({ when: "country", op: ConditionOp.Is })).toEqual({
			$eq: { country: null },
		});
	});

	it("returns undefined when no field is chosen (always visible)", () => {
		expect(clauseToPredicate({ when: "", op: ConditionOp.Is, value: "x" })).toBeUndefined();
	});
});

describe("predicateToClause", () => {
	it("round-trips every single-clause shape the editor emits", () => {
		const clauses: ConditionClause[] = [
			{ when: "country", op: ConditionOp.Is, value: "US" },
			{ when: "country", op: ConditionOp.IsNot, value: "US" },
			{ when: "phone", op: ConditionOp.IsSet },
			{ when: "phone", op: ConditionOp.IsEmpty },
			{ when: "ok", op: ConditionOp.Is, value: true },
		];
		for (const clause of clauses) {
			const pred = clauseToPredicate(clause);
			expect(pred).toBeDefined();
			expect(predicateToClause(pred)).toEqual(clause);
		}
	});

	it("returns null for a composite predicate the simple editor can't show", () => {
		const composite: PropertyPredicate = {
			$and: [{ $eq: { country: "US" } }, { $exists: { state: true } }],
		};
		expect(predicateToClause(composite)).toBeNull();
	});

	it("returns null for an operator outside the four", () => {
		expect(predicateToClause({ $contains: { tags: "urgent" } })).toBeNull();
	});

	it("returns null for a computed PropertyRef right-hand side", () => {
		expect(predicateToClause({ $eq: { due: { $now: true } } })).toBeNull();
	});

	it("returns null for an undefined / empty predicate", () => {
		expect(predicateToClause(undefined)).toBeNull();
	});
});
