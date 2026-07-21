/**
 * Tests for `evaluatePredicate` — the in-memory mirror of the SQL compiler
 * that the entities service will use at Stage 9.3. Every operator branch
 * pins down its truth table here. Same `PropertyPredicate` shape MUST
 * produce the same matches across both engines per
 *  §Predicate semantics.
 */

import type { PropertyPredicate } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { evaluatePredicate } from "./evaluate-predicate";
import type { EntityRow } from "./in-memory-entities";

function entity(properties: Record<string, unknown>): EntityRow {
	return {
		id: "ent_1",
		type: "io.test/Thing/v1",
		properties,
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

describe("evaluatePredicate — scalars", () => {
	it("$eq matches", () => {
		const e = entity({ status: "Done" });
		expect(evaluatePredicate(e, { $eq: { status: "Done" } })).toBe(true);
		expect(evaluatePredicate(e, { $eq: { status: "Open" } })).toBe(false);
	});

	it("$neq matches the inverse", () => {
		const e = entity({ status: "Done" });
		expect(evaluatePredicate(e, { $neq: { status: "Open" } })).toBe(true);
		expect(evaluatePredicate(e, { $neq: { status: "Done" } })).toBe(false);
	});

	it("$gt / $lt / $gte / $lte compare numbers", () => {
		const e = entity({ count: 5 });
		expect(evaluatePredicate(e, { $gt: { count: 3 } })).toBe(true);
		expect(evaluatePredicate(e, { $gt: { count: 5 } })).toBe(false);
		expect(evaluatePredicate(e, { $gte: { count: 5 } })).toBe(true);
		expect(evaluatePredicate(e, { $lt: { count: 6 } })).toBe(true);
		expect(evaluatePredicate(e, { $lte: { count: 5 } })).toBe(true);
	});

	it("$in / $notIn check membership", () => {
		const e = entity({ status: "Done" });
		expect(evaluatePredicate(e, { $in: { status: ["Done", "In progress"] } })).toBe(true);
		expect(evaluatePredicate(e, { $in: { status: ["Open"] } })).toBe(false);
		expect(evaluatePredicate(e, { $notIn: { status: ["Open"] } })).toBe(true);
	});
});

describe("evaluatePredicate — collections + strings", () => {
	it("$contains over arrays returns true on a member", () => {
		const e = entity({ tags: ["docs", "team"] });
		expect(evaluatePredicate(e, { $contains: { tags: "team" } })).toBe(true);
		expect(evaluatePredicate(e, { $contains: { tags: "marketing" } })).toBe(false);
	});

	it("$contains over strings is case-insensitive substring", () => {
		const e = entity({ title: "Onboarding doc" });
		expect(evaluatePredicate(e, { $contains: { title: "BOARD" } })).toBe(true);
	});

	it("$allIn requires every wanted value to be present", () => {
		const e = entity({ tags: ["docs", "team", "ops"] });
		expect(evaluatePredicate(e, { $allIn: { tags: ["docs", "team"] } })).toBe(true);
		expect(evaluatePredicate(e, { $allIn: { tags: ["docs", "missing"] } })).toBe(false);
	});

	it("$like matches with %-wildcards, case-insensitive", () => {
		const e = entity({ title: "Pricing page A/B" });
		expect(evaluatePredicate(e, { $like: { title: "pricing%" } })).toBe(true);
		expect(evaluatePredicate(e, { $like: { title: "%a/B" } })).toBe(true);
		expect(evaluatePredicate(e, { $like: { title: "exact" } })).toBe(false);
	});
});

describe("evaluatePredicate — presence", () => {
	it("$exists distinguishes set vs absent", () => {
		const e = entity({ title: "x", tags: [] });
		expect(evaluatePredicate(e, { $exists: { title: true } })).toBe(true);
		expect(evaluatePredicate(e, { $exists: { tags: true } })).toBe(false);
		expect(evaluatePredicate(e, { $exists: { missing: true } })).toBe(false);
	});

	it("$empty matches null / undefined / '' / []", () => {
		expect(evaluatePredicate(entity({ title: "" }), { $empty: { title: true } })).toBe(true);
		expect(evaluatePredicate(entity({ title: "x" }), { $empty: { title: true } })).toBe(false);
		expect(evaluatePredicate(entity({ tags: [] }), { $empty: { tags: true } })).toBe(true);
	});
});

describe("evaluatePredicate — logical combinators", () => {
	const tasks = [
		entity({ status: "Done", priority: "Low" }),
		entity({ status: "Done", priority: "High" }),
		entity({ status: "Open", priority: "High" }),
	];

	it("$and short-circuits on first failure", () => {
		const pred = { $and: [{ $eq: { status: "Done" } }, { $eq: { priority: "High" } }] };
		expect(evaluatePredicate(tasks[0] as EntityRow, pred)).toBe(false);
		expect(evaluatePredicate(tasks[1] as EntityRow, pred)).toBe(true);
		expect(evaluatePredicate(tasks[2] as EntityRow, pred)).toBe(false);
	});

	it("$or returns true on any branch match", () => {
		const pred = { $or: [{ $eq: { status: "Open" } }, { $eq: { priority: "Low" } }] };
		expect(evaluatePredicate(tasks[0] as EntityRow, pred)).toBe(true);
		expect(evaluatePredicate(tasks[1] as EntityRow, pred)).toBe(false);
		expect(evaluatePredicate(tasks[2] as EntityRow, pred)).toBe(true);
	});

	it("$not inverts", () => {
		expect(evaluatePredicate(tasks[0] as EntityRow, { $not: { $eq: { status: "Open" } } })).toBe(
			true,
		);
	});
});

describe("evaluatePredicate — $relativeDate (live-rolling, 9.12.20)", () => {
	// Fixed reference clock: 2026-06-15T12:00 local.
	const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
	const iso = (y: number, m: number, d: number) => new Date(y, m, d, 9, 0, 0).toISOString();

	it("matches a date inside the resolved window and rejects one outside", () => {
		const inWindow = entity({ due: iso(2026, 5, 12) }); // 3 days ago
		const outWindow = entity({ due: iso(2026, 4, 1) }); // last month
		expect(evaluatePredicate(inWindow, { $relativeDate: { due: "last7Days" } }, now)).toBe(true);
		expect(evaluatePredicate(outWindow, { $relativeDate: { due: "last7Days" } }, now)).toBe(false);
	});

	it("rolls live — the same token resolves to a later window as `now` advances", () => {
		const e = entity({ due: iso(2026, 5, 12) }); // June 12
		// In-range when "now" is June 15 (within trailing 7 days)...
		expect(evaluatePredicate(e, { $relativeDate: { due: "last7Days" } }, now)).toBe(true);
		// ...out of range two weeks later, with NO change to the stored filter token.
		const later = new Date(2026, 5, 29, 12, 0, 0).getTime();
		expect(evaluatePredicate(e, { $relativeDate: { due: "last7Days" } }, later)).toBe(false);
	});

	it("an unknown token matches nothing (never matches everything)", () => {
		const e = entity({ due: iso(2026, 5, 15) });
		expect(evaluatePredicate(e, { $relativeDate: { due: "lastFortnight" } }, now)).toBe(false);
	});

	it("a non-date / missing value is never in range", () => {
		expect(
			evaluatePredicate(entity({ due: "not a date" }), { $relativeDate: { due: "today" } }, now),
		).toBe(false);
		expect(evaluatePredicate(entity({}), { $relativeDate: { due: "today" } }, now)).toBe(false);
	});
});

describe("evaluatePredicate — cross-property & clock refs (9.12.21)", () => {
	const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
	const DAY = 86_400_000;

	it("$lt against $now compares a date cell to the clock", () => {
		const overdue = entity({ due: { at: NOW - DAY, granularity: "date" } });
		const future = entity({ due: { at: NOW + DAY, granularity: "date" } });
		const pred: PropertyPredicate = { $lt: { due: { $now: true } } };
		expect(evaluatePredicate(overdue, pred, NOW)).toBe(true);
		expect(evaluatePredicate(future, pred, NOW)).toBe(false);
	});

	it("$eq against $prop compares two properties on the same entity", () => {
		expect(
			evaluatePredicate(entity({ assignee: "u1", owner: "u1" }), {
				$eq: { assignee: { $prop: "owner" } },
			}),
		).toBe(true);
		expect(
			evaluatePredicate(entity({ assignee: "u1", owner: "u2" }), {
				$eq: { assignee: { $prop: "owner" } },
			}),
		).toBe(false);
	});

	it("$gt against $prop orders one number property against another", () => {
		expect(
			evaluatePredicate(entity({ spent: 5, budget: 3 }), { $gt: { spent: { $prop: "budget" } } }),
		).toBe(true);
		expect(
			evaluatePredicate(entity({ spent: 2, budget: 3 }), { $gt: { spent: { $prop: "budget" } } }),
		).toBe(false);
	});

	it("a missing referenced property never matches", () => {
		expect(evaluatePredicate(entity({ spent: 5 }), { $gt: { spent: { $prop: "budget" } } })).toBe(
			false,
		);
		expect(
			evaluatePredicate(entity({ owner: "u1" }), { $eq: { assignee: { $prop: "owner" } } }),
		).toBe(false);
	});
});
