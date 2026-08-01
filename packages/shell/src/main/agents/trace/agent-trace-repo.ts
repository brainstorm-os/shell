/**
 * Repository for the `agent_runs` + `agent_events` tables in `account.db`
 * (Agent-12a — doc 77 agent observability). One aggregate repo for the two
 * tables because an event never exists without its run and every delete path
 * must cascade run → events by hand (no FK — `account.db` predates enforced
 * foreign keys and stays disposable-on-corruption).
 *
 * Rows are metadata only (tool name, capability, outcome, timing — never
 * prompt/completion/argument bytes); the WRITER (`AgentTraceRecorder`)
 * sanitizes every string before it reaches this class. Reads return bounded
 * pages — every LIMIT is clamped here, so no caller can induce an unbounded
 * scan-and-marshal (doc 77: surfaces get bounded, paginated projections).
 *
 * Retention (OQ-AO-1, resolved tiered): events live ~30 days, runs ~12
 * months, and BOTH are count-capped (events 50k, runs 5k, newest wins) —
 * the trace is an operational record, not an archive. `prune()` enforces all
 * four bounds plus the stale-run sweep in one call; the recorder invokes it
 * opportunistically like `AiQuotaService.pruneOpportunistically`.
 *
 * SQL lives only here (CLAUDE.md §Repository pattern for SQL).
 */

import {
	type AgentEventKind,
	type AgentEventOutcome,
	AgentRunOutcome,
	type AgentRunSummary,
	type AgentRunSurface,
	type AgentTraceEventRecord,
	isAgentEventKind,
	isAgentEventOutcome,
	isAgentRunOutcome,
	isAgentRunSurface,
} from "@brainstorm-os/sdk-types";
import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";

/** Age caps (OQ-AO-1): events ~30 days, runs ~12 months. */
export const AGENT_EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const AGENT_RUNS_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** Count caps (OQ-AO-1): newest-wins, in the spirit of `AiUsageRepo.prune`. */
export const AGENT_EVENTS_MAX_ROWS = 50_000;
export const AGENT_RUNS_MAX_ROWS = 5_000;

/** Per-principal run cap: one begin-spamming app may only ever occupy this
 *  much of the global window, so it cannot evict OTHER principals' history
 *  (the 12a pentest's P1 anti-eviction fence). */
export const AGENT_RUNS_PER_AGENT_MAX = 1_000;

/** A run never `endRun`-ed (renderer crash, kill -9) is closed as `aborted`
 *  once it is this stale — an open-ended row must not read as "running". */
export const AGENT_RUN_STALE_MS = 6 * 60 * 60 * 1000;

/** Page clamps for the projections. */
export const AGENT_RUNS_PAGE_MAX = 100;
export const AGENT_EVENTS_PAGE_MAX = 200;

export type AgentRunInsert = {
	id: string;
	surface: AgentRunSurface;
	conversationId: string | null;
	workflowRunId: string | null;
	agent: string;
	startedAt: number;
};

export type AgentEventInsert = {
	runId: string;
	ts: number;
	kind: AgentEventKind;
	tool: string;
	targetEntityId: string | null;
	capability: string | null;
	outcome: AgentEventOutcome;
	detail: string | null;
	durationMs: number;
};

export type AgentRunFilter = {
	surface?: AgentRunSurface;
	agent?: string;
	conversationId?: string;
	sinceTs?: number;
	untilTs?: number;
	outcome?: AgentRunOutcome;
	denialsOnly?: boolean;
	/** Cursor: rows strictly older than this `startedAt` (descending pages). */
	beforeStartedAt?: number;
	limit?: number;
};

type RunRow = {
	id: string;
	surface: string;
	conversation_id: string | null;
	workflow_run_id: string | null;
	agent: string;
	started_at: number;
	ended_at: number | null;
	outcome: string | null;
	denial_count: number;
};

type EventRow = {
	run_id: string;
	seq: number;
	ts: number;
	kind: string;
	tool: string;
	target_entity_id: string | null;
	capability: string | null;
	outcome: string;
	detail: string | null;
	duration_ms: number;
};

function clampLimit(limit: number | undefined, max: number, fallback: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return fallback;
	return Math.min(Math.floor(limit), max);
}

function composeRun(row: RunRow): AgentRunSummary | null {
	// A row whose enums fail the guard is skipped rather than surfaced — the
	// projection never carries a value outside the contract's vocabulary.
	if (!isAgentRunSurface(row.surface)) return null;
	const outcome = row.outcome === null ? null : isAgentRunOutcome(row.outcome) ? row.outcome : null;
	return {
		id: row.id,
		surface: row.surface,
		conversationId: row.conversation_id,
		workflowRunId: row.workflow_run_id,
		agent: row.agent,
		startedAt: Number(row.started_at),
		endedAt: row.ended_at === null ? null : Number(row.ended_at),
		outcome,
		denialCount: Number(row.denial_count),
	};
}

