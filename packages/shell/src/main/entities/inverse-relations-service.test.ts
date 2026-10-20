import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { LinkSkipReason, type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { afterEach, describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { generateSymmetricKey } from "../credentials/crypto";
import { makePropertiesServiceHandler } from "../properties/properties-service";
import type { PropertiesStore } from "../properties/properties-store";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";
import { removeTestDir } from "../test-support/remove-test-dir";
import {
	type InverseBackfillFn,
	MAX_FAR_WRITES_PER_CALL,
	makeEntitiesServiceHandler,
} from "./entities-service";
import { EntityDekStore } from "./entity-dek-store";

const BOOK = "io.test/Book/v1";
const PERSON = "io.test/Person/v1";
const MANY = { count: { min: 0, max: 50 } };

function ref(key: string, extra: Partial<PropertyDef> = {}): PropertyDef {
	return { key, name: key, icon: null, valueType: ValueType.EntityRef, ...extra };
}

function ledger(grants: string[]): CapabilityLedger {
	return {
		has: (_app: string, required: string) =>
			grants.includes(required) || grants.includes(`${required.split(":")[0]}:*`),
	} as unknown as CapabilityLedger;
}

function env(method: string, arg: unknown, service = "entities"): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m",
		app: "io.test.app",
		service,
		method,
		args: [arg],
		caps: [],
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

async function setup(
	opts: {
		grants?: string[];
		defs?: PropertyDef[];
		onChange?: (entityId: string, repo: EntitiesRepository) => void;
	} = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "brainstorm-inverse-"));
	const stores = new DataStores(dir);
	const db = await stores.open("entities");
	const repo = new EntitiesRepository(db);
	const dekStore = new EntityDekStore(new EntityDeksRepository(db), generateSymmetricKey());
	let defs: PropertyDef[] = opts.defs ?? [
		ref("authors", { ...MANY, inverseOf: "books" }),
		ref("books", MANY),
	];
	let backfill: InverseBackfillFn | null = null;
	let n = 0;
	const handler = makeEntitiesServiceHandler({
		getRepo: async () => repo,
		getLedger: async () => ledger(opts.grants ?? ["entities.read:*", "entities.write:*"]),
		getDekStore: async () => dekStore,
		newId: () => `ent_${++n}`,
		now: () => 1000,
		getPropertyDefs: async () => defs,
		bindInverseBackfill: (fn) => {
			backfill = fn;
		},
		onEntityChange: (change) => opts.onChange?.(change.entityId, repo),
	});
	cleanups.push(async () => {
		stores.close();
		await removeTestDir(dir);
	});
	const call = (method: string, arg: unknown) => handler(env(method, arg));
	const props = (id: string) => repo.get(id)?.properties ?? null;
	const create = async (id: string, type: string, properties: Record<string, unknown> = {}) =>
		call("create", { id, type, properties });
	return {
		repo,
		call,
		props,
		create,
		setDefs: (next: PropertyDef[]) => {
			defs = next;
		},
		backfill: () => backfill as unknown as InverseBackfillFn,
	};
}

