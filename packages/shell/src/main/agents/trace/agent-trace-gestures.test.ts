/**
 * Agent-12a — the propose→approve gesture chokepoint through the REAL
 * entities service: a provenance-carrying `entities.create` (the Agent app's
 * approve-persist path) lands a `proposal-approved` trace event on the
 * caller's latest run in that conversation, attributed from the
 * broker-verified `envelope.app` — an app can neither forge the event for
 * another principal nor suppress the stamp by smuggling reserved keys.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityLedger, GrantedVia } from "@brainstorm-os/capabilities/ledger";
import { AgentEventKind, AgentRunSurface } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../../ipc/envelope";
import { makeEntitiesServiceHandler } from "../../entities/entities-service";
import { DataStores } from "../../storage/data-stores";
import { EntitiesRepository } from "../../storage/entities-repo";
import { AgentTraceRecorder } from "./agent-trace-recorder";
import { AgentTraceRepository } from "./agent-trace-repo";

const APP = "io.brainstorm.agent";
const NOTE = "brainstorm/Note/v1";

describe("Agent-12a — approve gesture via entities.create(provenance)", () => {
	let vaultDir: string;
	let stores: DataStores;
	let repo: EntitiesRepository;
	let ledger: CapabilityLedger;
	let traceRepo: AgentTraceRepository;
	let recorder: AgentTraceRecorder;
	let entSeq: number;
	let dekSeq: number;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-trace-gesture-"));
		stores = new DataStores(vaultDir);
		ledger = new CapabilityLedger(await stores.open("ledger"));
		repo = new EntitiesRepository(await stores.open("entities"));
		traceRepo = new AgentTraceRepository(await stores.open("account"));
		recorder = new AgentTraceRecorder({
			getRepo: async () => traceRepo,
			getVaultKey: () => "vault-1",
		});
		entSeq = 0;
		dekSeq = 0;
		ledger.grant({
			appId: APP,
			capability: "entities.write",
			scope: "*",
			grantedVia: GrantedVia.Runtime,
		});
	});
	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	function handler() {
		return makeEntitiesServiceHandler({
			getRepo: async () => repo,
			getLedger: async () => ledger,
			getDekStore: async () => ({
				nextDekId: () => `dek_${++dekSeq}`,
				persist: () => ({ dek: new Uint8Array(32) }),
				open: () => null,
				close: () => {},
			}),
			now: () => 1000,
			newId: () => `ent_new_${++entSeq}`,
			onAgentProvenanceCreate: ({
				app,
				conversationId,
				entityId,
			}: {
				app: string;
				conversationId: string;
				entityId: string;
			}) => {
				void recorder.recordProposalDecision({
					agent: app,
					conversationId,
					approved: true,
					entityId,
				});
			},
		} as unknown as Parameters<typeof makeEntitiesServiceHandler>[0]);
	}

	function createEnvelope(args: unknown[], app = APP): Envelope {
		return {
			v: ENVELOPE_PROTOCOL_VERSION,
			msg: "m1",
			app,
			service: "entities",
			method: "create",
			args,
			caps: ["entities.write:*"],
		};
	}

	async function flush(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	it("records proposal-approved on the caller's latest run in that conversation", async () => {
		const runId = (await recorder.beginRun({
			surface: AgentRunSurface.Chat,
			agent: APP,
			conversationId: "conv-1",
		})) as string;
		await recorder.endRun(runId); // approval is post-turn

		const created = (await handler()(
			createEnvelope([
				{
					type: NOTE,
					properties: { title: "Draft" },
					provenance: { conversationId: "conv-1" },
				},
			]),
		)) as { id: string };
		await flush();

		const events = traceRepo.listEvents(runId);
		expect(events.map((e) => [e.kind, e.targetEntityId])).toEqual([
			[AgentEventKind.ProposalApproved, created.id],
		]);
	});

	it("a create WITHOUT a provenance request records nothing", async () => {
		const runId = (await recorder.beginRun({
			surface: AgentRunSurface.Chat,
			agent: APP,
			conversationId: "conv-1",
		})) as string;
		await handler()(createEnvelope([{ type: NOTE, properties: { title: "Plain" } }]));
		await flush();
		expect(traceRepo.listEvents(runId)).toEqual([]);
	});

	it("cannot be attributed to another principal's run (envelope.app wins)", async () => {
		const otherRun = (await recorder.beginRun({
			surface: AgentRunSurface.Chat,
			agent: "io.other.app",
			conversationId: "conv-1",
		})) as string;
		ledger.grant({
			appId: "io.evil.app",
			capability: "entities.write",
			scope: "*",
			grantedVia: GrantedVia.Runtime,
		});
		// io.evil.app creates with a provenance request naming the SAME
		// conversation — the event may only ever land on ITS runs (it has
		// none), never on io.other.app's.
		await handler()(
			createEnvelope(
				[{ type: NOTE, properties: {}, provenance: { conversationId: "conv-1" } }],
				"io.evil.app",
			),
		);
		await flush();
		expect(traceRepo.listEvents(otherRun)).toEqual([]);
	});
});
