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
import {
	AGENT_PROVENANCE_PROPERTY_KEY,
	BUILTIN_AGENT_APP_ID,
	type BuiltinAgentMentionTarget,
	buildAgentProvenance,
} from "@brainstorm-os/sdk-types";
import { isLockedProperties } from "@brainstorm-os/sdk/entity-lock";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { DekWrapFailurePolicy, createEntityWithDek } from "../entities/create-with-dek";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { isShellOwnedEntityType } from "../entities/shell-owned-types";
import { MESSAGE_TYPE_URL } from "../roster/mention-notifier";
import { EntitiesRepository } from "../storage/entities-repo";
import { findAgentByFingerprint } from "./agent-directory";
import type { AgentDirectorySession } from "./agent-directory";
import {
	CHANNEL_PROPOSAL_PROPERTY_KEY,
	type ChannelProposal,
	ChannelProposalStatus,
	buildProposalPreview,
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

/** Agent-13 — asking whether `@agent` can be invoked rides the same scarce
 *  grant that invoking it does (`agents.mention`), so the question is no wider
 *  a surface than the action. Kept as a literal here rather than imported from
 *  the mention runner, which already imports this module's siblings. */
export const AGENTS_MENTION_TARGET_CAPABILITY = "agents.mention";

export type AgentProposalServiceOptions = {
	readonly getSession: () => AgentDirectorySession | null;
	/** The local human's sovereign pubkey — the approver, sourced here rather
	 *  than from the caller. */
	readonly getSelfPubkey: () => string | null;
	/** SECURITY — re-checked server-side. Absent → gate skipped (unit tests). */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
	/** The active vault's per-entity DEK store. An approval mints a real DEK for
	 *  the object it creates, exactly like `entities.create` — without one there
	 *  is no approval (fail-closed), never a second-class un-shareable row. */
	readonly getDekStore?: () => Promise<EntityDekStore | null>;
	/** Stage 10.3a — install this device's member wrap on the approved entity's
	 *  Y.Doc. Absent in legacy/test contexts. */
	readonly installEntityWrap?: (entityId: string, dek: Uint8Array, type?: string) => Promise<void>;
	readonly newId: () => string;
	readonly now?: () => number;
	/** Fired after a decision writes rows directly through the repo, so the
	 *  host re-broadcasts staleness / reindexes. */
	readonly onWrote?: () => void;
	/** Agent-12a — the approve/discard gesture chokepoint. Fired post-commit
	 *  with identifiers only: the PROPOSING agent's fingerprint (host-written,
	 *  never the caller's claim), the channel, the decision, and the created
	 *  entity id when approved. Contained — a trace failure never fails the
	 *  decision. */
	readonly onDecided?: (info: {
		agentFingerprint: string;
		channelId: string;
		decision: ChannelProposalStatus.Approved | ChannelProposalStatus.Discarded;
		createdEntityId?: string;
	}) => void;
	/** Agent-13 — whether the built-in `@agent` can be invoked by `app`. Absent
	 *  → the method is refused (`Unavailable`), never answered optimistically. */
	readonly resolveMentionTarget?: (app: string) => Promise<BuiltinAgentMentionTarget>;
	/** Agent-13 — mirror a built-in card's outcome onto its synced, display-only
	 *  preview so the other members of a shared channel see how it ended.
	 *  Best-effort and contained: the decision is already committed. */
	readonly syncProposalPreview?: (
		messageId: string,
		preview: Record<string, unknown>,
	) => Promise<void>;
};

export type DecideProposalResult =
	| { ok: true; status: ChannelProposalStatus; createdEntityId?: string }
	| {
			ok: false;
			reason:
				| "not-found"
				| "not-a-proposal"
				| "already-decided"
				| "untrusted-agent"
				// Agent-13 — the card belongs to someone else's `@agent` invocation.
				| "not-invoker"
				// Agent-13 — the Agent app may not create an object of this type.
				| "not-permitted"
				// The card's message, or its channel, is read-only.
				| "locked";
	  };

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

async function requireCapability(
	envelope: Envelope,
	options: AgentProposalServiceOptions,
	capability: string,
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
		held = ledger.has(envelope.app, capability);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "agent-proposals: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw makeError(
			"Denied",
			`agent-proposals.${envelope.method}: ${envelope.app} lacks ${capability}`,
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

	const now = options.now ? options.now() : Date.now();
	// Fail closed: with no session identity there is no approver to attest, so
	// there is no approval — never a write with the attribution silently missing.
	const approver = options.getSelfPubkey() ?? "";
	if (!approver) throw makeError("Unavailable", "agent-proposals: no session identity");
	const channelId =
		typeof row.properties.conversation === "string" ? row.properties.conversation : "";

	// The proposer is the message's HOST-WRITTEN author. Two kinds exist:
	//   · a team agent (`Agent/v1`) — it must still resolve to a trusted record,
	//     so a revoked/deleted agent's stale card cannot be cashed in;
	//   · Agent-13's built-in agent — the row was created by the Agent app, and
	//     the reserved proposal property names the human whose `@agent`
	//     invocation staged it. Both halves are host-written: an app can author
	//     a row as itself but cannot write the reserved property, and a row that
	//     arrives over sync carries neither.
	const builtin = row.createdBy === BUILTIN_AGENT_APP_ID;
	let proposer: string;
	if (builtin) {
		// INVOKER-ONLY, for approve and discard alike. A card with no invoker is
		// not a built-in card at all — refused rather than treated as anyone's.
		if (!proposal.invokedBy || proposal.invokedBy !== approver) {
			return { ok: false, reason: "not-invoker" };
		}
		proposer = BUILTIN_AGENT_APP_ID;
	} else {
		const proposingAgent = await findAgentByFingerprint(session, row.createdBy);
		if (!proposingAgent) return { ok: false, reason: "untrusted-agent" };
		proposer = proposingAgent.def.fingerprint;
	}

	// A locked object is read-only on EVERY write path, this one included: the
	// card's own message and the channel it sits in are both re-read here.
	const channelRow = channelId ? repo.get(channelId) : null;
	if (isLockedProperties(row.properties) || isLockedProperties(channelRow?.properties)) {
		return { ok: false, reason: "locked" };
	}

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
		// Agent-13 — the built-in agent creates under the Agent APP's ceiling, so
		// the app must hold the write for this type NOW (the grant may have been
		// revoked since the draft was staged). Fail closed without a ledger.
		if (builtin) {
			const ledger = (await options.getLedger?.()) ?? null;
			if (!ledger || !ledger.has(BUILTIN_AGENT_APP_ID, `entities.write:${plan.entityType}`)) {
				return { ok: false, reason: "not-permitted" };
			}
		}
	}

	// One transaction: re-read, re-check Pending, write, settle. Without this the
	// Pending check and the create straddle an await, and the broker does not
	// serialize an app's calls — two concurrent approves on one card each saw
	// Pending and each minted an entity.
	//
	// The settle is what makes the decision terminal, so it MUST be atomic with
	// the create — hence the guard + alsoWrite hooks rather than a bare create
	// followed by an update.
	const settle = (current: ChannelProposal, createdEntityId?: string): void => {
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
	};
	/** Re-read + re-check Pending. Returns the fresh proposal, or null when
	 *  another call already decided this card. */
	const stillPending = (): ChannelProposal | null => {
		const fresh = repo.get(messageId);
		if (!fresh) return null;
		const current = readChannelProposal(fresh.properties);
		return current && current.status === ChannelProposalStatus.Pending ? current : null;
	};

	let createdEntityId: string | undefined;
	let decided: boolean;
	if (plan) {
		const entityId = options.newId();
		// Agent-Teams-3 closure (a) — a channel-approved object is a FIRST-CLASS
		// entity: it is born with its own sealed DEK and this device's member
		// wrap, through the same seam `entities.create` uses. It used to be
		// written with `dekId: null`, so it could not be wrapped for sharing until
		// the next vault open's retro-wrap pass.
		let pending: ChannelProposal | null = null;
		const dekStore = await options.getDekStore?.();
		if (!dekStore) throw makeError("Unavailable", "agent-proposals: no entity DEK store");
		const created = await createEntityWithDek(
			{
				repo,
				dekStore,
				...(options.installEntityWrap ? { installEntityWrap: options.installEntityWrap } : {}),
			},
			{
				id: entityId,
				type: plan.entityType,
				createdBy: proposer,
				properties: {
					...plan.properties,
					[AGENT_PROVENANCE_PROPERTY_KEY]: buildAgentProvenance(proposer, channelId, now, {
						proposedBy: proposer,
						approvedBy: approver,
					}),
				},
				now,
			},
			// The user has already been told the object exists — deleting it
			// because a Y.Doc wrap round-trip failed would be a worse lie than a
			// missing wrap, and the row still carries a real DEK (so the sync wire
			// path never sees an ambiguous null-DEK row). Same posture the
			// retro-wrap pass takes for the identical case.
			DekWrapFailurePolicy.KeepRow,
			{
				guard: () => {
					pending = stillPending();
					return pending !== null;
				},
				alsoWrite: () => {
					createdEntityId = entityId;
					if (pending) settle(pending, entityId);
				},
				onWrapFailed: (error) => {
					console.warn(
						`[agent-proposals] approved ${entityId} but its member wrap failed: ${error.message}`,
					);
				},
			},
		);
		decided = created.ok;
	} else {
		decided = repo.transaction(() => {
			const current = stillPending();
			if (!current) return false;
			settle(current);
			return true;
		});
	}
	if (!decided) return { ok: false, reason: "already-decided" };
	options.onWrote?.();
	try {
		options.onDecided?.({
			agentFingerprint: proposer,
			channelId,
			decision,
			...(createdEntityId ? { createdEntityId } : {}),
		});
	} catch {
		// Contained: the trace hook never fails a decided proposal.
	}
	if (builtin && options.syncProposalPreview) {
		try {
			await options.syncProposalPreview(messageId, buildProposalPreview(proposal.artifact, decision));
		} catch {
			// Contained: other members keep seeing "pending"; nothing is unsafe.
		}
	}
	return { ok: true, status: decision, ...(createdEntityId ? { createdEntityId } : {}) };
}

export function makeAgentProposalServiceHandler(
	options: AgentProposalServiceOptions,
): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		if (envelope.method === "mentionTarget") {
			await requireCapability(envelope, options, AGENTS_MENTION_TARGET_CAPABILITY);
			if (!options.resolveMentionTarget) {
				throw makeError("Unavailable", "agent-proposals: mention target unavailable");
			}
			return await options.resolveMentionTarget(envelope.app);
		}
		await requireCapability(envelope, options, AGENTS_APPROVE_CAPABILITY);
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
