/**
 * Agent activity privileged IPC (Agent-12d — doc 77 §Surfaces #3, Settings →
 * AI). The vault-wide "what did agents do" query surface: runs filtered by
 * surface / app / date / outcome with denials-only first-class, one run's
 * ordered events, per-entity agent history (the `target_entity_id` query),
 * and the distinct-principal list for the app filter.
 *
 * Reached over direct `ipcMain` from the privileged dashboard renderer, like
 * every other Settings surface — NOT the app broker. This is deliberate
 * (OQ-AO-2, resolved shell-surfaces-only): there is NO app-facing capability
 * for vault-wide trace reads, so a sandboxed app cannot reach this data at
 * all — its preload exposes only the curated bridge, never raw
 * `ipcRenderer`, and the broker has no service pointing here.
 *
 * Projection posture (doc 77 §Security): rows never cross IPC raw — every
 * reply is the bounded `AgentRunSummary` / `AgentTraceEventRecord` shape the
 * repo composes, every string in it already sanitized at write time by the
 * recorder. Every page size is clamped HERE, at the main-process end, on top
 * of the repo's own clamps — a hostile/buggy renderer cannot induce an
 * unbounded scan-and-marshal. Metadata only, absolutely (OQ-AO-3): no field
 * carrying prompt/completion bytes exists in the substrate, and this surface
 * adds none.
 */

import {
	AGENT_TRACE_ID_MAX,
	type AgentRunSummary,
	type AgentTraceEventRecord,
	isAgentRunOutcome,
	isAgentRunSurface,
	sanitizeTraceText,
} from "@brainstorm-os/sdk-types";
import { ipcMain } from "electron";
import type { AgentRunFilter, AgentTraceRepository } from "../agents/trace/agent-trace-repo";
import { AGENT_EVENTS_PAGE_MAX, AGENT_RUNS_PAGE_MAX } from "../agents/trace/agent-trace-repo";
import { getActiveVaultSession } from "../vault/session";

export const AGENT_ACTIVITY_RUNS_CHANNEL = "agent-activity:runs" as const;
export const AGENT_ACTIVITY_EVENTS_CHANNEL = "agent-activity:events" as const;
export const AGENT_ACTIVITY_ENTITY_HISTORY_CHANNEL = "agent-activity:entity-history" as const;
export const AGENT_ACTIVITY_AGENTS_CHANNEL = "agent-activity:agents" as const;

/** The 12d list-runs page ceiling: smaller than the repo's absolute clamp —
 *  a Settings list never needs 100 rows per page. */
export const AGENT_ACTIVITY_RUNS_PAGE_MAX = 50;
export const AGENT_ACTIVITY_RUNS_PAGE_DEFAULT = 25;

/** What the renderer may ask for. Everything optional; everything validated
 *  here — an out-of-vocabulary value is DROPPED, never passed through. */
export type AgentActivityRunsQuery = {
	surface?: string;
	agent?: string;
	outcome?: string;
	sinceTs?: number;
	untilTs?: number;
	denialsOnly?: boolean;
	beforeStartedAt?: number;
	limit?: number;
};

export type AgentActivityRunsView = { runs: readonly AgentRunSummary[] };
export type AgentActivityEventsView = { events: readonly AgentTraceEventRecord[] };
export type AgentActivityAgentsView = { agents: readonly string[] };

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPage(value: unknown, max: number, fallback: number): number {
	const n = optionalNumber(value);
	if (n === undefined || n < 1) return fallback;
	return Math.min(Math.floor(n), max);
}

/** Raw renderer query → the repo's typed filter. Enum fields pass the shared
 *  guards or are dropped; ids are bounded + control-stripped; the limit is
 *  clamped to this surface's own ceiling (below the repo's). Exported pure
 *  for tests. */
