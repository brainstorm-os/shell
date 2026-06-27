/**
 * 11b.6 deploy residue (b) — the post-commit entity-change emitter and the
 * entities-service hook feeding it. Security posture under test: emission
 * happens ONLY for authorized, committed writes; a faulty listener can
 * never fail the data path; the payload carries identifiers only.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntityEventVerb } from "@brainstorm/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import type { CapabilityLedger } from "../capabilities/ledger";
import { generateSymmetricKey } from "../credentials/crypto";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";
import { makeEntitiesServiceHandler } from "./entities-service";
import { type EntityChange, EntityChangeEmitter } from "./entity-change-emitter";
import { EntityDekStore } from "./entity-dek-store";

function fakeLedger(grants: string[]): CapabilityLedger {
	return {
		has(_app: string, required: string): boolean {
			const [cap] = required.split(":");
			return grants.includes(required) || grants.includes(`${cap}:*`);
		},
	} as unknown as CapabilityLedger;
}

function env(method: string, arg: unknown): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m",
		app: "io.test.app",
		service: "entities",
		method,
		args: [arg],
		caps: [],
	};
}

describe("EntityChangeEmitter", () => {
	const change: EntityChange = {
		verb: EntityEventVerb.Create,
		entityId: "ent_1",
		type: "brainstorm/Note/v1",
	};

	it("delivers to every subscriber and honours unsubscribe", () => {
		const emitter = new EntityChangeEmitter();
		const seenA: EntityChange[] = [];
		const seenB: EntityChange[] = [];
		const offA = emitter.subscribe((c) => seenA.push(c));
		emitter.subscribe((c) => seenB.push(c));
		emitter.emit(change);
		offA();
		emitter.emit(change);
		expect(seenA).toHaveLength(1);
		expect(seenB).toHaveLength(2);
	});

	it("isolates a throwing listener — later listeners still receive", () => {
		const errors: unknown[] = [];
		const emitter = new EntityChangeEmitter((e) => errors.push(e));
		const seen: EntityChange[] = [];
		emitter.subscribe(() => {
			throw new Error("boom");
		});
		emitter.subscribe((c) => seen.push(c));
		expect(() => emitter.emit(change)).not.toThrow();
		expect(seen).toHaveLength(1);
		expect(errors).toHaveLength(1);
	});
});

describe("entities service — post-commit change hook", () => {
	let vaultDir: string;
	let stores: DataStores;
	let changes: EntityChange[];
	let grants: string[];
	let handler: ReturnType<typeof makeEntitiesServiceHandler>;
	let ids: number;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-ent-change-"));
		stores = new DataStores(vaultDir);
		const db = await stores.open("entities");
		const repo = new EntitiesRepository(db);
		const dekStore = new EntityDekStore(new EntityDeksRepository(db), generateSymmetricKey());
		changes = [];
		grants = ["entities.read:*", "entities.write:*"];
		ids = 0;
		handler = makeEntitiesServiceHandler({
			getRepo: async () => repo,
			getLedger: async () => fakeLedger(grants),
			getDekStore: async () => dekStore,
			newId: () => `ent_${++ids}`,
			now: () => 1000,
			onEntityChange: (c) => changes.push(c),
		});
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("emits Create/Update/Delete with identifiers only, post-commit", async () => {
		const created = (await handler(
			env("create", { type: "brainstorm/Note/v1", properties: { title: "secret" } }),
		)) as { id: string };
		await handler(env("update", { id: created.id, patch: { title: "still secret" } }));
		await handler(env("delete", { id: created.id }));

		expect(changes).toEqual([
			{ verb: EntityEventVerb.Create, entityId: created.id, type: "brainstorm/Note/v1" },
			{ verb: EntityEventVerb.Update, entityId: created.id, type: "brainstorm/Note/v1" },
			{ verb: EntityEventVerb.Delete, entityId: created.id, type: "brainstorm/Note/v1" },
		]);
		// Identifiers only — no property values ride the change payload.
		for (const c of changes) {
			expect(Object.keys(c).sort()).toEqual(["entityId", "type", "verb"]);
		}
	});

	it("does NOT emit for a denied write (fail-closed)", async () => {
		grants = ["entities.read:*"];
		await expect(
			handler(env("create", { type: "brainstorm/Note/v1", properties: {} })),
		).rejects.toThrow(/Denied|no entities.write/);
		expect(changes).toHaveLength(0);
	});

	it("does NOT emit for an idempotent delete of a missing entity", async () => {
		await handler(env("delete", { id: "ent_missing" }));
		expect(changes).toHaveLength(0);
	});

	it("a throwing hook never fails the committed write", async () => {
		const db = await stores.open("entities");
		const repo = new EntitiesRepository(db);
		const dekStore = new EntityDekStore(new EntityDeksRepository(db), generateSymmetricKey());
		const throwing = makeEntitiesServiceHandler({
			getRepo: async () => repo,
			getLedger: async () => fakeLedger(grants),
			getDekStore: async () => dekStore,
			newId: () => `ent_t_${++ids}`,
			now: () => 1000,
			onEntityChange: () => {
				throw new Error("listener boom");
			},
		});
		const created = (await throwing(
			env("create", { type: "brainstorm/Note/v1", properties: {} }),
		)) as { id: string };
		expect(created.id).toBeTruthy();
		const got = await throwing(env("get", { id: created.id }));
		expect(got).not.toBeNull();
	});
});
