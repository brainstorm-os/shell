/**
 * The `agent-proposals` broker service (Agent-Teams-3) — the app-facing half of
 * the channel propose→approve flow: a member presses approve or discard on an
 * agent's card, and this decides it.
 *
 * SECURITY — why the write lives here and not in the calling app:
 *   The governance claim is DUAL PROVENANCE: *this agent* proposed it, *that
 *   human* approved it. Neither half may come from the caller, or an app could
 *   attribute its own writes to an agent, or attribute an approval to a
 *   colleague. Both are read from sources an app cannot influence — the
 *   proposing agent from the proposal message's host-written `created_by`, the
 *   approver from the active session's own sovereign identity.
 *
 *   The privileged write is bounded three ways: the entity type comes from the
 *   build-time propose descriptor (never the model, never the caller), the
 *   proposal must still be Pending (a decision is terminal, so approve is not
 *   a write oracle to call in a loop), and the proposing row must belong to a
 *   TRUSTED agent record — an unbound or app-authored `Agent/v1` never gets an
 *   approval turned into bytes.
 *
 *   `agents.approve` is scarce and re-checked here against the ledger, like the
 *   roster service's own caps: the broker's declared-caps check is necessary
 *   but not sufficient, since the app controls `envelope.caps`.
 */

import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import { AGENT_PROVENANCE_PROPERTY_KEY, buildAgentProvenance } from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { isShellOwnedEntityType } from "../entities/shell-owned-types";
import { MESSAGE_TYPE_URL } from "../roster/mention-notifier";
import { EntitiesRepository } from "../storage/entities-repo";
import { findAgentByFingerprint } from "./agent-directory";
import type { AgentDirectorySession } from "./agent-directory";
import {
	CHANNEL_PROPOSAL_PROPERTY_KEY,
	ChannelProposalStatus,
	proposalEntityProperties,
	readChannelProposal,
	settledProposalProperty,
} from "./channel-proposals";

/** The broker service name. Lowercase-with-dashes because `SERVICE_PATTERN`
 *  says so and `validateEnvelope` runs BEFORE the handler lookup — a camelCase
 *  name fails at the wire on every call, with a handler that looks perfectly
 *  correct and is simply never reached. Exported so the registration and the
 *  tests name it once. */
export const AGENT_PROPOSALS_SERVICE = "agent-proposals";

/** Scarce capability: deciding an agent's proposal on behalf of the human. */
export const AGENTS_APPROVE_CAPABILITY = "agents.approve";

export type AgentProposalServiceOptions = {
	readonly getSession: () => AgentDirectorySession | null;
	/** The local human's sovereign pubkey — the approver, sourced here rather
	 *  than from the caller. */
	readonly getSelfPubkey: () => string | null;
	/** SECURITY — re-checked server-side. Absent → gate skipped (unit tests). */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
	readonly newId: () => string;
	readonly now?: () => number;
	/** Fired after a decision writes rows directly through the repo, so the
	 *  host re-broadcasts staleness / reindexes. */
	readonly onWrote?: () => void;
};

export type DecideProposalResult =
	| { ok: true; status: ChannelProposalStatus; createdEntityId?: string }
	| { ok: false; reason: "not-found" | "not-a-proposal" | "already-decided" | "untrusted-agent" };

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

async function requireCapability(
	envelope: Envelope,
	options: AgentProposalServiceOptions,
): Promise<void> {
	if (!options.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "agent-proposals: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "agent-proposals: no active vault session");
	let held: boolean;
	try {
		held = ledger.has(envelope.app, AGENTS_APPROVE_CAPABILITY);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "agent-proposals: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw makeError(
			"Denied",
			`agent-proposals.${envelope.method}: ${envelope.app} lacks ${AGENTS_APPROVE_CAPABILITY}`,
		);
	}
}

/**
 * Decide a staged proposal. Approving creates the entity with dual provenance;
 * discarding only settles the card. Either way the proposal message is updated
 * so every member of the channel sees the outcome.
 */
