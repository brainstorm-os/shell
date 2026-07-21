import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecurrenceKind } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../storage/data-stores";
import { SchedulerFiresRepository } from "../storage/registry-repo/scheduler-fires-repo";
import { SchedulerService } from "./scheduler-service";
import { RegistrySchedulerStore } from "./scheduler-store";

const T0 = Date.UTC(2026, 5, 6, 9, 0, 0);
const DAY = 86_400_000;

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-scheduler-store-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("registry");
	const repo = new SchedulerFiresRepository(db);
	return { vaultDir, stores, repo, store: new RegistrySchedulerStore(repo) };
}

describe("RegistrySchedulerStore (registry.db persistence tail)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("round-trips a structured config (recurrence + workflow ids) through SQLite", async () => {
		env.store.save({
			triggerId: "t1",
			workflowIds: ["wfA", "wfB"],
			config: { recurrence: { kind: RecurrenceKind.Daily, every: 2 }, oneShotAt: T0 + DAY },
			nextFireAt: T0 + DAY,
		});
		const rows = env.store.loadAll();
		expect(rows).toEqual([
			{
				triggerId: "t1",
				workflowIds: ["wfA", "wfB"],
				config: { recurrence: { kind: RecurrenceKind.Daily, every: 2 }, oneShotAt: T0 + DAY },
				nextFireAt: T0 + DAY,
			},
		]);
	});

	it("save is an upsert — re-registering a trigger id overwrites its schedule", async () => {
		env.store.save({ triggerId: "t1", workflowIds: ["old"], config: {}, nextFireAt: T0 });
		env.store.save({ triggerId: "t1", workflowIds: ["new"], config: {}, nextFireAt: T0 + DAY });
		const rows = env.store.loadAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ workflowIds: ["new"], nextFireAt: T0 + DAY });
	});

	it("persists a NULL next_fire_at for a dormant (spent one-shot) trigger", async () => {
		env.store.save({ triggerId: "t1", workflowIds: ["wf"], config: {}, nextFireAt: null });
		expect(env.store.loadAll()[0]?.nextFireAt).toBeNull();
	});

	it("remove deletes the row", async () => {
		env.store.save({ triggerId: "t1", workflowIds: ["wf"], config: {}, nextFireAt: T0 });
		env.store.remove("t1");
		expect(env.store.loadAll()).toEqual([]);
	});

	it("SchedulerService survives a real restart against the same registry.db", async () => {
		const svc = new SchedulerService(env.store);
		await svc.register("t1", ["wf"], { recurrence: { kind: RecurrenceKind.Daily, every: 1 } }, T0);
		await svc.register("t2", ["wfX"], { oneShotAt: T0 + 3 * DAY }, T0);

		// A fresh service over a fresh store on the same db = a process restart.
		const revivedStore = new RegistrySchedulerStore(env.repo);
		const revived = new SchedulerService(revivedStore);
		await revived.hydrate();
		expect(revived.registeredTriggerIds()).toEqual(["t1", "t2"]);
		expect(revived.nextWakeAt()).toBe(T0 + DAY);

		// the recurring trigger still fires + re-arms post-restart, persisted
		expect(await revived.tick(T0 + DAY)).toEqual([
			{ triggerId: "t1", workflowId: "wf", firedAt: T0 + DAY },
		]);
		expect(env.repo.listAll().find((r) => r.triggerId === "t1")?.nextFireAt).toBe(T0 + 2 * DAY);
	});
});
