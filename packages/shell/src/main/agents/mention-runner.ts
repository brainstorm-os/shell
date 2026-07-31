/**
 * Agent mention runner (Agent-Teams-3) — @-mentioning an agent in a Chat
 * channel invites that agent's loop into the thread (doc 69 §O.3). Runs in
 * MAIN, because that is where the agent is real: its sealed key, its ledger
 * ceiling, and the audit trail all live here — a renderer never impersonates
 * an agent principal.
 *
 * Security posture:
 *   - The loop's effectful calls (ai.generate today; retrieval/tools next)
 *     go through the REAL broker service handlers with `envelope.app` set to
 *     the AGENT'S FINGERPRINT and `envelope.caps` set to its LIVE ledger
 *     grants — the services' own fail-closed re-checks enforce the agent's
 *     ceiling exactly as they would an app's (the ledger-principal design of
 *     Agent-Teams-1). No grant → the service denies; nothing here widens.
 *   - ONE engine: the shared `runAgentLoop`, same as the Agent app and the
 *     Automations AIAgent step (doc 69 non-goal: no second engine).
 *   - Human-in-the-loop actuation (OQ-AT-2): only a message authored by a
 *     human `Participant` triggers a run. Agent replies are `Assistant`
 *     senders, so agent→agent chatter is structurally impossible.
 *   - The reply is written by MAIN directly (repo write, `createdBy` = the
 *     agent fingerprint, `agentProvenance` stamped) — an agent never holds
 *     `entities.write`; recording its utterance is the host's act, exactly
 *     like the Agent app persisting an assistant turn.
 *   - Honesty over silence: no `ai.use` grant → the agent answers that it
 *     is not permitted to run yet; a generate failure → says it could not
 *     reach a model. A mention never disappears into the void, and the
 *     model never gets to pretend it acted (F-311's lesson).
 */

import {
	AGENT_PROVENANCE_PROPERTY_KEY,
	AgentStopReason,
	type AiChatMessage,
	MessageRole,
	SenderKind,
	buildAgentProvenance,
	runAgentLoop,
} from "@brainstorm-os/sdk-types";
import { ulid } from "ulid";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { MESSAGE_TYPE_URL, mentionTargets } from "../roster/mention-notifier";
import { EntitiesRepository } from "../storage/entities-repo";
import { type AgentDirectorySession, type AgentRecord, listAgents } from "./agent-directory";

/** Mirrors `broker.getServiceHandler` — name → handler. */
type ServiceHandlerGetter = (
	name: string,
) => ((envelope: Envelope) => Promise<unknown> | unknown) | undefined;

export type MentionRunnerDeps = {
	getSession: () => AgentDirectorySession | null;
	getServiceHandler: ServiceHandlerGetter;
	/** Fired after the runner writes a reply row directly (bypassing the
	 *  entities service), so the host re-broadcasts staleness / reindexes —
	 *  without it the reply would not paint until the next unrelated write. */
	onWrote: () => void;
	now?: () => number;
	newId?: () => string;
};

/** How much of the channel the model sees — bounded, newest last. */
export const MENTION_TRANSCRIPT_LIMIT = 24;

/** At most this many agents run per message, however many are mentioned. */
export const MENTION_RUN_CAP = 3;

/** Honest fallbacks — chat CONTENT (vault data), not shell chrome, so they are
 *  plain strings rather than `t()` keys (the renderer i18n never sees vault
 *  bodies). */
export const NO_PERMISSION_REPLY =
	"I can't run yet — I have no AI permission in this vault. Open Settings → Team and grant me “Use AI models” (and anything else you want me to see).";
export const GENERATE_FAILED_REPLY =
	"I couldn't reach a model provider just now, so I have no answer. Check Settings → AI (provider + key), then mention me again.";

/** The channel transcript, projected for the model: this agent's own turns as
 *  `assistant`, every other turn as `user` prefixed with the speaker's name so
 *  a multi-party thread stays legible to a two-role wire format. */
export function projectTranscript(
	messages: ReadonlyArray<{
		body: string;
		senderKind: string;
		personRef: string;
		displayName: string;
	}>,
	agentPubkey: string,
): AiChatMessage[] {
	return messages
		.filter((m) => m.body.trim().length > 0)
		.map((m) => {
			if (m.personRef === agentPubkey) {
				return { role: MessageRole.Assistant, content: m.body };
			}
			const name = m.displayName.trim() || "Someone";
			return { role: MessageRole.User, content: `${name}: ${m.body}` };
		});
}

/** The persona-bearing instruction block for a channel run. */
export function buildChannelInstructions(agentName: string, persona: string): string {
	const lines = [
		`You are ${agentName}, an agent member of this shared workspace, replying inside a team chat channel.`,
		"You were @-mentioned. Read the conversation and reply to the mention — concise, concrete, and honest.",
		"If the conversation does not contain what you need, say so plainly. Never invent facts, names, or data.",
	];
	if (persona.trim()) lines.push("", persona.trim());
	return lines.join("\n");
}

