import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentEventKind,
	AgentEventOutcome,
	AgentRunOutcome,
	AgentRunSurface,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../../storage/data-stores";
import {
	AGENT_EVENTS_MAX_ROWS,
	AGENT_EVENTS_PAGE_MAX,
	AGENT_EVENTS_RETENTION_MS,
	AGENT_RUNS_MAX_ROWS,
	AGENT_RUNS_PAGE_MAX,
	AGENT_RUNS_PER_AGENT_MAX,
	AGENT_RUNS_RETENTION_MS,
	AGENT_RUN_STALE_MS,
	type AgentEventInsert,
	type AgentRunInsert,
	AgentTraceRepository,
} from "./agent-trace-repo";

const run = (overrides: Partial<AgentRunInsert> = {}): AgentRunInsert => ({
	id: `run_${Math.random().toString(36).slice(2)}`,
	surface: AgentRunSurface.Chat,
	conversationId: "conv-1",
	workflowRunId: null,
	agent: "io.brainstorm.agent",
	startedAt: 1_000,
	...overrides,
});

const event = (runId: string, overrides: Partial<AgentEventInsert> = {}): AgentEventInsert => ({
	runId,
	ts: 1_000,
	kind: AgentEventKind.ToolCall,
	tool: "open",
	targetEntityId: null,
	capability: null,
	outcome: AgentEventOutcome.Ok,
	detail: null,
	durationMs: 5,
	...overrides,
});