export async function decideChannelProposal(
	options: AgentProposalServiceOptions,
	messageId: string,
	decision: ChannelProposalStatus.Approved | ChannelProposalStatus.Discarded,
): Promise<DecideProposalResult> {
	const session = options.getSession();
	if (!session) throw makeError("Unavailable", "agent-proposals: no active vault session");
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));

	const row = repo.get(messageId);
	if (!row || row.type !== MESSAGE_TYPE_URL) return { ok: false, reason: "not-found" };
	const proposal = readChannelProposal(row.properties);
	if (!proposal) return { ok: false, reason: "not-a-proposal" };
	// A decision is terminal — otherwise approve is a write oracle any holder of
	// the capability could call repeatedly on one card.
	if (proposal.status !== ChannelProposalStatus.Pending) {
		return { ok: false, reason: "already-decided" };
	}

	// The proposing agent is the message's HOST-WRITTEN author, and it must
	// still resolve to a trusted `Agent/v1` — so provenance names a real member,
	// and a revoked/deleted agent's stale card cannot be cashed in.
	const proposingAgent = await findAgentByFingerprint(session, row.createdBy);
	if (!proposingAgent) return { ok: false, reason: "untrusted-agent" };

	const now = options.now ? options.now() : Date.now();
	// Fail closed: with no session identity there is no approver to attest, so
	// there is no approval — never a write with the attribution silently missing.
	const approver = options.getSelfPubkey() ?? "";
	if (!approver) throw makeError("Unavailable", "agent-proposals: no session identity");
	const channelId =
		typeof row.properties.conversation === "string" ? row.properties.conversation : "";

	const plan =
		decision === ChannelProposalStatus.Approved
			? proposalEntityProperties(proposal.artifact, now)
			: null;
	if (decision === ChannelProposalStatus.Approved) {
		if (!plan) return { ok: false, reason: "not-a-proposal" };
		// Defence in depth, per shell-owned-types' own instruction: EVERY path
		// that writes on behalf of an app checks the fence before it writes.
		if (isShellOwnedEntityType(plan.entityType)) {
			return { ok: false, reason: "not-a-proposal" };
		}
	}

	// One transaction: re-read, re-check Pending, write, settle. Without this the
	// Pending check and the create straddle an await, and the broker does not
	// serialize an app's calls — two concurrent approves on one card each saw
	// Pending and each minted an entity.
	let createdEntityId: string | undefined;
	const decided = repo.transaction(() => {
		const fresh = repo.get(messageId);
		if (!fresh) return false;
		const current = readChannelProposal(fresh.properties);
		if (!current || current.status !== ChannelProposalStatus.Pending) return false;

		if (plan) {
			const entityId = options.newId();
			repo.create({
				id: entityId,
				type: plan.entityType,
				createdBy: proposingAgent.def.fingerprint,
				properties: {
					...plan.properties,
					[AGENT_PROVENANCE_PROPERTY_KEY]: buildAgentProvenance(
						proposingAgent.def.fingerprint,
						channelId,
						now,
						{ proposedBy: proposingAgent.def.fingerprint, approvedBy: approver },
					),
				},
				now,
				dekId: null,
			});
			createdEntityId = entityId;
		}

		repo.update(
			messageId,
			{
				[CHANNEL_PROPOSAL_PROPERTY_KEY]: settledProposalProperty(
					current,
					decision,
					approver,
					now,
					createdEntityId,
				),
			},
			now,
		);
		return true;
	});
	if (!decided) return { ok: false, reason: "already-decided" };
	options.onWrote?.();
	return { ok: true, status: decision, ...(createdEntityId ? { createdEntityId } : {}) };
}

export function makeAgentProposalServiceHandler(
	options: AgentProposalServiceOptions,
): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		await requireCapability(envelope, options);
		const arg = (envelope.args[0] ?? {}) as { messageId?: unknown };
		const messageId = typeof arg.messageId === "string" ? arg.messageId : "";
		if (!messageId) throw makeError("Invalid", "agent-proposals: messageId required");
		switch (envelope.method) {
			case "approve":
				return await decideChannelProposal(options, messageId, ChannelProposalStatus.Approved);
			case "discard":
				return await decideChannelProposal(options, messageId, ChannelProposalStatus.Discarded);
			default:
				throw makeError("Invalid", `unknown agent-proposals method: ${envelope.method}`);
		}
	};
}
