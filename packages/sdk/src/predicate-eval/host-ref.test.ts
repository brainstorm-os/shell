import {
	CompositeOp,
	type ListSource,
	ListSourceKind,
	type PropertyPredicate,
	type PropertyRef,
	type ScalarValue,
	predicateReferencesHost,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { EntityRow, InMemoryVault } from "../in-memory-entities";
import { evaluatePredicate } from "./evaluate-predicate";
import { evaluateSource } from "./evaluate-source";

const HOST: { $host: true } = { $host: true };

function row(id: string, properties: Record<string, unknown>): EntityRow {
	return { id, type: "io.test/Book/v1", properties, createdAt: 0, updatedAt: 0, deletedAt: null };
}

/** mulberry32 — deterministic, so a failing seed reproduces exactly. fast-check
 *  is not a workspace dependency; this is the same generate-and-compare shape. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const IDS = ["ent_a", "ent_b", "ent_c", "ent_d"] as const;
const PATHS = ["author", "editors", "title"] as const;
const LEAF_OPS = ["$eq", "$neq", "$contains", "$notContains", "$gt", "$lte"] as const;

function pick<T>(r: () => number, xs: readonly T[]): T {
	return xs[Math.floor(r() * xs.length)] as T;
}

function genEntity(r: () => number, i: number): EntityRow {
	const props: Record<string, unknown> = {};
	if (r() < 0.8) props.author = pick(r, IDS);
	if (r() < 0.8) props.editors = IDS.filter(() => r() < 0.4);
	if (r() < 0.5) props.title = pick(r, ["x", "ent_a", "y"]);
	return row(`row_${i}`, props);
}

/** A random predicate tree whose leaves compare against `rhs()` — called once
 *  per leaf so the host-ref and literal trees are built from one shape. */
function genPredicate(
	r: () => number,
	depth: number,
	rhs: (r: () => number) => ScalarValue | PropertyRef,
): PropertyPredicate {
	const roll = r();
	if (depth > 0 && roll < 0.15) return { $not: genPredicate(r, depth - 1, rhs) };
	if (depth > 0 && roll < 0.3)
		return { $and: [genPredicate(r, depth - 1, rhs), genPredicate(r, depth - 1, rhs)] };
	if (depth > 0 && roll < 0.45)
		return { $or: [genPredicate(r, depth - 1, rhs), genPredicate(r, depth - 1, rhs)] };
	const op = pick(r, LEAF_OPS);
	const path = pick(r, PATHS);
	return { [op]: { [path]: rhs(r) } } as unknown as PropertyPredicate;
}

/** Same seed ⇒ same tree; one variant with `$host` leaves, one with the literal. */
function hostAndLiteral(seed: number, hostId: string): [PropertyPredicate, PropertyPredicate] {
	const leaf =
		(asHost: boolean) =>
		(r: () => number): ScalarValue | PropertyRef => {
			if (r() < 0.6) return asHost ? HOST : hostId;
			return pick(r, IDS);
		};
	return [genPredicate(rng(seed), 3, leaf(true)), genPredicate(rng(seed), 3, leaf(false))];
}

describe("$host ref (9.12.24) — property tests", () => {
	const entities = Array.from({ length: 24 }, (_, i) => genEntity(rng(1000 + i), i));

	it("with no host, a host-relative predicate never matches — even negated", () => {
		let checked = 0;
		for (let seed = 1; seed <= 400; seed += 1) {
			const [withHost] = hostAndLiteral(seed, "ent_a");
			if (!predicateReferencesHost(withHost)) continue;
			for (const e of entities) {
				expect(evaluatePredicate(e, withHost, 0)).toBe(false);
				expect(evaluatePredicate(e, { $not: withHost }, 0)).toBe(false);
				expect(evaluatePredicate(e, withHost, 0, {})).toBe(false);
			}
			checked += 1;
		}
		expect(checked).toBeGreaterThan(200);
	});

	it("with a host, `$host` is exactly the literal-id predicate", () => {
		for (let seed = 1; seed <= 400; seed += 1) {
			const hostId = pick(rng(seed * 7), IDS);
			const [withHost, literal] = hostAndLiteral(seed, hostId);
			for (const e of entities) {
				expect(evaluatePredicate(e, withHost, 0, { hostEntityId: hostId })).toBe(
					evaluatePredicate(e, literal, 0),
				);
			}
		}
	});
});

describe("$host ref — examples", () => {
	const book = row("b1", { author: "page_1", editors: ["page_1", "page_2"] });

	it("relation contains this page", () => {
		const pred: PropertyPredicate = { $contains: { editors: HOST } };
		expect(evaluatePredicate(book, pred, 0, { hostEntityId: "page_2" })).toBe(true);
		expect(evaluatePredicate(book, pred, 0, { hostEntityId: "page_9" })).toBe(false);
		expect(evaluatePredicate(book, pred, 0)).toBe(false);
	});

	it("scalar relation is this page", () => {
		const pred: PropertyPredicate = { $eq: { author: HOST } };
		expect(evaluatePredicate(book, pred, 0, { hostEntityId: "page_1" })).toBe(true);
		expect(evaluatePredicate(book, { $neq: { author: HOST } }, 0)).toBe(false);
	});

	it("a predicate without $host is unaffected by the missing host", () => {
		expect(evaluatePredicate(book, { $eq: { author: "page_1" } }, 0)).toBe(true);
	});

	it("threads the host through evaluateSource (byFilter + composite)", () => {
		const db: InMemoryVault = {
			entities: [book, row("b2", { author: "page_2" })],
			links: [],
		};
		const byHost: ListSource = {
			kind: ListSourceKind.ByFilter,
			where: { $eq: { author: HOST } },
		};
		expect([...evaluateSource(byHost, db, { hostEntityId: "page_2" })]).toEqual(["b2"]);
		expect(evaluateSource(byHost, db).size).toBe(0);
		const composite: ListSource = {
			kind: ListSourceKind.Composite,
			op: CompositeOp.Or,
			sources: [byHost, { kind: ListSourceKind.ByType, types: ["io.test/Book/v1"] }],
		};
		expect(evaluateSource(composite, db).size).toBe(2);
	});
});
