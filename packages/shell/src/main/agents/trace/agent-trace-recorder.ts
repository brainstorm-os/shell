/**
 * `AgentTraceRecorder` (Agent-12a) — the ONE writer of the agent trace. The
 * shell writes the trace, never the model and never the app (doc 77
 * §Principles): hosts of the shared `runAgentLoop` (mention runner,
 * automations `AIAgent`) call it around their loop, the broker's dispatch
 * observer feeds it the chat surface's shell-visible activity, and the
 * propose/approve gestures land through the entities / agent-proposals
 * services' callbacks.
 *
 * Contract (each pinned by a test in `agent-trace-recorder.test.ts`):
 *   - FAIL-SOFT: every write path catches + warns; a full disk or a closed
 *     DB never breaks a turn (same posture as `recordAiUsage`).
 *   - NON-FORGEABLE: callers pass the broker-verified principal; the
 *     app-facing service (`agent-trace-service.ts`) only ever passes
 *     `envelope.app`. Nothing here trusts a caller-supplied agent string
 *     from an app.
 *   - METADATA-ONLY: every string is sanitized (bounded + control-stripped)
 *     HERE, at the single choke, regardless of what a hook hands in — the
 *     codec sanitizes too, so hostile bytes must survive two independent
 *     strips to land.
 *   - VAULT-SCOPED: an active run is stamped with the vault key it began
 *     under; after a vault switch the stale in-memory run can neither
 *     receive events nor stamp `ai_usage.run_id` rows in the new vault.
 *
 * Outcome derivation: the recorder derives a chat run's outcome from what the
 * shell OBSERVED (budget denial → `budget`, any error event → `error`, else
 * `ok`) rather than trusting the app's own claim — a compromised app can
 * mislabel nothing. Shell-side hosts (automations) pass explicit outcomes for
 * states only they can know (`aborted`, `refused`).
 */

import {
	AGENT_TRACE_CAPABILITY_MAX,
	AGENT_TRACE_DETAIL_MAX,
	AGENT_TRACE_ID_MAX,
	AGENT_TRACE_TOOL_MAX,
	AI_BUDGET_EXHAUSTED_ERROR_KIND,
	AgentEventKind,
	AgentEventOutcome,
	type AgentLoopStep,
	AgentRunOutcome,
	type AgentRunSurface,
	type AgentTraceEventDraft,
	type LoopTraceContext,
	isAgentEventOutcome,
	loopStepEvents,
	sanitizeTraceText,
} from "@brainstorm-os/sdk-types";
import { ulid } from "ulid";
import type { Envelope } from "../../../ipc/envelope";
import type { AgentTraceRepository } from "./agent-trace-repo";

/** Concurrent open runs one principal may hold; the oldest is auto-closed
 *  `aborted` beyond it, so the in-memory map (and a begin-spamming app's
 *  footprint) stays bounded. */
export const AGENT_TRACE_MAX_ACTIVE_PER_AGENT = 4;

/** How often the opportunistic prune may run (mirrors `AiQuotaService`). */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type AgentTraceRecorderDeps = {
	/** The active vault's trace repo, or null when no vault is open. */
	getRepo: () => Promise<AgentTraceRepository | null>;
	/** Identity of the active vault (its id) — active runs are scoped to it.
	 *  Null when no vault is open. */
	getVaultKey: () => string | null;
	now?: () => number;
	newRunId?: () => string;
};

export type BeginRunInput = {
	surface: AgentRunSurface;
	/** The broker-verified acting principal (app id / Agent/v1 fingerprint). */
	agent: string;
	conversationId?: string | null;
	workflowRunId?: string | null;
};

export type TraceEventInput = {
	kind: AgentEventKind;
	tool?: string;
	targetEntityId?: string | null;
	capability?: string | null;
	outcome?: AgentEventOutcome;
	detail?: string | null;
	durationMs?: number;
};

type ActiveRun = {
	id: string;
	agent: string;
	vaultKey: string;
	sawError: boolean;
	sawBudget: boolean;
};

export class AgentTraceRecorder {
	private readonly deps: AgentTraceRecorderDeps;
	private readonly now: () => number;
	private readonly active = new Map<string, ActiveRun>();
	/** Per-principal open runs, oldest first. */
	private readonly activeByAgent = new Map<string, string[]>();
	private lastPruneMs = 0;

	constructor(deps: AgentTraceRecorderDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}