type ChannelMessage = {
	id: string;
	body: string;
	senderKind: string;
	personRef: string;
	displayName: string;
	seq: number;
	createdAt: string;
};

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function readChannelMessages(repo: EntitiesRepository, channelId: string): ChannelMessage[] {
	const rows = repo.query({ type: MESSAGE_TYPE_URL });
	const messages: ChannelMessage[] = [];
	for (const row of rows) {
		if (str(row.properties.conversation) !== channelId) continue;
		const sender =
			row.properties.sender && typeof row.properties.sender === "object"
				? (row.properties.sender as Record<string, unknown>)
				: {};
		messages.push({
			id: row.id,
			body: str(row.properties.body),
			senderKind: str(sender.kind),
			personRef: str(sender.personRef),
			displayName: str(sender.displayName),
			seq: typeof row.properties.seq === "number" ? row.properties.seq : 0,
			createdAt: str(row.properties.createdAt),
		});
	}
	return messages.sort(
		(a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
}

/** Reassemble a ledger grant row into the `service.verb[:scope]` wire form. */
function grantString(grant: { capability: string; scope: string | null }): string {
	return grant.scope === null ? grant.capability : `${grant.capability}:${grant.scope}`;
}

async function agentCapabilities(
	session: AgentDirectorySession,
	fingerprint: string,
): Promise<string[]> {
	const ledger = await session.capabilityLedger();
	return ledger.listActive(fingerprint).map(grantString);
}

function writeAgentReply(
	deps: MentionRunnerDeps,
	repo: EntitiesRepository,
	channelId: string,
	agent: AgentRecord,
	body: string,
	nextSeq: number,
	extraProperties: Record<string, unknown> = {},
): void {
	const now = deps.now ? deps.now() : Date.now();
	repo.create({
		id: deps.newId ? deps.newId() : `msg_${ulid()}`,
		type: MESSAGE_TYPE_URL,
		createdBy: agent.def.fingerprint,
		properties: {
			conversation: channelId,
			sender: {
				kind: SenderKind.Assistant,
				personRef: agent.def.pubkey,
				displayName: agent.def.displayName,
			},
			role: MessageRole.Assistant,
			body,
			createdAt: new Date(now).toISOString(),
			seq: nextSeq,
			[AGENT_PROVENANCE_PROPERTY_KEY]: buildAgentProvenance(agent.def.fingerprint, channelId, now),
			...extraProperties,
		},
		now,
		dekId: null,
	});
	deps.onWrote();
}

async function runOneAgent(
	deps: MentionRunnerDeps,
	session: AgentDirectorySession,
	agent: AgentRecord,
	channelId: string,
): Promise<void> {
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	const messages = readChannelMessages(repo, channelId);
	const nextSeq = (messages[messages.length - 1]?.seq ?? 0) + 1;

	const caps = await agentCapabilities(session, agent.def.fingerprint);
	if (!caps.includes("ai.use")) {
		writeAgentReply(deps, repo, channelId, agent, NO_PERMISSION_REPLY, nextSeq);
		return;
	}

	const aiHandler = deps.getServiceHandler("ai");
	if (!aiHandler) {
		writeAgentReply(deps, repo, channelId, agent, GENERATE_FAILED_REPLY, nextSeq);
		return;
	}

	let seq = 0;
	const generate = async (chat: readonly AiChatMessage[]) => {
		seq += 1;
		// The agent IS the principal: its fingerprint as `app`, its live grants
		// as `caps` — the ai service's own fail-closed check runs against the
		// agent's ledger rows (Agent-Teams-1).
		const result = (await aiHandler({
			v: ENVELOPE_PROTOCOL_VERSION,
			msg: `agent-mention-${agent.def.fingerprint}-${seq}`,
			app: agent.def.fingerprint,
			service: "ai",
			method: "generate",
			args: [{ messages: [...chat] }],
			caps,
		})) as { content?: unknown } | null;
		return { content: typeof result?.content === "string" ? result.content : "" };
	};

	const result = await runAgentLoop(
		{ generate, dispatchTool: async () => null },
		{
			instructions: buildChannelInstructions(agent.def.displayName, agent.def.persona),
			// Tools arrive with the propose-cards slice; an empty set keeps the
			// loop honest ("answer from the conversation alone").
			tools: [],
			frozenCapabilities: caps,
			maxIterations: 1,
			transcript: projectTranscript(messages.slice(-MENTION_TRANSCRIPT_LIMIT), agent.def.pubkey),
		},
	);

	const body =
		result.stopReason === AgentStopReason.GenerateFailed
			? GENERATE_FAILED_REPLY
			: result.finalAnswer.trim() || GENERATE_FAILED_REPLY;
	writeAgentReply(deps, repo, channelId, agent, body, nextSeq);
}

/**
 * The create-wrap hook: if `created` is a chat message authored by a human
 * participant that @-mentions vault agents, run each mentioned agent's loop
 * (bounded) and post its reply into the channel. Never throws — a runner
 * failure must not break the message create it piggybacks on.
 */
export async function maybeRunMentionedAgents(
	deps: MentionRunnerDeps,
	created: unknown,
): Promise<void> {
	try {
		const entity = created as { type?: unknown; properties?: unknown } | null;
		if (!entity || entity.type !== MESSAGE_TYPE_URL || !entity.properties) return;
		const properties = entity.properties as Record<string, unknown>;
		const targets = mentionTargets(MESSAGE_TYPE_URL, properties);
		// Human-in-the-loop (OQ-AT-2): only a human participant's turn actuates.
		// An agent/assistant sender has a null author and is skipped here.
		if (!targets || targets.mentioned.length === 0 || targets.author === null) return;
		const channelId = str(properties.conversation);
		if (!channelId) return;

		const session = deps.getSession();
		if (!session) return;
		const agents = await listAgents(session);
		const byPubkey = new Map(agents.map((a) => [a.def.pubkey, a]));
		const mentioned = targets.mentioned
			.map((pubkey) => byPubkey.get(pubkey))
			.filter((a): a is AgentRecord => a !== undefined)
			.slice(0, MENTION_RUN_CAP);

		for (const agent of mentioned) {
			await runOneAgent(deps, session, agent, channelId);
		}
	} catch (error) {
		console.warn("[brainstorm] agent mention run failed:", error);
	}
}