export function coerceRunsQuery(raw: unknown): AgentRunFilter {
	const q = raw && typeof raw === "object" ? (raw as AgentActivityRunsQuery) : {};
	const agent = sanitizeTraceText(q.agent, AGENT_TRACE_ID_MAX);
	const sinceTs = optionalNumber(q.sinceTs);
	const untilTs = optionalNumber(q.untilTs);
	const beforeStartedAt = optionalNumber(q.beforeStartedAt);
	return {
		...(isAgentRunSurface(q.surface) ? { surface: q.surface } : {}),
		...(agent ? { agent } : {}),
		...(isAgentRunOutcome(q.outcome) ? { outcome: q.outcome } : {}),
		...(sinceTs !== undefined ? { sinceTs } : {}),
		...(untilTs !== undefined ? { untilTs } : {}),
		...(q.denialsOnly === true ? { denialsOnly: true } : {}),
		...(beforeStartedAt !== undefined ? { beforeStartedAt } : {}),
		limit: clampPage(q.limit, AGENT_ACTIVITY_RUNS_PAGE_MAX, AGENT_ACTIVITY_RUNS_PAGE_DEFAULT),
	};
}

/** The four reads as pure functions over the repo — the ipcMain glue below
 *  is one line each, and tests drive these against a real repository. */
export function agentActivityRuns(repo: AgentTraceRepository, raw: unknown): AgentActivityRunsView {
	return { runs: repo.listRuns(coerceRunsQuery(raw)) };
}

export function agentActivityEvents(
	repo: AgentTraceRepository,
	rawRunId: unknown,
	rawAfterSeq: unknown,
): AgentActivityEventsView {
	const runId = sanitizeTraceText(rawRunId, AGENT_TRACE_ID_MAX);
	if (!runId) return { events: [] };
	const afterSeq = optionalNumber(rawAfterSeq);
	return {
		events: repo.listEvents(runId, {
			...(afterSeq !== undefined ? { afterSeq } : {}),
			limit: AGENT_EVENTS_PAGE_MAX,
		}),
	};
}

export function agentActivityEntityHistory(
	repo: AgentTraceRepository,
	rawEntityId: unknown,
): AgentActivityEventsView {
	const entityId = sanitizeTraceText(rawEntityId, AGENT_TRACE_ID_MAX);
	if (!entityId) return { events: [] };
	return { events: repo.eventsForEntity(entityId) };
}

export function agentActivityAgents(repo: AgentTraceRepository): AgentActivityAgentsView {
	return { agents: repo.listAgents(AGENT_RUNS_PAGE_MAX) };
}

/** The active vault's trace repo, or null (no vault open → empty views). */
async function activeRepo(): Promise<AgentTraceRepository | null> {
	const session = getActiveVaultSession();
	return session ? await session.agentTraceRepo() : null;
}

export function registerAgentActivityHandlers(): void {
	ipcMain.handle(
		AGENT_ACTIVITY_RUNS_CHANNEL,
		async (_event, query: unknown): Promise<AgentActivityRunsView> => {
			const repo = await activeRepo();
			return repo ? agentActivityRuns(repo, query) : { runs: [] };
		},
	);

	ipcMain.handle(
		AGENT_ACTIVITY_EVENTS_CHANNEL,
		async (_event, runId: unknown, afterSeq: unknown): Promise<AgentActivityEventsView> => {
			const repo = await activeRepo();
			return repo ? agentActivityEvents(repo, runId, afterSeq) : { events: [] };
		},
	);

	ipcMain.handle(
		AGENT_ACTIVITY_ENTITY_HISTORY_CHANNEL,
		async (_event, entityId: unknown): Promise<AgentActivityEventsView> => {
			const repo = await activeRepo();
			return repo ? agentActivityEntityHistory(repo, entityId) : { events: [] };
		},
	);

	ipcMain.handle(AGENT_ACTIVITY_AGENTS_CHANNEL, async (): Promise<AgentActivityAgentsView> => {
		const repo = await activeRepo();
		return repo ? agentActivityAgents(repo) : { agents: [] };
	});
}