describe("two-way relations through the entities service (9.12.25)", () => {
	it("mirrors an add and a remove onto the far end", async () => {
		const t = await setup();
		await t.create("p1", PERSON);
		await t.create("p2", PERSON);
		await t.create("b1", BOOK, { authors: [{ value: "p1" }] });
		expect(t.props("p1")?.books).toEqual([{ value: "b1" }]);

		await t.call("update", { id: "b1", patch: { authors: [{ value: "p2" }] } });
		expect(t.props("p1")?.books).toEqual([]);
		expect(t.props("p2")?.books).toEqual([{ value: "b1" }]);

		await t.call("update", { id: "p2", patch: { books: [] } });
		expect(t.props("b1")?.authors).toEqual([]);
	});

	it("deleting either end cleans the pair", async () => {
		const t = await setup();
		await t.create("p1", PERSON);
		await t.create("b1", BOOK, { authors: [{ value: "p1" }] });
		await t.create("b2", BOOK, { authors: [{ value: "p1" }] });
		await t.call("delete", { id: "b1" });
		expect(t.props("p1")?.books).toEqual([{ value: "b2" }]);
		await t.call("delete", { id: "p1" });
		expect(t.props("b2")?.authors).toEqual([]);
	});

	it("a locked far end refuses the whole write — nothing is half-applied", async () => {
		const t = await setup();
		await t.create("p1", PERSON);
		await t.create("p2", PERSON, { locked: true });
		await t.create("b1", BOOK, {});
		await expect(
			t.call("update", { id: "b1", patch: { authors: [{ value: "p1" }, { value: "p2" }] } }),
		).rejects.toMatchObject({ name: "Denied" });
		expect(t.props("b1")?.authors).toBeUndefined();
		expect(t.props("p1")?.books).toBeUndefined();
		expect(t.props("p2")?.books).toBeUndefined();
		await expect(t.create("b2", BOOK, { authors: [{ value: "p2" }] })).rejects.toMatchObject({
			name: "Denied",
		});
		expect(t.props("b2")).toBeNull();
	});

	it("a far end the caller can't write refuses the write", async () => {
		const t = await setup({
			grants: ["entities.read:*", `entities.write:${BOOK}`],
		});
		t.repo.create({ id: "p1", type: PERSON, properties: {}, createdBy: "x", now: 1, dekId: null });
		await t.create("b1", BOOK, {});
		await expect(
			t.call("update", { id: "b1", patch: { authors: [{ value: "p1" }] } }),
		).rejects.toMatchObject({ name: "Denied" });
		expect(t.props("b1")?.authors).toBeUndefined();
	});

	it("unpaired relations stay one-way", async () => {
		const t = await setup({ defs: [ref("authors", MANY), ref("books", MANY)] });
		await t.create("p1", PERSON);
		await t.create("b1", BOOK, { authors: [{ value: "p1" }] });
		expect(t.props("p1")?.books).toBeUndefined();
	});

	it("backfills when a pair is first declared, via the properties service", async () => {
		const t = await setup({ defs: [ref("authors", MANY), ref("books", MANY)] });
		await t.create("p1", PERSON);
		await t.create("b1", BOOK, { authors: [{ value: "p1" }] });
		const saved: PropertyDef[] = [];
		const store = {
			snapshot: () => ({ properties: { authors: ref("authors", MANY) }, dictionaries: {} }),
			setProperty: (d: PropertyDef) => saved.push(d),
		} as unknown as PropertiesStore;
		const properties = makePropertiesServiceHandler({
			getStore: async () => store,
			backfillInverse: (app, def) => t.backfill()(app, def),
			canWriteType: async () => true,
		});
		const paired = ref("authors", { ...MANY, inverseOf: "books" });
		await properties(env("setProperty", { def: paired }, "properties"));
		expect(t.props("p1")?.books).toEqual([{ value: "b1" }]);
		expect(saved).toEqual([paired]);
	});

	it("a backfill that would touch a locked entity refuses and saves nothing", async () => {
		const t = await setup({ defs: [ref("authors", MANY), ref("books", MANY)] });
		await t.create("p1", PERSON, { locked: true });
		await t.create("b1", BOOK, { authors: [{ value: "p1" }] });
		const saved: PropertyDef[] = [];
		const store = {
			snapshot: () => ({ properties: {}, dictionaries: {} }),
			setProperty: (d: PropertyDef) => saved.push(d),
		} as unknown as PropertiesStore;
		const properties = makePropertiesServiceHandler({
			getStore: async () => store,
			backfillInverse: (app, def) => t.backfill()(app, def),
			canWriteType: async () => true,
		});
		await expect(
			properties(
				env("setProperty", { def: ref("authors", { ...MANY, inverseOf: "books" }) }, "properties"),
			),
		).rejects.toMatchObject({ name: "Denied" });
		expect(saved).toEqual([]);
		expect(t.props("p1")?.books).toBeUndefined();
	});

	it("an app that cannot write the pair's types cannot declare inverseOf (steering others' writes)", async () => {
		const t = await setup({ defs: [ref("project", { allowedTypes: [BOOK] }), ref("owner")] });
		const saved: PropertyDef[] = [];
		const store = {
			snapshot: () => ({
				properties: { project: ref("project", { allowedTypes: [BOOK] }), owner: ref("owner") },
				dictionaries: {},
			}),
			setProperty: (d: PropertyDef) => saved.push(d),
		} as unknown as PropertiesStore;
		const grants = new Set([`entities.write:${PERSON}`]);
		const properties = makePropertiesServiceHandler({
			getStore: async () => store,
			backfillInverse: (app, def) => t.backfill()(app, def),
			canWriteType: async (_app, type) => grants.has(`entities.write:${type}`),
		});
		const set = (def: PropertyDef) => properties(env("setProperty", { def }, "properties"));
		await expect(
			set(ref("project", { allowedTypes: [BOOK], inverseOf: "owner" })),
		).rejects.toMatchObject({ name: "Denied" });
		grants.add(`entities.write:${BOOK}`);
		// `owner` targets any type — pairing it needs the unrestricted grant.
		await expect(
			set(ref("project", { allowedTypes: [BOOK], inverseOf: "owner" })),
		).rejects.toMatchObject({ name: "Denied" });
		grants.add("entities.write:*");
		await set(ref("project", { allowedTypes: [BOOK], inverseOf: "owner" }));
		expect(saved).toHaveLength(1);
		// No ledger seam wired → declaring a pair fails closed.
		const unwired = makePropertiesServiceHandler({ getStore: async () => store });
		await expect(
			unwired(env("setProperty", { def: ref("x", { inverseOf: "owner" }) }, "properties")),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("a reserved key can never be a pair member", async () => {
		const store = {
			snapshot: () => ({ properties: {}, dictionaries: {} }),
			setProperty: () => {},
		} as unknown as PropertiesStore;
		const properties = makePropertiesServiceHandler({
			getStore: async () => store,
			canWriteType: async () => true,
		});
		for (const def of [
			ref("rel", { inverseOf: "agentProvenance" }),
			ref("agentProposal", { inverseOf: "rel" }),
		]) {
			await expect(properties(env("setProperty", { def }, "properties"))).rejects.toMatchObject({
				name: "Invalid",
			});
		}
	});

	it("far writes never touch reserved keys, even from a catalog that pairs one", async () => {
		const t = await setup({
			defs: [ref("rel", { inverseOf: "agentProvenance" }), ref("agentProvenance")],
		});
		t.repo.create({
			id: "agentmade",
			type: PERSON,
			properties: {
				agentProvenance: { agent: "io.brainstorm.agent", conversationId: "c", createdAt: 1 },
			},
			createdBy: "x",
			now: 1,
			dekId: null,
		});
		await t.create("mine", BOOK, { rel: "agentmade" });
		expect(t.props("agentmade")?.agentProvenance).toEqual({
			agent: "io.brainstorm.agent",
			conversationId: "c",
			createdAt: 1,
		});
	});

	it("a far end the caller cannot read is skipped, never named (no existence oracle)", async () => {
		const t = await setup({ grants: [`entities.read:${BOOK}`, `entities.write:${BOOK}`] });
		t.repo.create({
			id: "secret",
			type: PERSON,
			properties: {},
			createdBy: "x",
			now: 1,
			dekId: null,
		});
		await t.create("b1", BOOK, { authors: [{ value: "secret" }] });
		expect(t.props("secret")?.books).toBeUndefined();
	});

	it("a refused far end does not name its type or id", async () => {
		const t = await setup({ grants: ["entities.read:*", `entities.write:${BOOK}`] });
		t.repo.create({ id: "p1", type: PERSON, properties: {}, createdBy: "x", now: 1, dekId: null });
		const err = await t.create("b1", BOOK, { authors: [{ value: "p1" }] }).catch((e: Error) => e);
		expect(err).toMatchObject({ name: "Denied" });
		expect((err as Error).message).not.toContain("p1");
		expect((err as Error).message).not.toContain(PERSON);
	});

	it("caps the far writes one call may fan out to", async () => {
		const t = await setup();
		const ids: Array<{ value: string }> = [];
		for (let i = 0; i < MAX_FAR_WRITES_PER_CALL + 1; i++) {
			t.repo.create({
				id: `p${i}`,
				type: PERSON,
				properties: {},
				createdBy: "x",
				now: 1,
				dekId: null,
			});
			ids.push({ value: `p${i}` });
		}
		await expect(t.create("b1", BOOK, { authors: ids })).rejects.toMatchObject({ name: "Invalid" });
		expect(t.props("b1")).toBeNull();
	});

	it("concurrent creates that both link one far end keep both back-links", async () => {
		const t = await setup();
		await t.create("p1", PERSON);
		await Promise.all([
			t.create("b1", BOOK, { authors: [{ value: "p1" }] }),
			t.create("b2", BOOK, { authors: [{ value: "p1" }] }),
			t.create("b3", BOOK, { authors: [{ value: "p1" }] }),
		]);
		const ids = ((t.props("p1")?.books ?? []) as Array<{ value: string }>).map((v) => v.value).sort();
		expect(ids).toEqual(["b1", "b2", "b3"]);
	});

	it("a far end whose type is outside the pair's allowedTypes is refused", async () => {
		const NOTE = "io.test/Note/v1";
		const t = await setup({
			defs: [
				ref("authors", { ...MANY, allowedTypes: [PERSON], inverseOf: "books" }),
				ref("books", { ...MANY, allowedTypes: [BOOK] }),
			],
		});
		t.repo.create({ id: "n1", type: NOTE, properties: {}, createdBy: "x", now: 1, dekId: null });
		await t.create("p1", PERSON);
		await expect(t.create("b1", BOOK, { authors: [{ value: "n1" }] })).rejects.toMatchObject({
			name: "Denied",
		});
		expect(t.props("n1")?.books).toBeUndefined();
		expect(t.props("b1")).toBeNull();
		await t.create("b2", BOOK, { authors: [{ value: "p1" }] });
		expect(t.props("p1")?.books).toEqual([{ value: "b2" }]);
	});

	it("a far end locked after planning is skipped AND reported in the result", async () => {
		const t = await setup({
			onChange: (id, repo) => {
				if (id === "b1") repo.update("p1", { locked: true }, 2000);
			},
		});
		await t.create("p1", PERSON);
		const made = (await t.create("b1", BOOK, { authors: [{ value: "p1" }] })) as {
			skippedLinks?: Array<{ entityId: string; reason: string }>;
		};
		expect(t.props("p1")?.books).toBeUndefined();
		expect(made.skippedLinks).toEqual([{ entityId: "p1", reason: LinkSkipReason.Locked }]);
	});

	describe("re-shaping a paired def passes the pair gate (old AND new allowedTypes)", () => {
		const paired = {
			authors: ref("authors", { ...MANY, allowedTypes: [PERSON], inverseOf: "books" }),
			books: ref("books", { ...MANY, allowedTypes: [PERSON] }),
			loose: ref("loose", { allowedTypes: [PERSON] }),
		};
		function service(grants: Set<string>) {
			const saved: PropertyDef[] = [];
			const store = {
				snapshot: () => ({ properties: paired, dictionaries: {} }),
				setProperty: (d: PropertyDef) => saved.push(d),
			} as unknown as PropertiesStore;
			const handler = makePropertiesServiceHandler({
				getStore: async () => store,
				canWriteType: async (_app, type) => grants.has(type),
			});
			return {
				saved,
				set: (def: PropertyDef) => handler(env("setProperty", { def }, "properties")),
			};
		}

		it("an app that can write only its own type cannot narrow a pair onto it", async () => {
			const { set, saved } = service(new Set([BOOK]));
			for (const def of [
				{ ...paired.authors, allowedTypes: [BOOK] },
				{ ...paired.books, allowedTypes: [BOOK] },
				{ ...paired.books, allowedTypes: undefined },
				{ ...paired.books, valueType: ValueType.Text },
				{ ...paired.books, count: { min: 0, max: 1 } },
			] as PropertyDef[]) {
				await expect(set(def)).rejects.toMatchObject({ name: "Denied" });
			}
			expect(saved).toEqual([]);
		});

		it("holding every linked type (old and new) allows it; an unpaired def is not gated", async () => {
			const { set, saved } = service(new Set([BOOK, PERSON]));
			await set({ ...paired.books, allowedTypes: [BOOK] });
			await set({ ...paired.books, name: "Renamed" });
			const loose = service(new Set());
			await loose.set({ ...paired.loose, allowedTypes: [BOOK] });
			expect(saved).toHaveLength(2);
			expect(loose.saved).toHaveLength(1);
		});
	});

	describe("entities.merge", () => {
		it("strips reserved keys from the merge patch", async () => {
			const t = await setup({ defs: [] });
			await t.create("s1", BOOK, { title: "S" });
			await t.create("l1", BOOK, { title: "L" });
			await t.call("merge", {
				survivorId: "s1",
				loserIds: ["l1"],
				patch: {
					title: "Merged",
					agentProvenance: { agent: "io.brainstorm.agent", conversationId: "c", createdAt: 1 },
					agentProposal: { forged: true },
				},
			});
			expect(t.props("s1")?.title).toBe("Merged");
			expect(t.props("s1")).not.toHaveProperty("agentProvenance");
			expect(t.props("s1")).not.toHaveProperty("agentProposal");
		});

		it("never rewrites a locked referrer (a locked List keeps its members) and reports it", async () => {
			const LIST = "brainstorm/List/v1";
			const t = await setup({ defs: [] });
			await t.create("s1", BOOK, { title: "S" });
			await t.create("l1", BOOK, { title: "L" });
			const members = { include: [{ entityId: "l1", addedAt: 1, by: "user" }], exclude: [] };
			t.repo.create({
				id: "list1",
				type: LIST,
				properties: { name: "Locked", members, pinned: [{ entityId: "l1" }], locked: true },
				createdBy: "x",
				now: 1,
				dekId: null,
			});
			const result = (await t.call("merge", { survivorId: "s1", loserIds: ["l1"] })) as {
				refsRewritten: number;
				lockedReferrers: number;
			};
			expect(t.props("list1")?.members).toEqual(members);
			expect(t.props("list1")?.pinned).toEqual([{ entityId: "l1" }]);
			expect(result.refsRewritten).toBe(0);
			expect(result.lockedReferrers).toBe(1);
		});
	});

	it("the far-end cap is per call, across every paired key", async () => {
		const t = await setup({
			defs: [
				ref("authors", { ...MANY, count: { min: 0, max: 500 }, inverseOf: "books" }),
				ref("books", MANY),
				ref("editors", { ...MANY, count: { min: 0, max: 500 }, inverseOf: "edited" }),
				ref("edited", MANY),
			],
		});
		const half = Math.ceil((MAX_FAR_WRITES_PER_CALL + 1) / 2) + 10;
		const authors: Array<{ value: string }> = [];
		const editors: Array<{ value: string }> = [];
		for (let i = 0; i < half; i++) {
			for (const [prefix, list] of [
				["a", authors],
				["e", editors],
			] as const) {
				t.repo.create({
					id: `${prefix}${i}`,
					type: PERSON,
					properties: {},
					createdBy: "x",
					now: 1,
					dekId: null,
				});
				list.push({ value: `${prefix}${i}` });
			}
		}
		await t.create("b1", BOOK, {});
		await expect(t.call("update", { id: "b1", patch: { authors, editors } })).rejects.toMatchObject({
			name: "Invalid",
		});
		expect(t.props("b1")?.authors).toBeUndefined();
		await expect(t.create("b2", BOOK, { authors, editors })).rejects.toMatchObject({
			name: "Invalid",
		});
		expect(t.props("b2")).toBeNull();
	});

	describe("pair gate edge cases (properties.setProperty / removeProperty)", () => {
		function service(catalog: Record<string, PropertyDef>, grants: Set<string>) {
			const saved: PropertyDef[] = [];
			const removed: string[] = [];
			const store = {
				snapshot: () => ({ properties: catalog, dictionaries: {} }),
				setProperty: (d: PropertyDef) => saved.push(d),
				removeProperty: (k: string) => removed.push(k),
			} as unknown as PropertiesStore;
			const handler = makePropertiesServiceHandler({
				getStore: async () => store,
				canWriteType: async (_app, type) => grants.has(type),
			});
			return {
				saved,
				removed,
				set: (def: PropertyDef) => handler(env("setProperty", { def }, "properties")),
				remove: (key: string) => handler(env("removeProperty", { key }, "properties")),
			};
		}

		it("refuses a reserved key as the key of ANY def, paired or not", async () => {
			const s = service({}, new Set(["*"]));
			for (const key of ["agentProvenance", "createdByAgent", "agentProposal", "agentDelegatedBy"]) {
				await expect(s.set(ref(key))).rejects.toMatchObject({ name: "Invalid" });
			}
			expect(s.saved).toEqual([]);
		});

		it("declaring inverseOf onto a partner not in the catalog yet is gated as any type", async () => {
			const s = service({}, new Set([BOOK]));
			await expect(
				s.set(ref("authors", { allowedTypes: [BOOK], inverseOf: "later" })),
			).rejects.toMatchObject({ name: "Denied" });
			expect(s.saved).toEqual([]);
		});

		it("creating the def an existing one names as its partner passes the full gate", async () => {
			const s = service(
				{ authors: ref("authors", { allowedTypes: [BOOK], inverseOf: "later" }) },
				new Set([BOOK]),
			);
			await expect(s.set(ref("later"))).rejects.toMatchObject({ name: "Denied" });
			expect(s.saved).toEqual([]);
		});

		it("removing half of a pair is gated like declaring it", async () => {
			const catalog = {
				authors: ref("authors", { allowedTypes: [PERSON], inverseOf: "books" }),
				books: ref("books", { allowedTypes: [PERSON] }),
				loose: ref("loose"),
			};
			const narrow = service(catalog, new Set([BOOK]));
			await expect(narrow.remove("books")).rejects.toMatchObject({ name: "Denied" });
			await expect(narrow.remove("authors")).rejects.toMatchObject({ name: "Denied" });
			await narrow.remove("loose");
			expect(narrow.removed).toEqual(["loose"]);
			const wide = service(catalog, new Set([PERSON]));
			await wide.remove("books");
			expect(wide.removed).toEqual(["books"]);
		});
	});
});
