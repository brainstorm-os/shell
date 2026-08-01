import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentEventKind,
	AgentRunOutcome,
	type AgentRunSummary,
	AgentRunSurface,
	type AgentTraceEventRecord,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../../ipc/envelope";
import { DataStores } from "../../storage/data-stores";
import { AgentTraceRecorder } from "./agent-trace-recorder";
import {
	AGENT_EVENTS_PAGE_MAX,
	AGENT_RUNS_PAGE_MAX,
	AgentTraceRepository,
} from "./agent-trace-repo";
import { makeAgentTraceServiceHandler } from "./agent-trace-service";

const APP = "io.brainstorm.agent";
const OTHER = "io.example.other";

function envelope(method: string, arg: unknown, app = APP): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: `m_${Math.random().toString(36).slice(2)}`,
		app,
		service: "agent-trace",
		method,
		args: [arg],
		caps: [],
	};
}

describe("agent-trace service (app-facing demarcation + own-runs reads)", () => {
	let vaultDir: string;
	let stores: DataStores;
	let repo: AgentTraceRepository;
	let recorder: AgentTraceRecorder;
	let handler: ReturnType<typeof makeAgentTraceServiceHandler>;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-agent-trace-svc-"));
		stores = new DataStores(vaultDir);
		repo = new AgentTraceRepository(await stores.open("account"));
		recorder = new AgentTraceRecorder({
			getRepo: async () => repo,
			getVaultKey: () => "vault-1",
		});
		handler = makeAgentTraceServiceHandler({ recorder, getRepo: async () => repo });
	});
	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("beginTurn pins the principal to envelope.app and the surface to chat", async () => {
		const reply = (await handler(
			envelope("beginTurn", {
				conversationId: "conv-1",
				// Forgery attempts — none of these are even parameters:
				agent: OTHER,
				surface: AgentRunSurface.Automation,
			}),
		)) as { runId: string | null };
		expect(reply.runId).toBeTruthy();
		expect(repo.getRun(reply.runId as string)).toMatchObject({
			agent: APP,
			surface: AgentRunSurface.Chat,
			conversationId: "conv-1",
		});
	});

	it("endTurn closes only the caller's own run; a foreign id is a silent no-op", async () => {
		const mine = (await handler(envelope("beginTurn", { conversationId: "c" }))) as {
			runId: string;
		};
		const theirs = (await handler(envelope("beginTurn", { conversationId: "c" }, OTHER))) as {
			runId: string;
		};
		// APP tries to close OTHER's run.
		const forged = (await handler(envelope("endTurn", { runId: theirs.runId }))) as {
			ended: boolean;
		};
		expect(forged.ended).toBe(false);
		expect(repo.getRun(theirs.runId)?.outcome).toBeNull(); // still open
		const own = (await handler(envelope("endTurn", { runId: mine.runId }))) as { ended: boolean };
		expect(own.ended).toBe(true);
		expect(repo.getRun(mine.runId)?.outcome).toBe(AgentRunOutcome.Ok);
	});

	it("listRuns is scoped to envelope.app — a caller-supplied agent filter cannot widen it", async () => {
		repo.insertRun({
			id: "r_other",
			surface: AgentRunSurface.Chat,
			conversationId: "c",
			workflowRunId: null,
			agent: OTHER,
			startedAt: 5,
		});
		repo.insertRun({
			id: "r_mine",
			surface: AgentRunSurface.Chat,
			conversationId: "c",
			workflowRunId: null,
			agent: APP,
			startedAt: 6,
		});
		const reply = (await handler(envelope("listRuns", { agent: OTHER, conversationId: "c" }))) as {
			runs: readonly AgentRunSummary[];
		};
		expect(reply.runs.map((r) => r.id)).toEqual(["r_mine"]);
	});

	it("listEvents on a foreign run reads as empty — no existence oracle", async () => {
		repo.insertRun({
			id: "r_other",
			surface: AgentRunSurface.Chat,
			conversationId: null,
			workflowRunId: null,
			agent: OTHER,
			startedAt: 1,
		});
		repo.insertEvent({
			runId: "r_other",
			ts: 1,
			kind: AgentEventKind.ToolCall,
			tool: "open",
			targetEntityId: null,
			capability: null,
			outcome: "ok" as AgentTraceEventRecord["outcome"],
			detail: null,
			durationMs: 0,
		});
		const foreign = (await handler(envelope("listEvents", { runId: "r_other" }))) as {
			events: readonly AgentTraceEventRecord[];
		};
		const missing = (await handler(envelope("listEvents", { runId: "r_nope" }))) as {
			events: readonly AgentTraceEventRecord[];
		};
		expect(foreign.events).toEqual([]);
		expect(missing.events).toEqual([]);
	});

	it("clamps page sizes on both reads", async () => {
		for (let i = 0; i < AGENT_RUNS_PAGE_MAX + 50; i++) {
			repo.insertRun({
				id: `r${i}`,
				surface: AgentRunSurface.Chat,
				conversationId: null,
				workflowRunId: null,
				agent: APP,
				startedAt: i,
			});
		}
		const runsReply = (await handler(envelope("listRuns", { limit: 999_999 }))) as {
			runs: readonly AgentRunSummary[];
		};
		expect(runsReply.runs.length).toBeLessThanOrEqual(AGENT_RUNS_PAGE_MAX);

		const eventsReply = (await handler(envelope("listEvents", { runId: "r0", limit: 999_999 }))) as {
			events: readonly AgentTraceEventRecord[];
		};
		expect(eventsReply.events.length).toBeLessThanOrEqual(AGENT_EVENTS_PAGE_MAX);
	});

	it("fails Unavailable (fail-closed) on reads with no vault; unknown method is Invalid", async () => {
		const noVault = makeAgentTraceServiceHandler({ recorder, getRepo: async () => null });
		await expect(noVault(envelope("listRuns", {}))).rejects.toMatchObject({
			name: "Unavailable",
		});
		await expect(handler(envelope("selfDestruct", {}))).rejects.toMatchObject({
			name: "Invalid",
		});
	});
});
