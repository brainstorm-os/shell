/**
 * Agent mention runner (Agent-Teams-3) — the real path over a tmpdir vault:
 * a human's @-mention runs the shared loop AS THE AGENT PRINCIPAL (the ai
 * envelope carries the agent fingerprint + its live ledger grants), the reply
 * lands in the channel attributed + provenance-stamped, and the security
 * gates hold: no ai.use → honest refusal without a model call; an agent-
 * authored message never actuates another agent (OQ-AT-2, human-in-the-loop);
 * an unknown pubkey mention is a no-op.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { MessageRole, SenderKind, readAgentProvenance } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { generateSymmetricKey } from "../credentials/crypto";
import { CredentialStore } from "../credentials/store";
import { MESSAGE_TYPE_URL } from "../roster/mention-notifier";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo";
import {
	type AgentDirectorySession,
	type AgentRecord,
	createAgent,
	grantAgentCapability,
} from "./agent-directory";
import {
	GENERATE_FAILED_REPLY,
	type MentionRunnerDeps,
	NO_PERMISSION_REPLY,
	buildChannelInstructions,
	maybeRunMentionedAgents,
	projectTranscript,
} from "./mention-runner";

const CHANNEL = "ent_channel_1";

describe("mention-runner (Agent-Teams-3)", () => {
	let vaultDir: string;
	let stores: DataStores;
	let session: AgentDirectorySession;
	let repo: EntitiesRepository;
	let agent: AgentRecord;
	let aiEnvelopes: Envelope[];
	let aiReply: () => Promise<{ content: string }>;
	let wroteCount: number;
	let deps: MentionRunnerDeps;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-mention-"));
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
		agent = await createAgent(session, { displayName: "Researcher", persona: "You research." });
		aiEnvelopes = [];
		aiReply = async () => ({ content: '{"final": "Here is what I found."}' });
		wroteCount = 0;
		deps = {
			getSession: () => session,
			getServiceHandler: (name) =>
				name === "ai"
					? (envelope: Envelope) => {
							aiEnvelopes.push(envelope);
							return aiReply();
						}
					: undefined,
			onWrote: () => {
				wroteCount += 1;
			},
		};
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	function humanMessage(body: string, mentionPubkeys: string[], seq = 1) {
		return repo.create({
			id: `msg_h${seq}`,
			type: MESSAGE_TYPE_URL,
			createdBy: "io.brainstorm.chat",
			properties: {
				conversation: CHANNEL,
				sender: { kind: SenderKind.Participant, personRef: "pk_human", displayName: "Ada" },
				role: MessageRole.User,
				body,
				createdAt: new Date(1000 + seq).toISOString(),
				seq,
				attachments: mentionPubkeys.map((ref) => ({ kind: "person", ref, label: "x" })),
			},
			now: 1000 + seq,
			dekId: null,
		});
	}

	function channelReplies(): Array<Record<string, unknown>> {
		return repo
			.query({ type: MESSAGE_TYPE_URL })
			.filter((r) => (r.properties.role as string) === MessageRole.Assistant)
			.map((r) => r.properties);
	}

	it("runs the mentioned agent AS the agent principal and posts its reply", async () => {
		await grantAgentCapability(session, agent.def.fingerprint, "ai.use");
		const created = humanMessage("@Researcher what do we know?", [agent.def.pubkey]);
		await maybeRunMentionedAgents(deps, created);

		expect(aiEnvelopes).toHaveLength(1);
		expect(aiEnvelopes[0]?.app).toBe(agent.def.fingerprint);
		expect(aiEnvelopes[0]?.caps).toContain("ai.use");

		const replies = channelReplies();
		expect(replies).toHaveLength(1);
		const reply = replies[0] as Record<string, unknown>;
		expect(reply.body).toBe("Here is what I found.");
		expect(reply.conversation).toBe(CHANNEL);
		expect(reply.seq).toBe(2);
		const sender = reply.sender as Record<string, unknown>;
		expect(sender.kind).toBe(SenderKind.Assistant);
		expect(sender.personRef).toBe(agent.def.pubkey);
		expect(sender.displayName).toBe("Researcher");
		expect(readAgentProvenance(reply)?.agent).toBe(agent.def.fingerprint);
		expect(wroteCount).toBe(1);
	});

	it("without ai.use the agent refuses honestly and no model call is made", async () => {
		const created = humanMessage("@Researcher hello", [agent.def.pubkey]);
		await maybeRunMentionedAgents(deps, created);
		expect(aiEnvelopes).toHaveLength(0);
		const replies = channelReplies();
		expect(replies).toHaveLength(1);
		expect(replies[0]?.body).toBe(NO_PERMISSION_REPLY);
	});

	it("an agent-authored message never actuates another agent (human-in-the-loop)", async () => {
		await grantAgentCapability(session, agent.def.fingerprint, "ai.use");
		const other = await createAgent(session, { displayName: "Builder" });
		const agentAuthored = repo.create({
			id: "msg_a1",
			type: MESSAGE_TYPE_URL,
			createdBy: other.def.fingerprint,
			properties: {
				conversation: CHANNEL,
				sender: { kind: SenderKind.Assistant, personRef: other.def.pubkey, displayName: "Builder" },
				role: MessageRole.Assistant,
				body: "ask @Researcher",
				createdAt: new Date(2000).toISOString(),
				seq: 1,
				attachments: [{ kind: "person", ref: agent.def.pubkey, label: "Researcher" }],
			},
			now: 2000,
			dekId: null,
		});
		await maybeRunMentionedAgents(deps, agentAuthored);
		expect(aiEnvelopes).toHaveLength(0);
		expect(channelReplies().filter((r) => r.body !== "ask @Researcher")).toHaveLength(0);
	});

	it("a mention of a pubkey no agent owns is a no-op", async () => {
		const created = humanMessage("@nobody hi", ["pk_not_an_agent"]);
		await maybeRunMentionedAgents(deps, created);
		expect(aiEnvelopes).toHaveLength(0);
		expect(channelReplies()).toHaveLength(0);
	});

	it("a generate failure posts the honest failure reply, never silence", async () => {
		await grantAgentCapability(session, agent.def.fingerprint, "ai.use");
		aiReply = async () => {
			throw new Error("no provider configured");
		};
		const created = humanMessage("@Researcher hello", [agent.def.pubkey]);
		await maybeRunMentionedAgents(deps, created);
		const replies = channelReplies();
		expect(replies).toHaveLength(1);
		expect(replies[0]?.body).toBe(GENERATE_FAILED_REPLY);
	});

	it("feeds the model the channel thread with the agent's own turns as assistant", () => {
		const transcript = projectTranscript(
			[
				{ body: "hi all", senderKind: "participant", personRef: "pk_h", displayName: "Ada" },
				{ body: "On it.", senderKind: "assistant", personRef: "pk_agent", displayName: "R" },
				{ body: "", senderKind: "participant", personRef: "pk_h", displayName: "Ada" },
			],
			"pk_agent",
		);
		expect(transcript).toEqual([
			{ role: MessageRole.User, content: "Ada: hi all" },
			{ role: MessageRole.Assistant, content: "On it." },
		]);
	});

	it("instructions carry the persona and the honesty rule", () => {
		const text = buildChannelInstructions("Researcher", "You research.");
		expect(text).toContain("You are Researcher");
		expect(text).toContain("Never invent facts");
		expect(text).toContain("You research.");
	});
});
