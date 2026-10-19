/**
 * `agent_writes` repository (Agent-15) — the pre-write journal behind an agent
 * run's content diff and its one-operation undo.
 *
 * Every row is one agent-attributed write the entities service committed:
 * `before` holds the prior values of exactly the keys the write touched (with
 * an explicit absent-key list, since JSON cannot carry `undefined`), `after`
 * the values the write left. Both are bounded per row
 * ({@link AGENT_WRITE_VALUE_MAX_BYTES}); an over-size write is journaled as
 * `oversize` with no values, so the diff can say so and undo can refuse
 * instead of half-reverting.
 *
 * Retention is bounded three ways, always pruning WHOLE RUNS so no run is left
 * partially journaled (a partial journal would make undo revert some of a run
 * and silently keep the rest): an age cap, a global row cap, and a PER-PRINCIPAL
 * row cap. The last is the anti-eviction fence — without it one write-spamming
 * app could roll every other agent's undo history out of the global window
 * (the Agent-12a pentest's P1, applied to this table). A run also has its own
 * row ceiling; past it the run is marked oversize and becomes un-undoable.
 *
 * SQL lives only here (CLAUDE.md §Repository pattern for SQL).
 */

import { Buffer } from "node:buffer";
import { type AgentWriteKind, isAgentWriteKind } from "@brainstorm-os/sdk-types";
import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";

/** Age cap — the same window the trace keeps events (OQ-AO-1). */
export const AGENT_WRITES_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Global row cap (newest runs win). */
export const AGENT_WRITES_MAX_ROWS = 20_000;
/** Per-principal row cap — the anti-eviction fence. */
export const AGENT_WRITES_PER_AGENT_MAX = 5_000;
/** Rows one run may journal; beyond it the run is oversize (un-undoable). */
export const AGENT_WRITES_PER_RUN_MAX = 500;
/** Per-side byte ceiling for a journaled value set. */
export const AGENT_WRITE_VALUE_MAX_BYTES = 256 * 1024;

/** The prior values a write replaced: `present` keys had a value (recorded),
 *  `absent` keys did not exist before the write. */
export type AgentWriteBefore = {
	present: Record<string, unknown>;
	absent: string[];
};

export type AgentWriteInsert = {
	runId: string;
	agent: string;
	entityId: string;
	entityType: string;
	kind: AgentWriteKind;
	/** Null for a create (nothing existed before). */
	before: AgentWriteBefore | null;
	/** The values the write left (full bag for a create, touched keys for an
	 *  update, empty for a trash). */
	after: Record<string, unknown>;
	ts: number;
};

export type AgentWriteRecord = {
	id: number;
	runId: string;
	agent: string;
	entityId: string;
	entityType: string;
	kind: AgentWriteKind;
	before: AgentWriteBefore | null;
	after: Record<string, unknown> | null;
	oversize: boolean;
	ts: number;
	revertedAt: number | null;
};

type Row = {
	id: number;
	run_id: string;
	agent: string;
	entity_id: string;
	entity_type: string;
	kind: string;
	before_json: string | null;
	after_json: string | null;
	oversize: number;
	ts: number;
	reverted_at: number | null;
};