	/** Open a run. Returns the run id, or null when it could not be recorded
	 *  (no vault / write failure) — callers proceed either way (fail-soft). */
	async beginRun(input: BeginRunInput): Promise<string | null> {
		const vaultKey = this.deps.getVaultKey();
		if (!vaultKey) return null;
		const agent = sanitizeTraceText(input.agent, AGENT_TRACE_ID_MAX);
		if (!agent) return null;
		const id = this.deps.newRunId ? this.deps.newRunId() : `run_${ulid()}`;
		try {
			const repo = await this.deps.getRepo();
			if (!repo) return null;
			await this.capActiveRuns(repo, agent);
			repo.insertRun({
				id,
				surface: input.surface,
				conversationId: nullableId(input.conversationId),
				workflowRunId: nullableId(input.workflowRunId),
				agent,
				startedAt: this.now(),
			});
			this.track({ id, agent, vaultKey, sawError: false, sawBudget: false });
			this.pruneOpportunistically(repo);
			return id;
		} catch (error) {
			warn("begin", error);
			return null;
		}
	}

	/** Append one event. Sanitizes every field at this single choke. */
	async event(runId: string, input: TraceEventInput): Promise<void> {
		try {
			const repo = await this.deps.getRepo();
			if (!repo) return;
			const outcome =
				input.outcome !== undefined && isAgentEventOutcome(input.outcome)
					? input.outcome
					: AgentEventOutcome.Ok;
			repo.insertEvent({
				runId,
				ts: this.now(),
				kind: input.kind,
				tool: sanitizeTraceText(input.tool ?? "", AGENT_TRACE_TOOL_MAX),
				targetEntityId: nullableId(input.targetEntityId),
				capability:
					input.capability == null
						? null
						: sanitizeTraceText(input.capability, AGENT_TRACE_CAPABILITY_MAX) || null,
				outcome,
				detail:
					input.detail == null ? null : sanitizeTraceText(input.detail, AGENT_TRACE_DETAIL_MAX) || null,
				durationMs: boundedMs(input.durationMs),
			});
			if (input.kind === AgentEventKind.ToolDenied) repo.bumpDenialCount(runId);
			const run = this.active.get(runId);
			if (run) {
				if (outcome === AgentEventOutcome.Error || input.kind === AgentEventKind.Error) {
					run.sawError = true;
				}
			}
		} catch (error) {
			warn("event", error);
		}
	}

	/** Append a batch of codec-produced drafts (already metadata-only). */
	async events(runId: string, drafts: readonly AgentTraceEventDraft[]): Promise<void> {
		for (const draft of drafts) {
			await this.event(runId, draft);
		}
	}

	/** Map a finished shell-hosted loop transcript into events (the codec). */
	async recordLoopResult(
		runId: string,
		steps: readonly AgentLoopStep[],
		context: LoopTraceContext,
	): Promise<void> {
		await this.events(runId, loopStepEvents(steps, context));
	}

	/** Close a run. Without an explicit outcome the recorder derives one from
	 *  what it observed (see module doc). */
	async endRun(runId: string, explicit?: AgentRunOutcome): Promise<void> {
		const run = this.active.get(runId);
		this.untrack(runId);
		try {
			const repo = await this.deps.getRepo();
			if (!repo) return;
			const derived = run?.sawBudget
				? AgentRunOutcome.Budget
				: run?.sawError
					? AgentRunOutcome.Error
					: AgentRunOutcome.Ok;
			repo.finishRun(runId, this.now(), explicit ?? derived);
		} catch (error) {
			warn("end", error);
		}
	}

	/** The open run `ai_usage` rows and broker-observed events attach to for
	 *  a principal — newest first, and only within the CURRENT vault. */
	activeRunIdFor(agent: string): string | null {
		const vaultKey = this.deps.getVaultKey();
		if (!vaultKey) return null;
		const ids = this.activeByAgent.get(agent);
		if (!ids || ids.length === 0) return null;
		for (let i = ids.length - 1; i >= 0; i--) {
			const id = ids[i];
			const run = id === undefined ? undefined : this.active.get(id);
			if (run && run.vaultKey === vaultKey) return run.id;
		}
		return null;
	}

	/** Mark the active run as budget-stopped (the AI budget gate refused a
	 *  call) — drives the derived `budget` outcome. */
	noteBudgetStop(runId: string): void {
		const run = this.active.get(runId);
		if (run) run.sawBudget = true;
	}