function composeEvent(row: EventRow): AgentTraceEventRecord | null {
	if (!isAgentEventKind(row.kind) || !isAgentEventOutcome(row.outcome)) return null;
	return {
		runId: row.run_id,
		seq: Number(row.seq),
		ts: Number(row.ts),
		kind: row.kind,
		tool: row.tool,
		targetEntityId: row.target_entity_id,
		capability: row.capability,
		outcome: row.outcome,
		detail: row.detail,
		durationMs: Number(row.duration_ms),
	};
}

export class AgentTraceRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	insertRun(run: AgentRunInsert): void {
		this.stmt(
			"INSERT INTO agent_runs (id, surface, conversation_id, workflow_run_id, agent, started_at) " +
				"VALUES (?, ?, ?, ?, ?, ?)",
		).run(run.id, run.surface, run.conversationId, run.workflowRunId, run.agent, run.startedAt);
	}

	/** Close a run. Idempotent-ish: only the first close wins (a stale sweep
	 *  racing an explicit end must not overwrite the real outcome). */
	finishRun(id: string, endedAt: number, outcome: AgentRunOutcome): void {
		this.stmt("UPDATE agent_runs SET ended_at = ?, outcome = ? WHERE id = ? AND outcome IS NULL").run(
			endedAt,
			outcome,
			id,
		);
	}

	/** Late-bind the persisted `WorkflowRun/v1` entity id (the trace run opens
	 *  BEFORE the run entity exists so live `ai_usage` rows can join it). */
	setWorkflowRunId(id: string, workflowRunId: string): void {
		this.stmt("UPDATE agent_runs SET workflow_run_id = ? WHERE id = ?").run(workflowRunId, id);
	}

	/** Denormalized denial counter — the header badge reads one column. */
	bumpDenialCount(id: string): void {
		this.stmt("UPDATE agent_runs SET denial_count = denial_count + 1 WHERE id = ?").run(id);
	}

	getRun(id: string): AgentRunSummary | null {
		const row = this.stmt("SELECT * FROM agent_runs WHERE id = ?").get(id) as RunRow | undefined;
		return row ? composeRun(row) : null;
	}

	/** Next event `seq` computed in the INSERT itself, so the writer needs no
	 *  in-memory counter that could fork from the table across restarts. */
	insertEvent(event: AgentEventInsert): void {
		this.stmt(
			"INSERT INTO agent_events (run_id, seq, ts, kind, tool, target_entity_id, capability, outcome, detail, duration_ms) " +
				"VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_events WHERE run_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			event.runId,
			event.runId,
			event.ts,
			event.kind,
			event.tool,
			event.targetEntityId,
			event.capability,
			event.outcome,
			event.detail,
			event.durationMs,
		);
	}

	/** Newest-first run page. Every filter is optional; the LIMIT is clamped. */
	listRuns(filter: AgentRunFilter): readonly AgentRunSummary[] {
		const where: string[] = [];
		const params: unknown[] = [];
		if (filter.surface !== undefined) {
			where.push("surface = ?");
			params.push(filter.surface);
		}
		if (filter.agent !== undefined) {
			where.push("agent = ?");
			params.push(filter.agent);
		}
		if (filter.conversationId !== undefined) {
			where.push("conversation_id = ?");
			params.push(filter.conversationId);
		}
		if (filter.sinceTs !== undefined) {
			where.push("started_at >= ?");
			params.push(filter.sinceTs);
		}
		if (filter.untilTs !== undefined) {
			where.push("started_at <= ?");
			params.push(filter.untilTs);
		}
		if (filter.outcome !== undefined) {
			where.push("outcome = ?");
			params.push(filter.outcome);
		}
		if (filter.denialsOnly) where.push("denial_count > 0");
		if (filter.beforeStartedAt !== undefined) {
			where.push("started_at < ?");
			params.push(filter.beforeStartedAt);
		}
		const limit = clampLimit(filter.limit, AGENT_RUNS_PAGE_MAX, 20);
		const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
		const sql = `SELECT * FROM agent_runs${clause} ORDER BY started_at DESC, id DESC LIMIT ?`;
		const rows = this.stmt(sql).all(...params, limit) as RunRow[];
		return rows.map(composeRun).filter((r): r is AgentRunSummary => r !== null);
	}

	/** The most recent run for a principal (optionally within a conversation)
	 *  — where a post-turn approve/discard gesture attaches. */
	latestRunFor(agent: string, conversationId?: string): AgentRunSummary | null {
		const row = (
			conversationId === undefined
				? this.stmt(
						"SELECT * FROM agent_runs WHERE agent = ? ORDER BY started_at DESC, id DESC LIMIT 1",
					).get(agent)
				: this.stmt(
						"SELECT * FROM agent_runs WHERE agent = ? AND conversation_id = ? ORDER BY started_at DESC, id DESC LIMIT 1",
					).get(agent, conversationId)
		) as RunRow | undefined;
		return row ? composeRun(row) : null;
	}

	/** Ordered event page for one run; `afterSeq` pages forward. */
	listEvents(
		runId: string,
		page?: { afterSeq?: number; limit?: number },
	): readonly AgentTraceEventRecord[] {
		const limit = clampLimit(page?.limit, AGENT_EVENTS_PAGE_MAX, AGENT_EVENTS_PAGE_MAX);
		const rows = this.stmt(
			"SELECT * FROM agent_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
		).all(runId, page?.afterSeq ?? 0, limit) as EventRow[];
		return rows.map(composeEvent).filter((e): e is AgentTraceEventRecord => e !== null);
	}

	/** Per-entity agent history (12d) — events that touched one entity. */
	eventsForEntity(entityId: string, limit?: number): readonly AgentTraceEventRecord[] {
		const rows = this.stmt(
			"SELECT * FROM agent_events WHERE target_entity_id = ? ORDER BY ts DESC LIMIT ?",
		).all(entityId, clampLimit(limit, AGENT_EVENTS_PAGE_MAX, 50)) as EventRow[];
		return rows.map(composeEvent).filter((e): e is AgentTraceEventRecord => e !== null);
	}

	countRuns(): number {
		const row = this.stmt("SELECT COUNT(*) AS n FROM agent_runs").get() as { n: number };
		return Number(row.n);
	}

	countEvents(): number {
		const row = this.stmt("SELECT COUNT(*) AS n FROM agent_events").get() as { n: number };
		return Number(row.n);
	}

	/**
	 * The OQ-AO-1 prune contract, one call: close stale open runs as
	 * `aborted`; age out events (30d) and runs (12mo, events cascading);
	 * count-cap both tables newest-wins — globally AND per principal (the
	 * per-agent cap is the anti-eviction fence: without it one run-spamming
	 * app could roll every other principal's history out of the global
	 * newest-wins window — the 12a pentest's P1). Returns rows deleted
	 * (runs+events) for observability in tests.
	 */
	prune(now: number): number {
		let deleted = 0;
		this.stmt(
			"UPDATE agent_runs SET ended_at = ?, outcome = ? WHERE outcome IS NULL AND started_at < ?",
		).run(now, AgentRunOutcome.Aborted, now - AGENT_RUN_STALE_MS);
		deleted += Number(
			this.stmt("DELETE FROM agent_events WHERE ts < ?").run(now - AGENT_EVENTS_RETENTION_MS).changes,
		);
		deleted += Number(
			this.stmt(
				"DELETE FROM agent_events WHERE run_id IN (SELECT id FROM agent_runs WHERE started_at < ?)",
			).run(now - AGENT_RUNS_RETENTION_MS).changes,
		);
		deleted += Number(
			this.stmt("DELETE FROM agent_runs WHERE started_at < ?").run(now - AGENT_RUNS_RETENTION_MS)
				.changes,
		);
		// Count caps, newest wins. The subselects order by recency and skip the
		// keep-set; everything beyond it goes.
		deleted += Number(
			this.stmt(
				"DELETE FROM agent_events WHERE (run_id, seq) IN (" +
					"SELECT run_id, seq FROM agent_events ORDER BY ts DESC, run_id DESC, seq DESC LIMIT -1 OFFSET ?)",
			).run(AGENT_EVENTS_MAX_ROWS).changes,
		);
		const overflowRuns = this.stmt(
			"SELECT id FROM agent_runs ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?",
		).all(AGENT_RUNS_MAX_ROWS) as Array<{ id: string }>;
		for (const run of overflowRuns) {
			deleted += this.deleteRunCascading(run.id);
		}
		// Per-agent cap (newest wins within each principal).
		const noisyAgents = this.stmt(
			"SELECT agent FROM agent_runs GROUP BY agent HAVING COUNT(*) > ?",
		).all(AGENT_RUNS_PER_AGENT_MAX) as Array<{ agent: string }>;
		for (const { agent } of noisyAgents) {
			const overflow = this.stmt(
				"SELECT id FROM agent_runs WHERE agent = ? ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?",
			).all(agent, AGENT_RUNS_PER_AGENT_MAX) as Array<{ id: string }>;
			for (const run of overflow) {
				deleted += this.deleteRunCascading(run.id);
			}
		}
		return deleted;
	}

	private deleteRunCascading(runId: string): number {
		let deleted = 0;
		deleted += Number(this.stmt("DELETE FROM agent_events WHERE run_id = ?").run(runId).changes);
		deleted += Number(this.stmt("DELETE FROM agent_runs WHERE id = ?").run(runId).changes);
		return deleted;
	}
}
