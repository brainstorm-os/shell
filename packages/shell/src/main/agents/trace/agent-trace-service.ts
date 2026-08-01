/**
 * The `agent-trace` broker service (Agent-12a) — the app-facing edge of the
 * trace substrate. Two jobs:
 *
 *   1. TURN DEMARCATION for the chat surface. The Agent app's loop runs in
 *      its renderer, so the shell needs a begin/end signal to bracket a turn
 *      — but ONLY the bracket comes from the app. The run's `agent` column is
 *      always the broker-verified `envelope.app`; the events inside come from
 *      the shell's own chokepoints (the broker dispatch observer, the
 *      propose/approve callbacks, `ai_usage.run_id`); and the outcome is
 *      DERIVED by the recorder from what the shell observed — `end-turn`
 *      takes no outcome argument at all. An app can therefore bracket and
 *      label nothing but its own activity, and cannot suppress the shell's
 *      rows within the bracket.
 *
 *   2. OWN-RUNS READS (OQ-AO-2, resolved shell-surfaces-only). An app may
 *      list ITS OWN runs/events — the data mirrors what its conversation
 *      already displayed — scoped by `envelope.app`, never by a caller
 *      argument, and with NO new capability (there is deliberately no
 *      `agent.trace:read`; the vault-wide view is the privileged shell
 *      renderer via its own ipcMain surface). Reads return bounded, paginated
 *      projections (`AgentRunSummary` / `AgentTraceEventRecord`), never raw
 *      rows. A foreign `runId` reads as not-found — existence is never
 *      surfaced across principals.
 */

import {
	AGENT_TRACE_ID_MAX,
	type AgentRunSummary,
	AgentRunSurface,
	type AgentTraceEventRecord,
	sanitizeTraceText,
} from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../../ipc/broker";
import type { Envelope } from "../../../ipc/envelope";
import type { AgentTraceRecorder } from "./agent-trace-recorder";
import {
	AGENT_EVENTS_PAGE_MAX,
	AGENT_RUNS_PAGE_MAX,
	type AgentTraceRepository,
} from "./agent-trace-repo";

export type AgentTraceServiceOptions = {
	recorder: AgentTraceRecorder;
	/** The active vault's trace repo, or null when no vault is open. */
	getRepo: () => Promise<AgentTraceRepository | null>;
};

enum AgentTraceMethod {
	BeginTurn = "beginTurn",
	EndTurn = "endTurn",
	ListRuns = "listRuns",
	ListEvents = "listEvents",
}

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function arg(envelope: Envelope): Record<string, unknown> {
	const a = envelope.args[0];
	return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function makeAgentTraceServiceHandler(options: AgentTraceServiceOptions): ServiceHandler {
	const requireRepo = async (): Promise<AgentTraceRepository> => {
		const repo = await options.getRepo();
		if (!repo) throw makeError("Unavailable", "agent-trace: no active vault session");
		return repo;
	};

	/** A run the CALLER owns, or null — a foreign run id is indistinguishable
	 *  from a missing one (no cross-principal existence oracle). */
	const ownRun = async (envelope: Envelope, runId: string): Promise<AgentRunSummary | null> => {
		if (!runId) return null;
		const repo = await requireRepo();
		const run = repo.getRun(runId);
		return run && run.agent === envelope.app ? run : null;
	};

	return async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case AgentTraceMethod.BeginTurn: {
				// SECURITY: the principal is the verified envelope app — a caller-
				// supplied `agent` is not even a parameter. Surface is pinned to
				// `chat`: the automation surface is shell-internal (the host begins
				// those runs itself) and must not be claimable from a renderer.
				const conversationId = sanitizeTraceText(arg(envelope).conversationId, AGENT_TRACE_ID_MAX);
				const runId = await options.recorder.beginRun({
					surface: AgentRunSurface.Chat,
					agent: envelope.app,
					conversationId: conversationId || null,
				});
				return { runId };
			}

			case AgentTraceMethod.EndTurn: {
				const runId = String(arg(envelope).runId ?? "");
				const run = await ownRun(envelope, runId);
				// Fail-soft like every trace write: an unknown/foreign id is a
				// no-op, not an error a probing app can learn from.
				if (run && run.endedAt === null) await options.recorder.endRun(run.id);
				return { ended: run !== null };
			}

			case AgentTraceMethod.ListRuns: {
				const a = arg(envelope);
				const repo = await requireRepo();
				const conversationId = sanitizeTraceText(a.conversationId, AGENT_TRACE_ID_MAX);
				// 12c — the WorkflowRun/v1 drill-in join. Still scoped to the
				// caller's own runs: the agent predicate below is non-negotiable.
				const workflowRunId = sanitizeTraceText(a.workflowRunId, AGENT_TRACE_ID_MAX);
				const runs = repo.listRuns({
					agent: envelope.app,
					...(conversationId ? { conversationId } : {}),
					...(workflowRunId ? { workflowRunId } : {}),
					...(optionalNumber(a.beforeStartedAt) !== undefined
						? { beforeStartedAt: optionalNumber(a.beforeStartedAt) as number }
						: {}),
					limit: Math.min(optionalNumber(a.limit) ?? 20, AGENT_RUNS_PAGE_MAX),
				});
				return { runs };
			}

			case AgentTraceMethod.ListEvents: {
				const a = arg(envelope);
				const runId = String(a.runId ?? "");
				const run = await ownRun(envelope, runId);
				if (!run) return { events: [] as AgentTraceEventRecord[] };
				const repo = await requireRepo();
				const events = repo.listEvents(run.id, {
					...(optionalNumber(a.afterSeq) !== undefined
						? { afterSeq: optionalNumber(a.afterSeq) as number }
						: {}),
					limit: Math.min(optionalNumber(a.limit) ?? AGENT_EVENTS_PAGE_MAX, AGENT_EVENTS_PAGE_MAX),
				});
				return { events };
			}

			default:
				throw makeError("Invalid", `unknown agent-trace method: ${envelope.method}`);
		}
	};
}
