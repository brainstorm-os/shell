/**
 * In-process integration test (CLAUDE.md §4) for the Collab-C5 collection-share
 * cascade's LIVE seam: a real `entities.create` on the real entities service →
 * the real `EntityChangeEmitter` the shell wires at boot → the real
 * `createAutoShareReactor` → `SharingEngine.autoShareNewChild`.
 *
 * The two ends of this chain were each unit-tested and the cascade itself is
 * proven against real entities in `sharing-engine-collection.test.ts`, but
 * nothing joined them: the reactor's own tests drive a hand-built emitter, and
 * the engine test calls `autoShareNewChild` directly ("the create-hook would
 * call this"). That left the one line of production wiring -
 * `createAutoShareReactor(automationsChangeEmitter, …)` in `main/index.ts` -
 * unproven, which is exactly the shape of "shipped but unwired".
 *
 * What this pins:
 *   - a Message created under a channel cascades, carrying the CONTAINER id;
 *   - the containment registry is consulted on the real create verb, so an
 *     unrelated type never reaches the engine;
 *   - a child with no container property is ignored;
 *   - a cascade failure cannot escape as an unhandled rejection (this runs on
 *     a security-critical path behind a fire-and-forget subscribe).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger as CapabilityLedgerType } from "@brainstorm-os/capabilities/ledger";
import { MESSAGE_TYPE_URL } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __ydocCacheResetForTest, handleYDocEnvelope } from "../../workers/ydoc";
import { createAutoShareReactor } from "../collab/auto-share-reactor";
import type { SharingEngine } from "../collab/sharing-engine";
import { generateSymmetricKey } from "../credentials/crypto";
import { makeEntitiesServiceHandler } from "../entities/entities-service";
import { EntityChangeEmitter } from "../entities/entity-change-emitter";
import { EntityDekStore } from "../entities/entity-dek-store";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";

const CHAT_APP = "io.brainstorm.chat";
const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";
const CHANNEL_ID = "ent_channel_general";

function fakeLedger(): CapabilityLedgerType {
	return { has: () => true } as unknown as CapabilityLedgerType;
}

type Cascade = { childId: string; childType: string; containerId: string };

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-autoshare-"));
	const stores = new DataStores(vaultDir);
	const repo = new EntitiesRepository(await stores.open("entities"));
	const dekStore = new EntityDekStore(
		new EntityDeksRepository(await stores.open("entities")),
		generateSymmetricKey(),
	);

	let idSeq = 0;
	// The production wiring: every committed change fans out through ONE
	// process-singleton emitter (main/index.ts `automationsChangeEmitter`).
	const changes = new EntityChangeEmitter();
	const entitiesHandler = makeEntitiesServiceHandler({
		getRepo: async () => repo,
		getLedger: async () => fakeLedger(),
		getDekStore: async () => dekStore,
		newId: () => {
			idSeq += 1;
			return `ent_auto_${idSeq}`;
		},
		getVaultPath: () => vaultDir,
		onEntityChange: (change) => changes.emit(change),
		ydoc: async (method, a) => {
			const reply = await handleYDocEnvelope({
				v: 1,
				msg: "y",
				app: "io.brainstorm.shell",
				service: "ydoc",
				method,
				args: [a],
				caps: [],
			});
			if (!reply.ok) throw new Error(`ydoc.${method} failed: ${reply.error.message}`);
			return reply.value;
		},
	});

	const cascades: Cascade[] = [];
	const errors: unknown[] = [];
	let cascadeThrows = false;
	const engine = {
		autoShareNewChild: async (childId: string, childType: string, containerId: string) => {
			if (cascadeThrows) throw new Error("relay unavailable");
			cascades.push({ childId, childType, containerId });
			return 1;
		},
	} as unknown as SharingEngine;

	// The production reactor, over the production emitter + repo reads.
	const off = createAutoShareReactor(changes, {
		getEngine: () => engine,
		readEntityProperties: async (entityId) => repo.get(entityId)?.properties ?? null,
		onError: (error) => errors.push(error),
	});

	const create = async (type: string, properties: Record<string, unknown>) => {
		const reply = (await entitiesHandler({
			v: 1,
			msg: "m",
			app: CHAT_APP,
			service: "entities",
			method: "create",
			args: [{ type, properties }],
			caps: ["entities.read:*", "entities.write:*"],
		})) as { id?: string } | null;
		// The reactor is fire-and-forget off the emit; let its microtask chain run.
		await new Promise((r) => setTimeout(r, 0));
		return reply?.id ?? "";
	};

	return {
		vaultDir,
		stores,
		cascades,
		errors,
		create,
		off,
		setCascadeThrows: (v: boolean) => {
			cascadeThrows = v;
		},
	};
}

describe("Collab-C5 auto-share cascade - the real entities.create → reactor seam", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		__ydocCacheResetForTest();
		env = await setup();
	});

	afterEach(async () => {
		env.off();
		__ydocCacheResetForTest();
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("a Message created under a channel cascades, carrying the container id", async () => {
		const id = await env.create(MESSAGE_TYPE_URL, {
			conversation: CHANNEL_ID,
			body: "after the share",
		});

		expect(env.cascades).toEqual([
			{ childId: id, childType: MESSAGE_TYPE_URL, containerId: CHANNEL_ID },
		]);
		expect(env.errors).toEqual([]);
	});

	it("a non-collection type never reaches the engine", async () => {
		await env.create(CHANNEL_TYPE, { name: "general" });
		await env.create("brainstorm/Note/v1", { conversation: CHANNEL_ID });

		expect(env.cascades).toEqual([]);
	});

	it("a collection child with no container property is ignored", async () => {
		await env.create(MESSAGE_TYPE_URL, { body: "orphan" });

		expect(env.cascades).toEqual([]);
	});

	it("a cascade failure is contained - never an unhandled rejection", async () => {
		env.setCascadeThrows(true);
		await env.create(MESSAGE_TYPE_URL, { conversation: CHANNEL_ID, body: "offline" });

		expect(env.errors).toHaveLength(1);
		expect((env.errors[0] as Error).message).toBe("relay unavailable");
	});
});
