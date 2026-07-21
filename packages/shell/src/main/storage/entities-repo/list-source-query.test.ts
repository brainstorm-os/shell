/**
 * 9.12.3 — `ListSource` resolution against a real `entities.db`.
 *
 * Drives the full service path (`queryVaultListSource` → repo fast paths /
 * shared evaluator) and pins the keystone property: for ANY source shape,
 * the shell resolution equals the Database renderer's in-memory
 * `evaluateSource` over the same rows — the two paths share the evaluator
 * for the filter kinds, and the generative parity loop holds the SQL fast
 * paths (`byType`, `byLink`) to the same truth. Property tests follow this
 * repo's established generative-loop convention (no fast-check dependency —
 * see `ipc/envelope.test.ts`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CompositeOp,
	LinkDirection,
	type ListSource,
	ListSourceKind,
} from "@brainstorm-os/sdk-types";
import type { InMemoryVault } from "@brainstorm-os/sdk/in-memory-entities";
import { evaluateSource } from "@brainstorm-os/sdk/predicate-eval";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LIST_SOURCE_MAX_CHILDREN,
	LIST_SOURCE_MAX_DEPTH,
	ListSourceErrorKind,
} from "../../entities/list-source-query";
import { queryVaultListSource } from "../../entities/vault-entities-service";
import { DataStores } from "../data-stores";
import { EntitiesRepository } from "./entities-repo";

const NOTE = "io.x/Note/v1";
const TASK = "io.x/Task/v1";
const BOOK = "io.x/Book/v1";
const TAGGED = "io.x/Tagged/v1";
const OWNS = "io.x/Owns/v1";

let vaultDir = "";
let stores: DataStores;
let repo: EntitiesRepository;

beforeEach(async () => {
	vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-list-source-"));
	stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	repo = new EntitiesRepository(db);
});

afterEach(async () => {
	stores.close();
	await rm(vaultDir, { recursive: true, force: true });
});

function seedEntity(id: string, type: string, properties: Record<string, unknown> = {}): void {
	repo.create({ id, type, properties, createdBy: "io.x", now: 10, dekId: null });
}

function seedLink(id: string, source: string, dest: string, linkType: string): void {
	repo.putLink({ id, sourceEntityId: source, destEntityId: dest, linkType, createdAt: 10 });
}

const getRepo = async () => repo;

async function ids(source: ListSource | null): Promise<string[]> {
	const result = await queryVaultListSource(source, getRepo);
	if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}: ${result.error.message}`);
	return result.ids;
}

describe("queryVaultListSource — kinds against a real entities.db", () => {
	it("byType returns live rows of the listed types and skips soft-deleted ones", async () => {
		seedEntity("n1", NOTE);
		seedEntity("n2", NOTE);
		seedEntity("t1", TASK);
		seedEntity("b1", BOOK);
		repo.softDelete("n2", 20);
		expect(await ids({ kind: ListSourceKind.ByType, types: [NOTE, TASK] })).toEqual(["n1", "t1"]);
	});

	it("byLink resolves Out destinations and In sources, OR across anchors", async () => {
		seedEntity("a", NOTE);
		seedEntity("b", NOTE);
		seedEntity("x", TASK);
		seedEntity("y", TASK);
		seedLink("l1", "a", "x", OWNS);
		seedLink("l2", "b", "y", OWNS);
		seedLink("l3", "a", "y", TAGGED);
		expect(
			await ids({
				kind: ListSourceKind.ByLink,
				linkType: OWNS,
				direction: LinkDirection.Out,
				anchorEntityIds: ["a", "b"],
			}),
		).toEqual(["x", "y"]);
		expect(
			await ids({
				kind: ListSourceKind.ByLink,
				linkType: OWNS,
				direction: LinkDirection.In,
				anchorEntityId: "y",
			}),
		).toEqual(["b"]);
	});

	it("byLink with no anchors resolves to the empty set", async () => {
		seedEntity("a", NOTE);
		expect(
			await ids({ kind: ListSourceKind.ByLink, linkType: OWNS, direction: LinkDirection.Out }),
		).toEqual([]);
	});

	it("byFilter runs the shared predicate evaluator over live rows", async () => {
		seedEntity("n1", NOTE, { status: "open", priority: 2 });
		seedEntity("n2", NOTE, { status: "done", priority: 9 });
		seedEntity("n3", NOTE, { status: "open", priority: 7 });
		expect(
			await ids({
				kind: ListSourceKind.ByFilter,
				where: { $and: [{ $eq: { status: "open" } }, { $gt: { priority: 5 } }] },
			}),
		).toEqual(["n3"]);
	});

	it("byVocabulary matches value envelopes carrying the vocabulary id", async () => {
		seedEntity("n1", NOTE, { tags: [{ vocabularyId: "voc1", value: "red" }] });
		seedEntity("n2", NOTE, { tags: [{ vocabularyId: "voc1", value: "blue" }] });
		seedEntity("n3", NOTE, { tags: [{ vocabularyId: "voc2", value: "red" }] });
		expect(
			await ids({ kind: ListSourceKind.ByVocabulary, vocabularyId: "voc1", values: ["red"] }),
		).toEqual(["n1"]);
		expect(await ids({ kind: ListSourceKind.ByVocabulary, vocabularyId: "voc1" })).toEqual([
			"n1",
			"n2",
		]);
	});

	it("composite AND intersects, OR unions, empty children resolve empty", async () => {
		seedEntity("n1", NOTE, { status: "open" });
		seedEntity("n2", NOTE, { status: "done" });
		seedEntity("t1", TASK, { status: "open" });
		const byNote: ListSource = { kind: ListSourceKind.ByType, types: [NOTE] };
		const open: ListSource = { kind: ListSourceKind.ByFilter, where: { $eq: { status: "open" } } };
		expect(
			await ids({ kind: ListSourceKind.Composite, op: CompositeOp.And, sources: [byNote, open] }),
		).toEqual(["n1"]);
		expect(
			await ids({ kind: ListSourceKind.Composite, op: CompositeOp.Or, sources: [byNote, open] }),
		).toEqual(["n1", "n2", "t1"]);
		expect(await ids({ kind: ListSourceKind.Composite, op: CompositeOp.And, sources: [] })).toEqual(
			[],
		);
	});

	it("a null source resolves to the empty set (Manual list)", async () => {
		seedEntity("n1", NOTE);
		expect(await ids(null)).toEqual([]);
	});
});

describe("queryVaultListSource — validation fails closed", () => {
	async function errorOf(source: unknown) {
		const result = await queryVaultListSource(source, getRepo);
		if (result.ok) throw new Error("expected a rejection");
		return result.error;
	}

	it("rejects an unknown kind and malformed shapes as source-invalid", async () => {
		expect((await errorOf({ kind: "nope" })).kind).toBe(ListSourceErrorKind.Invalid);
		expect((await errorOf({ kind: ListSourceKind.ByType, types: "x" })).kind).toBe(
			ListSourceErrorKind.Invalid,
		);
		expect((await errorOf({ kind: ListSourceKind.ByFilter, where: null })).kind).toBe(
			ListSourceErrorKind.Invalid,
		);
		expect(
			(
				await errorOf({
					kind: ListSourceKind.ByLink,
					linkType: OWNS,
					direction: "sideways",
				})
			).kind,
		).toBe(ListSourceErrorKind.Invalid);
		expect((await errorOf(42)).kind).toBe(ListSourceErrorKind.Invalid);
	});

	it("rejects beyond-cap composites as source-too-expensive", async () => {
		// Depth: nest one past the ceiling.
		let nested: Record<string, unknown> = { kind: ListSourceKind.ByType, types: [NOTE] };
		for (let i = 0; i <= LIST_SOURCE_MAX_DEPTH; i += 1) {
			nested = { kind: ListSourceKind.Composite, op: CompositeOp.Or, sources: [nested] };
		}
		expect((await errorOf(nested)).kind).toBe(ListSourceErrorKind.TooExpensive);

		const wide = {
			kind: ListSourceKind.Composite,
			op: CompositeOp.Or,
			sources: new Array(LIST_SOURCE_MAX_CHILDREN + 1).fill({
				kind: ListSourceKind.ByType,
				types: [NOTE],
			}),
		};
		expect((await errorOf(wide)).kind).toBe(ListSourceErrorKind.TooExpensive);
	});
});

describe("queryVaultListSource — parity with the in-memory evaluator", () => {
	// Deterministic PRNG (mulberry32) — reproducible generative loop.
	function rng(seed: number): () => number {
		let a = seed;
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	const TYPES = [NOTE, TASK, BOOK];
	const STATUSES = ["open", "done", "blocked"];
	const LINK_TYPES = [OWNS, TAGGED];

	function pick<T>(r: () => number, list: readonly T[]): T {
		const v = list[Math.floor(r() * list.length)];
		if (v === undefined) throw new Error("pick on empty list");
		return v;
	}

	function randomSource(r: () => number, depth: number, entityIds: string[]): ListSource {
		const roll = r();
		if (depth < 2 && roll < 0.25) {
			const count = 1 + Math.floor(r() * 3);
			return {
				kind: ListSourceKind.Composite,
				op: r() < 0.5 ? CompositeOp.And : CompositeOp.Or,
				sources: Array.from({ length: count }, () => randomSource(r, depth + 1, entityIds)),
			};
		}
		if (roll < 0.45) return { kind: ListSourceKind.ByType, types: [pick(r, TYPES)] };
		if (roll < 0.65) {
			return {
				kind: ListSourceKind.ByFilter,
				where:
					r() < 0.5
						? { $eq: { status: pick(r, STATUSES) } }
						: { $gt: { priority: Math.floor(r() * 10) } },
			};
		}
		if (roll < 0.85) {
			return {
				kind: ListSourceKind.ByLink,
				linkType: pick(r, LINK_TYPES),
				direction: r() < 0.5 ? LinkDirection.Out : LinkDirection.In,
				anchorEntityIds: [pick(r, entityIds), pick(r, entityIds)],
			};
		}
		return {
			kind: ListSourceKind.ByVocabulary,
			vocabularyId: "voc1",
			// exactOptionalPropertyTypes — omit `values` rather than set undefined.
			...(r() < 0.5 ? { values: [pick(r, STATUSES)] } : {}),
		};
	}

	it("shell resolution equals evaluateSource over the same rows (40 rounds)", async () => {
		const r = rng(0xc0ffee);
		const entityIds: string[] = [];
		const vault: {
			entities: InMemoryVault["entities"][number][];
			links: InMemoryVault["links"][number][];
		} = {
			entities: [],
			links: [],
		};

		for (let i = 0; i < 60; i += 1) {
			const id = `e${i}`;
			const type = pick(r, TYPES);
			const properties: Record<string, unknown> = {
				status: pick(r, STATUSES),
				priority: Math.floor(r() * 10),
				...(r() < 0.4 ? { tags: [{ vocabularyId: "voc1", value: pick(r, STATUSES) }] } : {}),
			};
			seedEntity(id, type, properties);
			vault.entities.push({
				id,
				type,
				properties,
				createdAt: 10,
				updatedAt: 10,
				deletedAt: null,
			});
			entityIds.push(id);
		}
		for (let i = 0; i < 80; i += 1) {
			const source = pick(r, entityIds);
			const dest = pick(r, entityIds);
			const linkType = pick(r, LINK_TYPES);
			seedLink(`l${i}`, source, dest, linkType);
			vault.links.push({
				id: `l${i}`,
				sourceEntityId: source,
				destEntityId: dest,
				linkType,
				createdAt: 10,
				deletedAt: null,
			});
		}

		for (let round = 0; round < 40; round += 1) {
			const source = randomSource(r, 0, entityIds);
			const expected = [...evaluateSource(source, vault)].sort();
			const actual = await ids(source);
			expect(actual, `round ${round}: ${JSON.stringify(source)}`).toEqual(expected);
		}
	});
});
