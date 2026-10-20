/**
 * Agent-15 — the agent write journal + run undo, end to end through the real
 * entities service over a real `entities.db` (no Y.Doc worker: the row is the
 * store, which is the path `writePropsThroughDoc` takes without one).
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import {
	AGENT_PROVENANCE_PROPERTY_KEY,
	AgentUndoRefusal,
	AgentWriteKind,
	type PropertyDef,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { generateSymmetricKey } from "../credentials/crypto";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";
import { removeTestDir } from "../test-support/remove-test-dir";
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

const PAIRED_DEFS: PropertyDef[] = [
	{
		key: "project",
		name: "Project",
		icon: null,
		valueType: ValueType.EntityRef,
		inverseOf: "tasks",
	},
	{
		key: "tasks",
		name: "Tasks",
		icon: null,
		valueType: ValueType.EntityRef,
		count: { min: 0, max: 50 },
	},
];

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
	let onChange: ((change: { entityId: string }) => void) | null = null;

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
		onChange = null;
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
			// 9.12.25 — `project` (one Project) ⇄ `tasks` (many Tasks).
			getPropertyDefs: async () => PAIRED_DEFS,
			onEntityChange: (change) => onChange?.(change),
		});
	});
	afterEach(async () => {
		stores.close();
		await removeTestDir(vaultDir);
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

	it("untrashes what the run trashed; a purge takes the journal with it", async () => {
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
			reason: AgentUndoRefusal.NotFound,
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

	describe("two-way relations (9.12.25) undo with the run", () => {
		const prov = { conversationId: CONV };
		const asUser = async (props: Record<string, unknown>) =>
			((await call(OTHER, "create", { type: TASK, properties: props })) as { id: string }).id;

		it("a run that creates two linked objects can be undone", async () => {
			const p = await create({ title: "P" }, prov, TASK);
			const x = await create({ title: "X", project: p }, prov, TASK);
			expect(repo.get(p)?.properties.tasks).toEqual([{ value: x }]);
			expect(await ops.undo(RUN, { privileged: true })).toMatchObject({ ok: true });
			expect(repo.get(p)).toBeNull();
			expect(repo.get(x)).toBeNull();
		});

		it("undoing an agent create drops the back-link it added to an existing object", async () => {
			const p = await asUser({ title: "P" });
			const x = await create({ title: "X", project: p }, prov, TASK);
			expect(repo.get(p)?.properties.tasks).toEqual([{ value: x }]);
			expect(await ops.undo(RUN, { privileged: true })).toMatchObject({ ok: true });
			expect(repo.get(x)).toBeNull();
			expect(repo.get(p)?.properties.tasks ?? null).toBeNull();
		});

		it("undoing an agent link edit reverts both ends", async () => {
			const p = await asUser({ title: "P" });
			const x = await asUser({ title: "X" });
			await call(AGENT, "update", { id: x, patch: { project: p }, provenance: prov });
			expect(repo.get(p)?.properties.tasks).toEqual([{ value: x }]);
			expect(await ops.undo(RUN, { privileged: true })).toMatchObject({ ok: true });
			expect(repo.get(x)?.properties.project ?? null).toBeNull();
			expect(repo.get(p)?.properties.tasks ?? null).toBeNull();
		});

		it("undoing an agent delete restores the back-links the delete removed", async () => {
			const p = await asUser({ title: "P" });
			const x = await asUser({ title: "X", project: p });
			expect(repo.get(p)?.properties.tasks).toEqual([{ value: x }]);
			await call(AGENT, "delete", { id: x, provenance: prov });
			expect(repo.get(p)?.properties.tasks).toEqual([]);
			expect(await ops.undo(RUN, { privileged: true })).toMatchObject({ ok: true });
			expect(repo.get(x)).not.toBeNull();
			expect(repo.get(p)?.properties.tasks).toEqual([{ value: x }]);
		});

		it("journals the primary write before its far ends", async () => {
			const p = await asUser({ title: "P" });
			const x = await create({ title: "X" }, prov, TASK);
			await call(AGENT, "update", { id: x, patch: { project: p }, provenance: prov });
			const kinds = repo.agentWrites.listForRun(RUN).map((e) => [e.entityId, e.kind]);
			expect(kinds).toEqual([
				[x, AgentWriteKind.Created],
				[x, AgentWriteKind.Updated],
				[p, AgentWriteKind.Updated],
			]);
		});
	});

	it("re-checks each object right before its undo write (a lock set mid-undo holds)", async () => {
		const a = (
			(await call(OTHER, "create", { type: NOTE, properties: { title: "A" } })) as { id: string }
		).id;
		const b = (
			(await call(OTHER, "create", { type: NOTE, properties: { title: "B" } })) as { id: string }
		).id;
		await call(AGENT, "update", {
			id: a,
			patch: { title: "A2" },
			provenance: { conversationId: CONV },
		});
		await call(AGENT, "update", {
			id: b,
			patch: { title: "B2" },
			provenance: { conversationId: CONV },
		});
		onChange = (change) => {
			if (change.entityId === a) repo.update(b, { locked: true }, ++clock);
		};
		expect(await ops.undo(RUN, { privileged: true })).toMatchObject({
			ok: false,
			reason: AgentUndoRefusal.Locked,
			entityId: b,
		});
		expect(repo.get(a)?.properties.title).toBe("A");
		expect(repo.get(b)?.properties.title).toBe("B2");
	});

	it("purging an entity purges its journal rows", async () => {
		const id = await create({ title: "Gone" }, { conversationId: CONV });
		expect(repo.agentWrites.listForRun(RUN)).toHaveLength(1);
		await call(AGENT, "delete", { id });
		repo.hardDelete(id);
		expect(repo.agentWrites.listForRun(RUN).filter((e) => e.entityId === id)).toEqual([]);
	});
});
