import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWriteKind } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../data-stores";
import {
	AGENT_WRITES_PER_AGENT_MAX,
	AGENT_WRITES_PER_RUN_MAX,
	AGENT_WRITES_RETENTION_MS,
	AGENT_WRITE_VALUE_MAX_BYTES,
	AgentWritesRepository,
} from "./agent-writes-repo";

describe("AgentWritesRepository (Agent-15 journal)", () => {
	let vaultDir: string;
	let stores: DataStores;
	let repo: AgentWritesRepository;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-agent-writes-"));
		stores = new DataStores(vaultDir);
		repo = new AgentWritesRepository(await stores.open("entities"));
	});
	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	const write = (
		runId: string,
		agent: string,
		ts: number,
		after: Record<string, unknown> = { a: 1 },
	) =>
		repo.insert({
			runId,
			agent,
			entityId: `e_${runId}_${ts}`,
			entityType: "t",
			kind: AgentWriteKind.Updated,
			before: { present: { a: 0 }, absent: [] },
			after,
			ts,
		});

	it("round-trips a write, oldest first", () => {
		write("r1", "agent", 2, { a: 2 });
		write("r1", "agent", 1, { a: 1 });
		const rows = repo.listForRun("r1");
		expect(rows.map((r) => r.after)).toEqual([{ a: 2 }, { a: 1 }]);
		expect(rows[0]?.before).toEqual({ present: { a: 0 }, absent: [] });
		expect(rows[0]?.oversize).toBe(false);
	});

	it("journals an over-size value as oversize with no content", () => {
		write("r1", "agent", 1, { body: "x".repeat(AGENT_WRITE_VALUE_MAX_BYTES + 1) });
		const [row] = repo.listForRun("r1");
		expect(row?.oversize).toBe(true);
		expect(row?.after).toBeNull();
		expect(repo.hasOversize("r1")).toBe(true);
	});

	it("caps one run's rows and marks the overflow once", () => {
		for (let i = 0; i < AGENT_WRITES_PER_RUN_MAX; i++) expect(write("r1", "agent", i)).toBe(true);
		expect(write("r1", "agent", 9_999)).toBe(false);
		expect(write("r1", "agent", 10_000)).toBe(false);
		expect(repo.count()).toBe(AGENT_WRITES_PER_RUN_MAX + 1);
		expect(repo.hasOversize("r1")).toBe(true);
	});

	it("ages out whole runs past retention", () => {
		write("old", "agent", 1);
		write("new", "agent", AGENT_WRITES_RETENTION_MS + 10);
		repo.prune(AGENT_WRITES_RETENTION_MS + 20);
		expect(repo.listForRun("old")).toEqual([]);
		expect(repo.listForRun("new")).toHaveLength(1);
	});

	it("per-principal cap: a write-spamming app cannot evict another agent's history", () => {
		write("victim", "victim-agent", 1);
		const runs = Math.ceil((AGENT_WRITES_PER_AGENT_MAX + 50) / AGENT_WRITES_PER_RUN_MAX);
		let ts = 10;
		for (let r = 0; r < runs; r++) {
			for (let i = 0; i < AGENT_WRITES_PER_RUN_MAX; i++) write(`spam_${r}`, "spammer", ts++);
		}
		repo.prune(ts);
		expect(repo.listForRun("victim")).toHaveLength(1);
		// The spammer keeps only its newest runs, never a partial one.
		const kept = Array.from({ length: runs }, (_, r) => repo.listForRun(`spam_${r}`).length);
		expect(kept.every((n) => n === 0 || n === AGENT_WRITES_PER_RUN_MAX)).toBe(true);
		expect(kept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(AGENT_WRITES_PER_AGENT_MAX);
		expect(kept[runs - 1]).toBe(AGENT_WRITES_PER_RUN_MAX);
	});

	it("marks a run reverted", () => {
		write("r1", "agent", 1);
		repo.markRunReverted("r1", 42);
		expect(repo.listForRun("r1")[0]?.revertedAt).toBe(42);
	});
});