function parseJson<T>(raw: string | null): T | null {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function compose(row: Row): AgentWriteRecord | null {
	if (!isAgentWriteKind(row.kind)) return null;
	return {
		id: Number(row.id),
		runId: row.run_id,
		agent: row.agent,
		entityId: row.entity_id,
		entityType: row.entity_type,
		kind: row.kind,
		before: parseJson<AgentWriteBefore>(row.before_json),
		after: parseJson<Record<string, unknown>>(row.after_json),
		oversize: Number(row.oversize) === 1,
		ts: Number(row.ts),
		revertedAt: row.reverted_at === null ? null : Number(row.reverted_at),
	};
}

function boundedJson(value: unknown): string | null {
	const json = JSON.stringify(value);
	return Buffer.byteLength(json, "utf8") > AGENT_WRITE_VALUE_MAX_BYTES ? null : json;
}

export class AgentWritesRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	/** Journal one write. Returns false when the run is already past its row
	 *  ceiling (the overflow is recorded once as an oversize marker). */
	insert(write: AgentWriteInsert): boolean {
		const count = Number(
			(
				this.stmt("SELECT COUNT(*) AS n FROM agent_writes WHERE run_id = ?").get(write.runId) as {
					n: number;
				}
			).n,
		);
		const overflow = count >= AGENT_WRITES_PER_RUN_MAX;
		if (overflow && this.hasOversize(write.runId)) return false;
		this.makeRoomFor(write.agent, write.runId);
		const before = overflow || write.before === null ? null : boundedJson(write.before);
		const after = overflow ? null : boundedJson(write.after);
		const oversize = overflow || after === null || (write.before !== null && before === null);
		this.stmt(
			"INSERT INTO agent_writes (run_id, agent, entity_id, entity_type, kind, before_json, after_json, oversize, ts) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			write.runId,
			write.agent,
			write.entityId,
			write.entityType,
			write.kind,
			oversize ? null : before,
			oversize ? null : after,
			oversize ? 1 : 0,
			write.ts,
		);
		return !overflow;
	}

	/** The per-principal cap, enforced at insert (prune only runs hourly, and
	 *  one app must not grow the table without bound in between): evict the
	 *  agent's oldest OTHER runs, whole, until one more row fits. */
	private makeRoomFor(agent: string, runId: string): void {
		const countFor = this.stmt("SELECT COUNT(*) AS n FROM agent_writes WHERE agent = ?");
		const oldest = this.stmt(
			"SELECT run_id FROM agent_writes WHERE agent = ? AND run_id != ? GROUP BY run_id ORDER BY MIN(id) ASC LIMIT 1",
		);
		const drop = this.stmt("DELETE FROM agent_writes WHERE run_id = ?");
		while (Number((countFor.get(agent) as { n: number }).n) >= AGENT_WRITES_PER_AGENT_MAX) {
			const victim = oldest.get(agent, runId) as { run_id: string } | undefined;
			if (!victim) return;
			drop.run(victim.run_id);
		}
	}

	/** One run's writes, oldest first, clamped. */
	listForRun(runId: string, limit = AGENT_WRITES_PER_RUN_MAX + 1): AgentWriteRecord[] {
		const rows = this.stmt("SELECT * FROM agent_writes WHERE run_id = ? ORDER BY id ASC LIMIT ?").all(
			runId,
			Math.max(1, Math.min(Math.floor(limit), AGENT_WRITES_PER_RUN_MAX + 1)),
		) as Row[];
		return rows.map(compose).filter((r): r is AgentWriteRecord => r !== null);
	}

	/** Every journaled write to one entity strictly after `afterId` — the
	 *  "did anything else write here since" check across runs. */
	laterWritesTo(entityId: string, afterId: number): AgentWriteRecord[] {
		const rows = this.stmt(
			"SELECT * FROM agent_writes WHERE entity_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
		).all(entityId, afterId, AGENT_WRITES_PER_RUN_MAX) as Row[];
		return rows.map(compose).filter((r): r is AgentWriteRecord => r !== null);
	}

	hasOversize(runId: string): boolean {
		return (
			this.stmt("SELECT 1 AS x FROM agent_writes WHERE run_id = ? AND oversize = 1 LIMIT 1").get(
				runId,
			) !== undefined
		);
	}

	markRunReverted(runId: string, at: number): void {
		this.stmt("UPDATE agent_writes SET reverted_at = ? WHERE run_id = ? AND reverted_at IS NULL").run(
			at,
			runId,
		);
	}

	count(): number {
		return Number((this.stmt("SELECT COUNT(*) AS n FROM agent_writes").get() as { n: number }).n);
	}

	/** Enforce the age, global and per-principal caps, a whole run at a time.
	 *  Returns the rows deleted. */
	prune(now: number): number {
		let deleted = Number(
			this.stmt(
				"DELETE FROM agent_writes WHERE run_id IN (SELECT run_id FROM agent_writes GROUP BY run_id HAVING MAX(ts) < ?)",
			).run(now - AGENT_WRITES_RETENTION_MS).changes,
		);
		const runs = this.stmt(
			"SELECT run_id, agent, COUNT(*) AS n FROM agent_writes GROUP BY run_id ORDER BY MAX(id) DESC",
		).all() as Array<{ run_id: string; agent: string; n: number }>;
		let total = 0;
		const perAgent = new Map<string, number>();
		const evict: string[] = [];
		for (const run of runs) {
			const n = Number(run.n);
			const agentTotal = (perAgent.get(run.agent) ?? 0) + n;
			if (total + n > AGENT_WRITES_MAX_ROWS || agentTotal > AGENT_WRITES_PER_AGENT_MAX) {
				evict.push(run.run_id);
				continue;
			}
			total += n;
			perAgent.set(run.agent, agentTotal);
		}
		const drop = this.stmt("DELETE FROM agent_writes WHERE run_id = ?");
		for (const runId of evict) deleted += Number(drop.run(runId).changes);
		return deleted;
	}
}
