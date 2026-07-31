/**
 * Channel proposals (Agent-Teams-3) — the propose→approve flow in a shared
 * room, over a real tmpdir vault.
 *
 * The invariants under test are the ones that make dual provenance a claim
 * rather than a decoration: a proposal is staged, never persisted; approval
 * writes exactly one entity stamped with BOTH the proposing agent and the
 * approving human, and neither half comes from the caller; a decision is
 * terminal; and a card whose proposing agent is no longer trusted can never be
 * cashed in.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { ProposeKind, readAgentProvenance } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { ENVELOPE_PROTOCOL_VERSION, validateEnvelope } from "../../ipc/envelope";
import { generateSymmetricKey } from "../credentials/crypto";
import { CredentialStore } from "../credentials/store";
import { MESSAGE_TYPE_URL } from "../roster/mention-notifier";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo";
import { type AgentDirectorySession, type AgentRecord, createAgent } from "./agent-directory";
import {
	AGENTS_APPROVE_CAPABILITY,
	AGENT_PROPOSALS_SERVICE,
	makeAgentProposalServiceHandler,
} from "./agent-proposal-service";
import {
	CHANNEL_PROPOSAL_PROPERTY_KEY,
	ChannelProposalStatus,
	buildProposalProperty,
	isChannelProposeVerb,
	readChannelProposal,
} from "./channel-proposals";

const CHANNEL = "ent_channel_1";
const CHAT_APP = "io.brainstorm.chat";

function ledgerGranting(held: ReadonlySet<string>): CapabilityLedger {
	return { has: (_app: string, cap: string) => held.has(cap) } as unknown as CapabilityLedger;
}

function envelope(method: string, args: unknown[], app = CHAT_APP): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m1",
		app,
		service: AGENT_PROPOSALS_SERVICE,
		method,
		args,
		caps: [AGENTS_APPROVE_CAPABILITY],
	};
}

describe("channel proposals (Agent-Teams-3)", () => {
	let vaultDir: string;
	let stores: DataStores;
	let session: AgentDirectorySession;
	let repo: EntitiesRepository;
	let agent: AgentRecord;
	let selfPubkey: string;
	let idSeq: number;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-proposals-"));
		stores = new DataStores(vaultDir);
		const ledger = new CapabilityLedger(await stores.open("ledger"));
		session = {
			vaultId: "vault_test",
			vaultPath: vaultDir,
			credentials: new CredentialStore(vaultDir, generateSymmetricKey()),
			dataStores: { open: (name) => stores.open(name) },
			capabilityLedger: async () => ledger,
		};
		repo = new EntitiesRepository(await stores.open("entities"));
		agent = await createAgent(session, { displayName: "Researcher" });
		selfPubkey = "self-pubkey-base64";
		idSeq = 0;
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	function handler(held: string[] = [AGENTS_APPROVE_CAPABILITY]) {
		return makeAgentProposalServiceHandler({
			getSession: () => session,
			getSelfPubkey: () => selfPubkey,
			getLedger: async () => ledgerGranting(new Set(held)),
			newId: () => `ent_new_${++idSeq}`,
			now: () => 5000,
		});
	}

	/** A staged card exactly as the mention runner writes one. */
	function stageCard(createdBy = agent.def.fingerprint, id = "msg_card"): string {
		repo.create({
			id,
			type: MESSAGE_TYPE_URL,
			createdBy,
			properties: {
				conversation: CHANNEL,
				body: "Proposed task: Ship the beta — approve it to save it.",
				createdAt: new Date(1000).toISOString(),
				seq: 2,
				[CHANNEL_PROPOSAL_PROPERTY_KEY]: buildProposalProperty({
					id: "prp_1",
					kind: ProposeKind.Task,
					entityType: "brainstorm/Task/v1",
					fields: { title: "Ship the beta", notes: "before friday" },
					summary: "Ship the beta",
				}),
			},
			now: 1000,
			dekId: null,
		});
		return id;
	}

	it("registers under a wire-VALID service name", () => {
		// `SERVICE_PATTERN` is lowercase-and-dashes; `validateEnvelope` runs BEFORE
		// the handler lookup, so a camelCase registration would fail at the wire on
		// every call — the handler would look correct and never be reached.
		expect(AGENT_PROPOSALS_SERVICE).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
		expect(validateEnvelope(envelope("approve", [{ messageId: "m" }])).ok).toBe(true);
	});

	it("only offers the propose verbs the channel path can actually honour", () => {
		expect(isChannelProposeVerb("propose-task")).toBe(true);
		expect(isChannelProposeVerb("propose-note")).toBe(true);
		// Row / database / code-file need live vault schema the channel path does
		// not assemble — offering them would stage un-approvable drafts.
		expect(isChannelProposeVerb("propose-row")).toBe(false);
		expect(isChannelProposeVerb("propose-database")).toBe(false);
		expect(isChannelProposeVerb("propose-code-file")).toBe(false);
		expect(isChannelProposeVerb("open")).toBe(false);
	});

	it("a staged card is a message, not vault data", () => {
		stageCard();
		expect(repo.query({ type: "brainstorm/Task/v1" })).toHaveLength(0);
		const proposal = readChannelProposal(repo.get("msg_card")?.properties ?? {});
		expect(proposal?.status).toBe(ChannelProposalStatus.Pending);
		expect(proposal?.artifact.summary).toBe("Ship the beta");
	});

	it("approve creates ONE entity carrying both provenance halves", async () => {
		stageCard();
		const result = (await handler()(envelope("approve", [{ messageId: "msg_card" }]))) as {
			ok: boolean;
			createdEntityId?: string;
		};
		expect(result.ok).toBe(true);

		const created = repo.query({ type: "brainstorm/Task/v1" });
		expect(created).toHaveLength(1);
		expect(created[0]?.properties.name ?? created[0]?.properties.title).toBeTruthy();
		const provenance = readAgentProvenance(created[0]?.properties);
		expect(provenance?.proposedBy).toBe(agent.def.fingerprint);
		expect(provenance?.approvedBy).toBe(selfPubkey);
		expect(provenance?.conversationId).toBe(CHANNEL);

		// The card settles so every member sees the outcome + the back-link.
		const settled = readChannelProposal(repo.get("msg_card")?.properties ?? {});
		expect(settled?.status).toBe(ChannelProposalStatus.Approved);
		expect(settled?.createdEntityId).toBe(result.createdEntityId);
		expect(settled?.decidedBy).toBe(selfPubkey);
	});

	it("discard settles the card and writes nothing to the vault", async () => {
		stageCard();
		const result = (await handler()(envelope("discard", [{ messageId: "msg_card" }]))) as {
			ok: boolean;
		};
		expect(result.ok).toBe(true);
		expect(repo.query({ type: "brainstorm/Task/v1" })).toHaveLength(0);
		expect(readChannelProposal(repo.get("msg_card")?.properties ?? {})?.status).toBe(
			ChannelProposalStatus.Discarded,
		);
	});

	it("a decision is terminal — approve is not a write oracle", async () => {
		stageCard();
		await handler()(envelope("approve", [{ messageId: "msg_card" }]));
		for (let i = 0; i < 5; i++) {
			await expect(handler()(envelope("approve", [{ messageId: "msg_card" }]))).resolves.toMatchObject(
				{ ok: false, reason: "already-decided" },
			);
		}
		expect(repo.query({ type: "brainstorm/Task/v1" })).toHaveLength(1);
	});

	it("refuses a card whose proposing author is not a trusted agent", async () => {
		// An app-authored card naming itself as the proposer. `createdBy` is
		// host-written on the real path, but the check must hold regardless.
		stageCard("io.evil.app", "msg_forged");
		await expect(
			handler()(envelope("approve", [{ messageId: "msg_forged" }])),
		).resolves.toMatchObject({ ok: false, reason: "untrusted-agent" });
		expect(repo.query({ type: "brainstorm/Task/v1" })).toHaveLength(0);
	});

	it("fails closed without the scarce agents.approve grant", async () => {
		stageCard();
		await expect(handler([])(envelope("approve", [{ messageId: "msg_card" }]))).rejects.toMatchObject(
			{ name: "Denied" },
		);
		expect(repo.query({ type: "brainstorm/Task/v1" })).toHaveLength(0);
	});

	it("refuses an ordinary message and an unknown id", async () => {
		repo.create({
			id: "msg_plain",
			type: MESSAGE_TYPE_URL,
			createdBy: CHAT_APP,
			properties: { conversation: CHANNEL, body: "hello", seq: 1 },
			now: 1000,
			dekId: null,
		});
		await expect(handler()(envelope("approve", [{ messageId: "msg_plain" }]))).resolves.toMatchObject(
			{ ok: false, reason: "not-a-proposal" },
		);
		await expect(handler()(envelope("approve", [{ messageId: "nope" }]))).resolves.toMatchObject({
			ok: false,
			reason: "not-found",
		});
	});

	it("readChannelProposal fails closed on a malformed card", () => {
		for (const bad of [
			{},
			{ [CHANNEL_PROPOSAL_PROPERTY_KEY]: "nope" },
			{ [CHANNEL_PROPOSAL_PROPERTY_KEY]: { status: "pending" } },
			{ [CHANNEL_PROPOSAL_PROPERTY_KEY]: { status: "elsewhere", artifact: {} } },
			{
				// A kind the channel path cannot honour must not render as approvable.
				[CHANNEL_PROPOSAL_PROPERTY_KEY]: {
					status: "pending",
					artifact: {
						id: "x",
						kind: ProposeKind.Database,
						entityType: "brainstorm/List/v1",
						summary: "s",
						fields: {},
					},
				},
			},
		]) {
			expect(readChannelProposal(bad as Record<string, unknown>)).toBeNull();
		}
	});
});