	/** Record a propose→approve/discard gesture. The approval is a USER act
	 *  that lands after the proposing run ended, so it attaches to the
	 *  principal's most recent run in that conversation (a decision with no
	 *  attributable run is dropped — never a floating row). All identifiers
	 *  come from shell chokepoints (broker-verified app / host-written
	 *  fingerprint), never a caller claim. */
	async recordProposalDecision(input: {
		agent: string;
		conversationId: string;
		approved: boolean;
		entityId?: string | null;
	}): Promise<void> {
		try {
			const repo = await this.deps.getRepo();
			if (!repo) return;
			const agent = sanitizeTraceText(input.agent, AGENT_TRACE_ID_MAX);
			const conversationId = nullableId(input.conversationId);
			if (!agent || !conversationId) return;
			const run = repo.latestRunFor(agent, conversationId);
			if (!run) return;
			await this.event(run.id, {
				kind: input.approved ? AgentEventKind.ProposalApproved : AgentEventKind.ProposalDiscarded,
				targetEntityId: input.entityId ?? null,
				outcome: AgentEventOutcome.Ok,
			});
		} catch (error) {
			warn("decision", error);
		}
	}

	/** Late-bind the persisted `WorkflowRun/v1` entity id onto an automation
	 *  run (the trace run opens BEFORE the run entity exists — see repo). */
	async attachWorkflowRunId(runId: string, workflowRunId: string): Promise<void> {
		try {
			const repo = await this.deps.getRepo();
			if (!repo) return;
			const bounded = nullableId(workflowRunId);
			if (bounded) repo.setWorkflowRunId(runId, bounded);
		} catch (error) {
			warn("attach", error);
		}
	}

	/** Drop all in-memory active-run state (vault close/switch). Rows already
	 *  written stay; the repo's stale sweep closes any left open. */
	reset(): void {
		this.active.clear();
		this.activeByAgent.clear();
	}

	private track(run: ActiveRun): void {
		this.active.set(run.id, run);
		const list = this.activeByAgent.get(run.agent) ?? [];
		list.push(run.id);
		this.activeByAgent.set(run.agent, list);
	}

	private untrack(runId: string): void {
		const run = this.active.get(runId);
		if (!run) return;
		this.active.delete(runId);
		const list = this.activeByAgent.get(run.agent);
		if (!list) return;
		const i = list.indexOf(runId);
		if (i >= 0) list.splice(i, 1);
		if (list.length === 0) this.activeByAgent.delete(run.agent);
	}

	/** Bound the per-principal open-run set: auto-close the oldest beyond the
	 *  cap as `aborted` (a begin-spamming app cannot grow the map). */
	private async capActiveRuns(repo: AgentTraceRepository, agent: string): Promise<void> {
		const list = this.activeByAgent.get(agent);
		if (!list) return;
		while (list.length >= AGENT_TRACE_MAX_ACTIVE_PER_AGENT) {
			const oldest = list[0];
			if (oldest === undefined) break;
			this.untrack(oldest);
			repo.finishRun(oldest, this.now(), AgentRunOutcome.Aborted);
		}
	}

	private pruneOpportunistically(repo: AgentTraceRepository): void {
		const now = this.now();
		if (now - this.lastPruneMs < PRUNE_INTERVAL_MS) return;
		this.lastPruneMs = now;
		repo.prune(now);
	}
}

function nullableId(value: string | null | undefined): string | null {
	if (value == null) return null;
	return sanitizeTraceText(value, AGENT_TRACE_ID_MAX) || null;
}

function boundedMs(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return Math.min(Math.floor(value), 86_400_000);
}

function warn(op: string, error: unknown): void {
	console.warn(`[agent-trace] ${op} failed: ${(error as Error).message}`);
}

// ─── The broker dispatch hook (chat-surface chokepoint) ─────────────────────

/** Services whose successful calls become timeline events for an app with an
 *  open run. `ai` is deliberately absent — model calls live in `ai_usage`
 *  (joined via `run_id`), one accounting substrate (OQ-AO-5). */
enum TracedService {
	Intents = "intents",
	Search = "search",
	Mcp = "mcp",
	Entities = "entities",
	Ai = "ai",
	AgentTrace = "agent-trace",
}

export type BrokerTraceHookDeps = {
	/** Resolve which of the envelope's DECLARED caps the ledger denies for
	 *  this app — the actionable content of a broker-level `tool-denied` row.
	 *  Fail-soft: a throw/null reads as "unknown" (empty capability). */
	findMissingCapability?: (
		app: string,
		declaredCaps: readonly string[],
	) => Promise<string | null> | string | null;
};

