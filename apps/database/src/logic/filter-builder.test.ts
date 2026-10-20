import { describe, expect, it } from "vitest";
import { FilterGroupOp } from "../types/predicate";
import {
	FILTER_OPERATORS,
	FilterOp,
	FilterRefKind,
	type FilterRule,
	describeRule,
	draftToFilterNode,
	filterNodeToDraft,
	isRuleComplete,
	opAcceptsHostRef,
	opLabel,
	ruleToPredicate,
} from "./filter-builder";

describe("filter-builder — $relativeDate operator (9.12.20)", () => {
	const rule = (over: Partial<FilterRule> = {}): FilterRule => ({
		propertyId: "due",
		op: FilterOp.RelativeDate,
		value: "last7Days",
		...over,
	});

	it("is offered in the operator catalogue as a value op", () => {
		const entry = FILTER_OPERATORS.find((o) => o.op === FilterOp.RelativeDate);
		expect(entry).toBeDefined();
		expect(entry?.needsValue).toBe(true);
		expect(opLabel(FilterOp.RelativeDate)).toBe("is in");
	});

	it("compiles to a $relativeDate predicate carrying the range token", () => {
		expect(ruleToPredicate(rule())).toEqual({ $relativeDate: { due: "last7Days" } });
	});

	it("is incomplete (dropped) with no chosen range", () => {
		expect(isRuleComplete(rule({ value: "" }))).toBe(false);
		expect(ruleToPredicate(rule({ value: "" }))).toBeNull();
	});

	it("round-trips through the FilterNode tree (re-opening the builder)", () => {
		const draft = { op: FilterGroupOp.And, rules: [rule()] };
		const node = draftToFilterNode(draft);
		expect(node).not.toBeNull();
		const back = filterNodeToDraft(node);
		expect(back.rules).toEqual([
			{ propertyId: "due", op: FilterOp.RelativeDate, value: "last7Days" },
		]);
	});
});

describe("filter-builder — this object ($host) right-hand side (9.12.24)", () => {
	const host = { kind: FilterRefKind.Host } as const;

	it("compiles contains / is to a $host ref and round-trips", () => {
		const contains: FilterRule = {
			propertyId: "author",
			op: FilterOp.Contains,
			value: "",
			compareTo: host,
		};
		expect(isRuleComplete(contains)).toBe(true);
		expect(ruleToPredicate(contains)).toEqual({ $contains: { author: { $host: true } } });
		const eq: FilterRule = { propertyId: "owner", op: FilterOp.Eq, value: "", compareTo: host };
		expect(ruleToPredicate(eq)).toEqual({ $eq: { owner: { $host: true } } });
		const node = draftToFilterNode({ op: FilterGroupOp.And, rules: [contains, eq] });
		expect(filterNodeToDraft(node).rules).toEqual([contains, eq]);
	});

	it("is only offered on identity / membership ops", () => {
		expect(opAcceptsHostRef(FilterOp.Contains)).toBe(true);
		expect(opAcceptsHostRef(FilterOp.Neq)).toBe(true);
		expect(opAcceptsHostRef(FilterOp.Gt)).toBe(false);
		const gt: FilterRule = { propertyId: "n", op: FilterOp.Gt, value: "", compareTo: host };
		expect(isRuleComplete(gt)).toBe(false);
		expect(ruleToPredicate(gt)).toBeNull();
	});

	it("describes with the supplied host label", () => {
		const rule: FilterRule = {
			propertyId: "author",
			op: FilterOp.Contains,
			value: "",
			compareTo: host,
		};
		expect(describeRule(rule, "Author", undefined, undefined, "cet objet")).toBe(
			"Author contains cet objet",
		);
	});
});