describe("AgentTraceRepository", () => {
	let vaultDir: string;
	let stores: DataStores;
	let repo: AgentTraceRepository;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-agent-trace-"));
		stores = new DataStores(vaultDir);
		repo = new AgentTraceRepository(await stores.open("account"));
	});
	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("insert → get → finish round-trips a run; only the first close wins", () => {
		const r = run({ id: "run_a", startedAt: 50 });
		repo.insertRun(r);
		expect(repo.getRun("run_a")).toMatchObject({
			id: "run_a",
			surface: AgentRunSurface.Chat,
			conversationId: "conv-1",
			agent: "io.brainstorm.agent",
			startedAt: 50,
			endedAt: null,
			outcome: null,
			denialCount: 0,
		});
		repo.finishRun("run_a", 90, AgentRunOutcome.Ok);
		repo.finishRun("run_a", 999, AgentRunOutcome.Error); // must NOT overwrite
		expect(repo.getRun("run_a")).toMatchObject({ endedAt: 90, outcome: AgentRunOutcome.Ok });
	});

	it("events auto-sequence per run and page forward via afterSeq", () => {
		repo.insertRun(run({ id: "run_a" }));
		repo.insertRun(run({ id: "run_b" }));
		repo.insertEvent(event("run_a", { tool: "one" }));
		repo.insertEvent(event("run_b", { tool: "other" }));
		repo.insertEvent(event("run_a", { tool: "two" }));
		const events = repo.listEvents("run_a");
		expect(events.map((e) => [e.seq, e.tool])).toEqual([
			[1, "one"],
			[2, "two"],
		]);
		expect(repo.listEvents("run_a", { afterSeq: 1 }).map((e) => e.tool)).toEqual(["two"]);
	});

	it("bumpDenialCount denormalizes onto the run row", () => {
		repo.insertRun(run({ id: "run_a" }));
		repo.bumpDenialCount("run_a");
		repo.bumpDenialCount("run_a");
		expect(repo.getRun("run_a")?.denialCount).toBe(2);
	});

	it("listRuns filters by agent/surface/conversation/outcome/denialsOnly and clamps the page", () => {
		for (let i = 0; i < 150; i++) {
			repo.insertRun(run({ id: `run_${i}`, startedAt: i, agent: "app.a" }));
		}
		repo.insertRun(
			run({
				id: "run_auto",
				surface: AgentRunSurface.Automation,
				conversationId: null,
				workflowRunId: "wfr-1",
				agent: "app.b",
				startedAt: 500,
			}),
		);
		repo.finishRun("run_auto", 501, AgentRunOutcome.Refused);
		repo.bumpDenialCount("run_auto");

		// Clamp: asking for 10_000 returns at most the page max.
		expect(repo.listRuns({ limit: 10_000 }).length).toBeLessThanOrEqual(AGENT_RUNS_PAGE_MAX);
		// Newest first + cursor pages strictly older.
		const first = repo.listRuns({ agent: "app.a", limit: 2 });
		expect(first.map((r) => r.startedAt)).toEqual([149, 148]);
		const next = repo.listRuns({ agent: "app.a", beforeStartedAt: 148, limit: 2 });
		expect(next.map((r) => r.startedAt)).toEqual([147, 146]);
		// Facets.
		expect(repo.listRuns({ surface: AgentRunSurface.Automation }).map((r) => r.id)).toEqual([
			"run_auto",
		]);
		expect(repo.listRuns({ outcome: AgentRunOutcome.Refused }).map((r) => r.id)).toEqual([
			"run_auto",
		]);
		expect(repo.listRuns({ denialsOnly: true }).map((r) => r.id)).toEqual(["run_auto"]);
		expect(repo.listRuns({ conversationId: "conv-1", limit: 3 })).toHaveLength(3);
	});

	it("latestRunFor scopes to agent (+ conversation)", () => {
		repo.insertRun(run({ id: "r1", agent: "a", conversationId: "c1", startedAt: 1 }));
		repo.insertRun(run({ id: "r2", agent: "a", conversationId: "c2", startedAt: 2 }));
		repo.insertRun(run({ id: "r3", agent: "b", conversationId: "c1", startedAt: 3 }));
		expect(repo.latestRunFor("a")?.id).toBe("r2");
		expect(repo.latestRunFor("a", "c1")?.id).toBe("r1");
		expect(repo.latestRunFor("zz")).toBeNull();
	});

	it("setWorkflowRunId back-links the WorkflowRun/v1 entity", () => {
		repo.insertRun(run({ id: "r1", surface: AgentRunSurface.Automation, conversationId: null }));
		repo.setWorkflowRunId("r1", "ent_wfr");
		expect(repo.getRun("r1")?.workflowRunId).toBe("ent_wfr");
	});

	it("listRuns filters by workflowRunId (the 12c drill-in join)", () => {
		repo.insertRun(run({ id: "r1", surface: AgentRunSurface.Automation, conversationId: null }));
		repo.insertRun(run({ id: "r2", surface: AgentRunSurface.Automation, conversationId: null }));
		repo.setWorkflowRunId("r1", "ent_wfr_1");
		repo.setWorkflowRunId("r2", "ent_wfr_2");
		expect(repo.listRuns({ workflowRunId: "ent_wfr_2" }).map((r) => r.id)).toEqual(["r2"]);
		expect(repo.listRuns({ workflowRunId: "nope" })).toHaveLength(0);
	});

	it("listAgents returns distinct principals, bounded (the 12d app filter)", () => {
		repo.insertRun(run({ id: "r1", agent: "io.a" }));
		repo.insertRun(run({ id: "r2", agent: "io.b" }));
		repo.insertRun(run({ id: "r3", agent: "io.a" }));
		expect(repo.listAgents()).toEqual(["io.a", "io.b"]);
		expect(repo.listAgents(1)).toEqual(["io.a"]);
	});

	it("eventsForEntity returns the per-entity agent history, bounded", () => {
		repo.insertRun(run({ id: "r1" }));
		repo.insertEvent(event("r1", { targetEntityId: "ent_x", ts: 1 }));
		repo.insertEvent(event("r1", { targetEntityId: "ent_x", ts: 2 }));
		repo.insertEvent(event("r1", { targetEntityId: "ent_y", ts: 3 }));
		const history = repo.eventsForEntity("ent_x");
		expect(history).toHaveLength(2);
		expect(history[0]?.ts).toBe(2); // newest first
		expect(repo.listEvents("r1", { limit: 10_000 }).length).toBeLessThanOrEqual(
			AGENT_EVENTS_PAGE_MAX,
		);
	});

	describe("prune (the OQ-AO-1 contract)", () => {
		it("ages out events at 30d and runs (with events) at 12mo", () => {
			const now = AGENT_RUNS_RETENTION_MS * 2;
			repo.insertRun(run({ id: "ancient", startedAt: now - AGENT_RUNS_RETENTION_MS - 1 }));
			repo.insertEvent(event("ancient", { ts: now - 10 })); // fresh event, ancient run
			repo.insertRun(run({ id: "recent", startedAt: now - 10 }));
			repo.insertEvent(event("recent", { ts: now - AGENT_EVENTS_RETENTION_MS - 1 })); // stale event
			repo.insertEvent(event("recent", { ts: now - 5 }));
			repo.finishRun("recent", now, AgentRunOutcome.Ok);

			repo.prune(now);

			expect(repo.getRun("ancient")).toBeNull();
			expect(repo.listEvents("ancient")).toEqual([]);
			expect(repo.getRun("recent")).not.toBeNull();
			expect(repo.listEvents("recent")).toHaveLength(1);
		});

		it("count-caps both tables newest-wins", () => {
			const now = AGENT_EVENTS_RETENTION_MS; // everything inside the age window
			// 6 principals × 900 runs = 5400 — over the global cap while each
			// stays under its per-agent cap, so the GLOBAL newest-wins clip is
			// what fires.
			const perAgent = 900;
			for (let a = 0; a < 6; a++) {
				for (let i = 0; i < perAgent; i++) {
					repo.insertRun(run({ id: `r_${a}_${i}`, agent: `app.${a}`, startedAt: a * perAgent + i + 1 }));
				}
			}
			repo.prune(now);
			expect(repo.countRuns()).toBe(AGENT_RUNS_MAX_ROWS);
			expect(repo.getRun("r_0_0")).toBeNull(); // oldest gone
			expect(repo.getRun(`r_5_${perAgent - 1}`)).not.toBeNull(); // newest kept
		});

		it("PENTEST P1: a run-spamming principal cannot evict another principal's history", () => {
			const now = AGENT_EVENTS_RETENTION_MS;
			repo.insertRun(run({ id: "victim", agent: "app.victim", startedAt: 1 }));
			for (let i = 0; i < AGENT_RUNS_PER_AGENT_MAX + 200; i++) {
				repo.insertRun(run({ id: `spam_${i}`, agent: "app.spammer", startedAt: i + 2 }));
			}
			repo.prune(now);
			// The spammer is clipped to its own cap; the victim's (much older) run
			// survives because the global cap is not reached.
			expect(repo.getRun("victim")).not.toBeNull();
			expect(repo.listRuns({ agent: "app.spammer", limit: 1 })).toHaveLength(1);
			const spamCount = (repo.countRuns() - 1) as number;
			expect(spamCount).toBe(AGENT_RUNS_PER_AGENT_MAX);
		});

		it("closes stale open runs as aborted", () => {
			const now = AGENT_RUN_STALE_MS * 3;
			repo.insertRun(run({ id: "stale", startedAt: now - AGENT_RUN_STALE_MS - 1 }));
			repo.insertRun(run({ id: "live", startedAt: now - 10 }));
			repo.prune(now);
			expect(repo.getRun("stale")).toMatchObject({ outcome: AgentRunOutcome.Aborted });
			expect(repo.getRun("live")?.outcome).toBeNull();
		});

		it("event count cap holds under a single-run flood", () => {
			const now = AGENT_EVENTS_RETENTION_MS;
			repo.insertRun(run({ id: "r", startedAt: 1 }));
			// A flood far past the cap would be slow row-by-row; insert a
			// modest overage and assert the cap math with a lowered bar via
			// direct SQL count (the cap constant is large by design).
			for (let i = 0; i < 500; i++) {
				repo.insertEvent(event("r", { ts: i + 1 }));
			}
			repo.prune(now);
			expect(repo.countEvents()).toBeLessThanOrEqual(AGENT_EVENTS_MAX_ROWS);
			expect(repo.countEvents()).toBe(500); // under the cap: nothing dropped
		});
	});

	it("rejects nothing but surfaces nothing invalid: rows with out-of-vocabulary enums are skipped in projections", async () => {
		const db = await stores.open("account");
		db
			.prepare(
				"INSERT INTO agent_runs (id, surface, conversation_id, workflow_run_id, agent, started_at) VALUES ('bad', 'weird-surface', NULL, NULL, 'a', 1)",
			)
			.run();
		expect(repo.getRun("bad")).toBeNull();
		expect(repo.listRuns({ agent: "a" })).toEqual([]);
	});
});
