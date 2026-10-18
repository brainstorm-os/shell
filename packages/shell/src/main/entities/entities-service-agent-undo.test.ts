/**
 * Agent-15 — the agent write journal + run undo, end to end through the real
 * entities service over a real `entities.db` (no Y.Doc worker: the row is the
 * store, which is the path `writePropsThroughDoc` takes without one).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import {
	AGENT_PROVENANCE_PROPERTY_KEY,
	AgentUndoRefusal,
	AgentWriteKind,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { generateSymmetricKey } from "../credentials/crypto";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";
import { type AgentRunOps, makeEntitiesServiceHandler } from "./entities-service";
import { EntityDekStore } from "./entity-dek-store";

const AGENT = "io.brainstorm.agent";
const OTHER = "io.example.other";
const NOTE = "io.brainstorm.notes/Note/v1";
const TASK = "brainstorm/Task/v1";
const CONV = "conv_1";
const RUN = "run_1";

function ledger(grants: Record<string, string[]>): CapabilityLedger {
	return {
		has(app: string, required: string): boolean {
			const held = grants[app] ?? [];
			const [cap] = required.split(":");
			return held.includes(required) || held.includes(`${cap}:*`);
		},
	} as unknown as CapabilityLedger;
}

function env(app: string, method: string, arg: unknown): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m",
		app,
		service: "entities",
		method,
		args: [arg],
		caps: [],
	};
}

const ALL = ["entities.read:*", "entities.write:*"];

describe("entities service — Agent-15 run journal + undo", () => {
	let vaultDir: string;
	let stores: DataStores;
	let repo: EntitiesRepository;
	let handler: ReturnType<typeof makeEntitiesServiceHandler>;
	let ops: AgentRunOps;
	let clock: number;
	let ids: number;
	let grants: Record<string, string[]>;
	let runFor: (app: string, conversationId: string) => string | null;
	const undone: string[] = [];

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-agent-undo-"));
		stores = new DataStores(vaultDir);
		const db = await stores.open("entities");
		repo = new EntitiesRepository(db);
		const dekStore = new EntityDekStore(new EntityDeksRepository(db), generateSymmetricKey());
		clock = 1_000;
		ids = 0;
		grants = { [AGENT]: ALL, [OTHER]: ALL };
		runFor = (app, conversationId) => (app === AGENT && conversationId === CONV ? RUN : null);
		undone.length = 0;
		handler = makeEntitiesServiceHandler({
			getRepo: async () => repo,
			getLedger: async () => ledger(grants),
			getDekStore: async () => dekStore,
			newId: () => `ent_${++ids}`,
			now: () => ++clock,
			resolveAgentRun: async (app, conversationId) => runFor(app, conversationId),
			bindAgentRunOps: (bound) => {
				ops = bound;
			},
			onAgentRunUndone: (runId) => undone.push(runId),
		});
	});
	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	const call = (app: string, method: string, arg: unknown) => handler(env(app, method, arg));
	const create = async (props: Record<string, unknown>, provenance?: unknown, type = NOTE) =>
		(
			(await call(AGENT, "create", {
				type,
				properties: props,
				...(provenance === undefined ? {} : { provenance }),
			})) as { id: string }
		).id;

	it("journals an approved create and trashes it on undo", async () => {
		const id = await create({ title: "Plan", body: "a\nb" }, { conversationId: CONV });
		const diff = await ops.changes(RUN, { privileged: true });
		expect(diff?.changes).toHaveLength(1);
		expect(diff?.changes[0]).toMatchObject({
			entityId: id,
			kind: AgentWriteKind.Created,
			title: "Plan",
		});
		// The reserved provenance key is never part of the diff.
		expect(diff?.changes[0]?.fields.map((f) => f.key)).toEqual(["title", "body"]);
		expect(diff?.changes[0]?.fields[1]?.lines).toEqual({ added: 2, removed: 0 });

		expect(await ops.undo(RUN, { privileged: true })).toEqual({ ok: true, reverted: 1 });
		expect(repo.get(id)).toBeNull();
		expect(repo.getIncludingDeleted(id)?.deletedAt).not.toBeNull();
		expect(undone).toEqual([RUN]);
		expect((await ops.changes(RUN, { privileged: true }))?.revertedAt).not.toBeNull();
		expect(await ops.undo(RUN, { privileged: true })).toMatchObject({
			ok: false,
			reason: AgentUndoRefusal.AlreadyUndone,
		});
	});

	it("does not journal a plain create, or one with no attributable run", async () => {
		await create({ title: "Mine" });
		runFor = () => null;
		await create({ title: "Orphan" }, { conversationId: CONV });
		expect(repo.agentWrites.count()).toBe(0);
	});

	it("restores exactly the keys an agent edit touched, leaving the user's other edits", async () => {
		const id = await create({ title: "Draft", status: "todo", owner: "me" });
		await call(AGENT, "update", {
			id,
			patch: { status: "done", priority: "high" },
			provenance: { conversationId: CONV },
		});
		// The user edits a DIFFERENT field afterwards.
		await call(OTHER, "update", { id, patch: { owner: "you" } });

		expect(await ops.undo(RUN, { privileged: true })).toEqual({ ok: true, reverted: 1 });
		const after = repo.get(id)?.properties ?? {};
		expect(after.status).toBe("todo");
		expect(after.priority).toBeNull();
		expect(after.owner).toBe("you");
	});

	it("refuses, naming the field, when a later edit touched what the run wrote", async () => {
		const id = await create({ title: "Draft", status: "todo" });
		await call(AGENT, "update", {
			id,
			patch: { status: "done" },
			provenance: { conversationId: CONV },
		});
		await call(OTHER, "update", { id, patch: { status: "blocked" } });
		expect(await ops.undo(RUN, { privileged: true })).toEqual({
			ok: false,
			reason: AgentUndoRefusal.EditedSince,
			entityId: id,
			field: "status",
		});
		expect(repo.get(id)?.properties.status).toBe("blocked");
	});

	it("refuses the WHOLE run when one object was edited since — nothing is reverted", async () => {
		const created = await create({ title: "New" }, { conversationId: CONV });
		const edited = await create({ title: "Old", status: "todo" });
		await call(AGENT, "update", {
			id: edited,
			patch: { status: "done" },
			provenance: { conversationId: CONV },
		});
		await call(OTHER, "update", { id: created, patch: { title: "Renamed by me" } });
		const result = await ops.undo(RUN, { privileged: true });
		expect(result).toMatchObject({ ok: false, entityId: created, field: "title" });
		expect(repo.get(created)).not.toBeNull();
		expect(repo.get(edited)?.properties.status).toBe("done");
	});

	it("untrashes what the run trashed, and refuses once it was purged", async () => {
		const id = await create({ title: "Keep" });
		await call(AGENT, "delete", { id, provenance: { conversationId: CONV } });
		expect(repo.get(id)).toBeNull();
		expect(await ops.undo(RUN, { privileged: true })).toEqual({ ok: true, reverted: 1 });
		expect(repo.get(id)?.properties.title).toBe("Keep");

		const gone = await create({ title: "Gone" });
		runFor = () => "run_2";
		await call(AGENT, "delete", { id: gone, provenance: { conversationId: CONV } });
		repo.hardDelete(gone);
		expect(await ops.undo("run_2", { privileged: true })).toMatchObject({
			ok: false,
			reason: AgentUndoRefusal.Purged,
			entityId: gone,
		});
	});

	it("refuses to touch a locked object", async () => {
		const id = await create({ title: "Pinned", status: "todo" });
		await call(AGENT, "update", {
			id,
			patch: { status: "done" },
			provenance: { conversationId: CONV },
		});
		await call(OTHER, "update", { id, patch: { locked: true } });
		expect(await ops.undo(RUN, { privileged: true })).toMatchObject({
			ok: false,
			reason: AgentUndoRefusal.Locked,
		});
	});

	it("scopes an app caller to its own journal and to types it can still read / write", async () => {
		await create({ title: "Task" }, { conversationId: CONV }, TASK);
		// Another app cannot see or undo the agent's run.
		expect((await ops.changes(RUN, { privileged: false, app: OTHER }))?.changes).toEqual([]);
		expect(await ops.undo(RUN, { privileged: false, app: OTHER })).toMatchObject({
			ok: false,
			reason: AgentUndoRefusal.NotFound,
		});
		// The agent itself, once its Task grant is gone, neither sees nor reverts it.
		grants = { [AGENT]: [`entities.read:${NOTE}`, `entities.write:${NOTE}`] };
		expect((await ops.changes(RUN, { privileged: false, app: AGENT }))?.changes).toEqual([]);
		expect(await ops.undo(RUN, { privileged: false, app: AGENT })).toMatchObject({
			ok: false,
			reason: AgentUndoRefusal.Denied,
		});
	});

	it("cannot be steered by a forged provenance key in the property bag", async () => {
		const id = await create({
			title: "x",
			[AGENT_PROVENANCE_PROPERTY_KEY]: { agent: OTHER, conversationId: CONV, createdAt: 1 },
		});
		expect(repo.get(id)?.properties[AGENT_PROVENANCE_PROPERTY_KEY]).toBeUndefined();
		expect(repo.agentWrites.count()).toBe(0);
	});
});
