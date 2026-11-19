/**
 * Agent-13 — `@agent` in Chat, through the layers the RUNNING apps pass.
 *
 * The runner's own suite proves the logic against hand-written grants. This
 * proves the shipped MANIFESTS carry it: the real `apps/chat` and `apps/agent`
 * manifests are installed by the real `AppInstaller` into a real ledger and
 * registry, and every app-side call is the exact envelope the SDK proxy builds,
 * dispatched through the real `Broker` with a production-equivalent capability
 * check. If Chat could not invoke, or the Agent app could not reply, in a real
 * vault, this fails here — with the denial, not a silence.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import {
	AGENT_PROPOSAL_PREVIEW_PROPERTY_KEY,
	AttachmentKind,
	BUILTIN_AGENT_APP_ID,
	BUILTIN_AGENT_MENTION_REF,
	MessageRole,
	SenderKind,
	readAgentProvenance,
	readBuiltinAgentMentionTarget,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Broker } from "../../ipc/broker";
import { type Envelope, makeEnvelope } from "../../ipc/envelope";
import {
	AGENT_PROPOSALS_SERVICE,
	makeAgentProposalServiceHandler,
} from "../agents/agent-proposal-service";
import {
	type BuiltinAgentRunnerDeps,
	maybeRunBuiltinAgent,
	resolveBuiltinAgentMentionTarget,
} from "../agents/builtin-agent-runner";
import { CHANNEL_PROPOSAL_PROPERTY_KEY, ChannelProposalStatus } from "../agents/channel-proposals";
import { AGENTS_MENTION_CAPABILITY, grantString } from "../agents/mention-runner";
import { AppInstaller } from "../apps/installer";
import { generateSymmetricKey } from "../credentials/crypto";
import { CredentialStore } from "../credentials/store";
import { makeEntitiesServiceHandler } from "../entities/entities-service";
import { EntityDekStore } from "../entities/entity-dek-store";
import { MESSAGE_TYPE_URL } from "../roster/mention-notifier";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";
import { AppsRepository } from "../storage/registry-repo/apps-repo";

const CHAT_APP = "io.brainstorm.chat";
const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";
const TASK_TYPE = "brainstorm/Task/v1";
const SELF = "self-pubkey-base64";
const APPS_DIR = fileURLToPath(new URL("../../../../../apps", import.meta.url));

/** A minimal installable bundle around an app's REAL manifest. */
async function bundleFor(app: string, into: string): Promise<string> {
	const dir = join(into, app);
	await mkdir(join(dir, "dist"), { recursive: true });
	await cp(join(APPS_DIR, app, "manifest.json"), join(dir, "manifest.json"));
	await cp(join(APPS_DIR, app, "icon.svg"), join(dir, "icon.svg"));
	const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
		entry: string;
	};
	await writeFile(join(dir, manifest.entry), "<!doctype html>", "utf8");
	return dir;
}