/** The tool name a dispatch reads as. ONLY whitelisted metadata is extracted
 *  from `args` — an intent's verb, an MCP call's server/tool name — never an
 *  argument value (pinned by the property test over hostile envelopes). */
export function dispatchToolName(envelope: Envelope): string {
	const arg =
		envelope.args[0] && typeof envelope.args[0] === "object"
			? (envelope.args[0] as Record<string, unknown>)
			: {};
	if (envelope.service === TracedService.Intents) {
		return typeof arg.verb === "string" && arg.verb.length > 0
			? arg.verb
			: `${envelope.service}.${envelope.method}`;
	}
	if (envelope.service === TracedService.Mcp) {
		const server = typeof arg.serverId === "string" ? arg.serverId : "";
		const tool = typeof arg.toolName === "string" ? arg.toolName : "";
		return server || tool ? `${server}/${tool}` : `${envelope.service}.${envelope.method}`;
	}
	return `${envelope.service}.${envelope.method}`;
}

function eventKindForService(service: string): AgentEventKind | null {
	switch (service) {
		case TracedService.Intents:
			return AgentEventKind.ToolCall;
		case TracedService.Search:
			return AgentEventKind.Retrieval;
		case TracedService.Mcp:
			return AgentEventKind.McpCall;
		default:
			return null;
	}
}

/** Denials worth a `tool-denied` row: the act/read/model surfaces an agent
 *  loop actually drives. Anything else (settings, storage, …) is app chrome
 *  noise for this timeline — the audit log still records it. */
const DENIAL_TRACED_SERVICES = new Set<string>([
	TracedService.Intents,
	TracedService.Search,
	TracedService.Mcp,
	TracedService.Entities,
	TracedService.Ai,
]);

/**
 * Build the broker `onDispatched` observer: correlates each identity-verified
 * envelope with the calling principal's open run and appends the matching
 * event. Successes map per service (intents → tool-call, search → retrieval,
 * mcp → mcp-call); ANY traced service's denial maps to `tool-denied` naming
 * the missing capability where derivable. Envelopes from principals with no
 * open run are ignored — the hook can never mint rows for bystander apps.
 */
export function makeBrokerTraceObserver(
	recorder: AgentTraceRecorder,
	deps: BrokerTraceHookDeps = {},
): (envelope: Envelope, outcome: { ok: boolean; errorKind?: string; durationMs: number }) => void {
	return (envelope, outcome) => {
		// The trace's own service must not trace itself (begin-turn recursion).
		if (envelope.service === TracedService.AgentTrace) return;
		const runId = recorder.activeRunIdFor(envelope.app);
		if (!runId) return;

		const denied =
			!outcome.ok &&
			DENIAL_TRACED_SERVICES.has(envelope.service) &&
			(outcome.errorKind === "CapabilityDenied" ||
				outcome.errorKind === "Denied" ||
				outcome.errorKind === AI_BUDGET_EXHAUSTED_ERROR_KIND);
		const kind = eventKindForService(envelope.service);

		if (denied) {
			if (outcome.errorKind === AI_BUDGET_EXHAUSTED_ERROR_KIND) recorder.noteBudgetStop(runId);
			void (async () => {
				let capability: string | null = null;
				try {
					capability = (await deps.findMissingCapability?.(envelope.app, envelope.caps)) ?? null;
				} catch {
					capability = null;
				}
				// Re-check after the await: a vault switch mid-resolution must not
				// write an orphan event (a run id from vault A) into vault B's DB.
				if (recorder.activeRunIdFor(envelope.app) !== runId) return;
				await recorder.event(runId, {
					kind: AgentEventKind.ToolDenied,
					tool: dispatchToolName(envelope),
					capability,
					outcome: AgentEventOutcome.Denied,
					detail: outcome.errorKind ?? null,
					durationMs: outcome.durationMs,
				});
			})();
			return;
		}

		if (!kind) return;
		void recorder.event(runId, {
			kind,
			tool: dispatchToolName(envelope),
			outcome: outcome.ok ? AgentEventOutcome.Ok : AgentEventOutcome.Error,
			detail: outcome.ok ? null : (outcome.errorKind ?? null),
			durationMs: outcome.durationMs,
		});
	};
}