describe("@agent in Chat — real manifests → installer → ledger → broker (Agent-13)", () => {
	let vaultDir: string;
	let sourceDir: string;
	let stores: DataStores;
	let ledger: CapabilityLedger;
	let installer: AppInstaller;
	let repo: EntitiesRepository;
	let broker: Broker;
	let aiCalls: Envelope[];
	let aiScript: string[];
	let runs: Promise<void>[];
	let idSeq: number;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-agent13-"));
		sourceDir = await mkdtemp(join(tmpdir(), "bs-agent13-src-"));
		stores = new DataStores(vaultDir);
		ledger = new CapabilityLedger(await stores.open("ledger"));
		installer = new AppInstaller(vaultDir, await stores.open("registry"), ledger);
		repo = new EntitiesRepository(await stores.open("entities"));
		const dekStore = new EntityDekStore(
			new EntityDeksRepository(await stores.open("entities")),
			generateSymmetricKey(),
		);
		aiCalls = [];
		aiScript = [];
		runs = [];
		idSeq = 0;

		const session = {
			vaultId: "vault_test",
			vaultPath: vaultDir,
			credentials: new CredentialStore(vaultDir, generateSymmetricKey()),
			dataStores: { open: (name: "entities") => stores.open(name) },
			capabilityLedger: async () => ledger,
		};
		const entitiesHandler = makeEntitiesServiceHandler({
			getRepo: async () => repo,
			getLedger: async () => ledger,
			getDekStore: async () => dekStore,
			newId: () => `ent_${++idSeq}`,
		});
		// Production-equivalent `checkCapability` (broker-context): every declared
		// cap must be a live ledger grant for the calling app.
		broker = new Broker({
			services: new Map(),
			verifyAppIdentity: (app) => app === CHAT_APP || app === "io.brainstorm.notes",
			checkCapability: (app, _s, _m, caps) => caps.every((c) => ledger.has(app, c)),
		});
		const deps: BuiltinAgentRunnerDeps = {
			getSession: () => session,
			getSelfPubkey: () => SELF,
			// Exactly main's wiring: the verified caller must hold `agents.mention`.
			callerMayMention: (app) => ledger.has(app, AGENTS_MENTION_CAPABILITY),
			isAgentInstalled: async () =>
				new AppsRepository(await stores.open("registry")).getActive(BUILTIN_AGENT_APP_ID) !== null,
			getServiceHandler: (name) => {
				if (name === "ai") {
					return async (envelope: Envelope) => {
						aiCalls.push(envelope);
						return { content: aiScript.shift() ?? '{"final": "done"}' };
					};
				}
				return broker.getServiceHandler(name);
			},
			onWrote: () => {},
		};
		// The same create-wrap main registers: the runner piggybacks on the
		// entities service and is handed the broker-verified `envelope.app`.
		broker.registerService("entities", async (envelope) => {
			const result = await entitiesHandler(envelope);
			if (envelope.method === "create") {
				runs.push(maybeRunBuiltinAgent(deps, result, envelope.app));
			}
			return result;
		});
		broker.registerService(
			AGENT_PROPOSALS_SERVICE,
			makeAgentProposalServiceHandler({
				getSession: () => session,
				getSelfPubkey: () => SELF,
				getLedger: async () => ledger,
				getDekStore: async () => dekStore,
				newId: () => `ent_approved_${++idSeq}`,
				resolveMentionTarget: (app) => resolveBuiltinAgentMentionTarget(deps, app),
				syncProposalPreview: async (messageId, preview) => {
					await broker.getServiceHandler("entities")?.({
						v: 1,
						msg: `preview-${messageId}`,
						app: BUILTIN_AGENT_APP_ID,
						service: "entities",
						method: "update",
						args: [{ id: messageId, patch: { [AGENT_PROPOSAL_PREVIEW_PROPERTY_KEY]: preview } }],
						caps: ledger.listActive(BUILTIN_AGENT_APP_ID).map(grantString),
					});
				},
			}),
		);
	});

	afterEach(async () => {
		await Promise.allSettled(runs);
		stores.close();
		for (const dir of [vaultDir, sourceDir]) {
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
		}
	});

	async function install(app: string): Promise<void> {
		const result = await installer.install({ bundleDir: await bundleFor(app, sourceDir) });
		if (!result.ok) throw new Error(`install ${app} failed: ${JSON.stringify(result)}`);
	}

	let msgSeq = 0;
	/** Dispatch as an app, with the envelope its SDK proxy would build. */
	async function call(
		app: string,
		service: string,
		method: string,
		args: unknown[],
		caps: string[],
	): Promise<unknown> {
		msgSeq += 1;
		const reply = await broker.dispatch(
			makeEnvelope({ msg: `m${msgSeq}`, app, service, method, args, caps }),
			"renderer",
		);
		if (!reply.ok) throw new Error(`${service}.${method} as ${app}: ${reply.error.kind}`);
		return reply.value;
	}

	async function createChannel(): Promise<string> {
		const channel = (await call(
			CHAT_APP,
			"entities",
			"create",
			[{ type: CHANNEL_TYPE, properties: { name: "general", createdAt: "2026-11-19T00:00:00Z" } }],
			[],
		)) as { id: string };
		return channel.id;
	}

	/** Chat's composer send: a participant message with the `@agent` chip
	 *  lifted into a Person attachment. */
	async function sendMention(channelId: string, body: string): Promise<void> {
		await call(
			CHAT_APP,
			"entities",
			"create",
			[
				{
					type: MESSAGE_TYPE_URL,
					properties: {
						conversation: channelId,
						sender: { kind: SenderKind.Participant, personRef: SELF, displayName: "Ada" },
						role: MessageRole.User,
						body,
						createdAt: new Date().toISOString(),
						seq: 1,
						attachments: [
							{ kind: AttachmentKind.Person, ref: BUILTIN_AGENT_MENTION_REF, label: "Agent" },
						],
					},
				},
			],
			[],
		);
		await Promise.all(runs);
	}

	const agentRows = (channelId: string) =>
		repo
			.query({ type: MESSAGE_TYPE_URL, where: { $eq: { conversation: channelId } } })
			.filter((r) => r.createdBy === BUILTIN_AGENT_APP_ID)
			.sort((a, b) => Number(a.properties.seq) - Number(b.properties.seq));

	it("the shipped manifests carry the whole flow: invoke → reply → card → approve → entity", async () => {
		await install("chat");
		await install("agent");

		// The composer's question, exactly as the SDK asks it.
		const target = readBuiltinAgentMentionTarget(
			await call(CHAT_APP, AGENT_PROPOSALS_SERVICE, "mentionTarget", [], ["agents.mention"]),
		);
		expect(target.available).toBe(true);

		const channelId = await createChannel();
		aiScript = [
			'{"tool": "propose-task", "args": {"title": "Ship the release notes"}}',
			'{"final": "I drafted a task for you."}',
		];
		await sendMention(channelId, "@Agent make a task for the release notes");

		expect(aiCalls.length).toBeGreaterThan(0);
		expect(aiCalls.every((e) => e.app === BUILTIN_AGENT_APP_ID)).toBe(true);

		const rows = agentRows(channelId);
		expect(rows.map((r) => r.properties.body)).toEqual([
			"I drafted a task for you.",
			"Proposed task: Ship the release notes — approve it to save it.",
		]);
		const card = rows[1];
		expect(card?.properties[CHANNEL_PROPOSAL_PROPERTY_KEY]).toMatchObject({
			status: ChannelProposalStatus.Pending,
			invokedBy: SELF,
		});
		expect(repo.query({ type: TASK_TYPE })).toHaveLength(0);

		const decision = (await call(
			CHAT_APP,
			AGENT_PROPOSALS_SERVICE,
			"approve",
			[{ messageId: card?.id }],
			["agents.approve"],
		)) as { ok: boolean; createdEntityId?: string };
		expect(decision.ok).toBe(true);
		const tasks = repo.query({ type: TASK_TYPE });
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.id).toBe(decision.createdEntityId);
		expect(readAgentProvenance(tasks[0]?.properties)).toMatchObject({
			agent: BUILTIN_AGENT_APP_ID,
			conversationId: channelId,
			approvedBy: SELF,
		});
		expect(repo.get(card?.id ?? "")?.properties[AGENT_PROPOSAL_PREVIEW_PROPERTY_KEY]).toMatchObject({
			status: ChannelProposalStatus.Approved,
		});
	});

	it("without the Agent app installed, @agent is offered DISABLED and a mention runs nothing", async () => {
		await install("chat");
		const target = readBuiltinAgentMentionTarget(
			await call(CHAT_APP, AGENT_PROPOSALS_SERVICE, "mentionTarget", [], ["agents.mention"]),
		);
		expect(target).toMatchObject({ available: false, reason: "not-installed" });

		const channelId = await createChannel();
		await sendMention(channelId, "@Agent hello");
		expect(aiCalls).toHaveLength(0);
		expect(agentRows(channelId)).toHaveLength(0);
	});

	it("SECURITY: the broker refuses mentionTarget / approve to an app whose manifest lacks the grant", async () => {
		await install("chat");
		await install("agent");
		for (const [method, caps] of [
			["mentionTarget", ["agents.mention"]],
			["approve", ["agents.approve"]],
		] as const) {
			const reply = await broker.dispatch(
				makeEnvelope({
					msg: `denied-${method}`,
					app: "io.brainstorm.notes",
					service: AGENT_PROPOSALS_SERVICE,
					method,
					args: [{ messageId: "x" }],
					caps: [...caps],
				}),
				"renderer",
			);
			expect(reply.ok).toBe(false);
		}
		// …and lying about the declared caps does not help: the service re-checks
		// the ledger itself.
		const lied = await broker.dispatch(
			makeEnvelope({
				msg: "lied",
				app: "io.brainstorm.notes",
				service: AGENT_PROPOSALS_SERVICE,
				method: "mentionTarget",
				args: [],
				caps: [],
			}),
			"renderer",
		);
		expect(lied.ok).toBe(false);
	});
});
