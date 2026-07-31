/**
 * Channel proposals (Agent-Teams-3) — an agent's staged draft, carried on a
 * chat `Message/v1` so every member of the channel sees the same card, and
 * approved by a human gesture that turns it into a real entity.
 *
 * The propose→approve invariant is unchanged from Agent-11b, only relocated
 * from one user's tray to a shared room: the model NEVER persists. A
 * `propose-*` tool call is intercepted before any dispatch, staged into a
 * bounded artifact, and written as a message. Bytes reach the vault only when
 * a human presses approve.
 *
 * WHY APPROVAL RUNS IN MAIN rather than in the approving app:
 *   Dual provenance is the whole governance claim — "this agent proposed it,
 *   that human approved it". If the approving app supplied either half it
 *   could lie about both, and the claim would be theatre. Main is the only
 *   party that can attest them: it reads the proposing agent from the
 *   proposal message's HOST-WRITTEN `created_by` (an app cannot set that), and
 *   the approver from the active session's own sovereign identity (an app
 *   never sees another identity's key). So the approve path is a privileged
 *   main-side write, gated on the calling app holding the scarce
 *   `agents.approve` grant — the human's click in a trusted surface is the
 *   gesture, exactly as the Agent app's tray click is.
 *
 * The blast radius of that privileged write is bounded by construction: the
 * entity type comes from the build-time propose descriptor allowlist
 * (`PROPOSE_DESCRIPTORS`), never from the model or the caller, so this path
 * can only ever create one of the curated proposable kinds.
 */

import {
	PROPOSE_DESCRIPTORS,
	PROPOSE_LONG_MAX,
	PROPOSE_SHORT_MAX,
	type ProposeDescriptor,
	ProposeKind,
	type ProposedArtifact,
	proposalToEntityProperties,
	proposeDescriptorForVerb,
} from "@brainstorm-os/sdk-types";

/** The property a proposal rides on its `Message/v1` row. */
export const CHANNEL_PROPOSAL_PROPERTY_KEY = "agentProposal";

/** Where a proposal is in its life. Persisted strings — never renumber. */
export enum ChannelProposalStatus {
	Pending = "pending",
	Approved = "approved",
	Discarded = "discarded",
}

/** The proposal as it sits on a message row. `artifact` is the staged draft;
 *  `status` moves once, from Pending, and records who moved it. */
export type ChannelProposal = {
	artifact: ProposedArtifact;
	status: ChannelProposalStatus;
	/** Sovereign pubkey of the human who approved / discarded it. */
	decidedBy?: string;
	/** The entity an approval created — the card's "open it" back-link. */
	createdEntityId?: string;
	decidedAt?: number;
};

/** The kinds a CHANNEL proposal may carry.
 *
 *  Deliberately the five simple kinds only: their fields come from a
 *  build-time descriptor and map to a property bag with no vault context.
 *  Row / Database / CodeFile need live schema resolution (which database, which
 *  columns, which language) that the channel path does not assemble — offering
 *  them here would stage drafts whose approval could not be honoured. They ride
 *  a later rung; until then the tool is never offered, so the model cannot try. */
export const CHANNEL_PROPOSAL_KINDS: readonly ProposeKind[] = [
	ProposeKind.Note,
	ProposeKind.Task,
	ProposeKind.Event,
	ProposeKind.Bookmark,
	ProposeKind.Contact,
];

/** The build-time descriptor for a channel kind — the authority on what an
 *  approval writes. */
export function descriptorForKind(kind: ProposeKind): ProposeDescriptor | null {
	return PROPOSE_DESCRIPTORS.find((d) => d.kind === kind) ?? null;
}

/** True when `verb` is a propose verb this channel path can actually honour. */
export function isChannelProposeVerb(verb: string): boolean {
	const descriptor = proposeDescriptorForVerb(verb);
	return descriptor !== null && CHANNEL_PROPOSAL_KINDS.includes(descriptor.kind);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseStatus(value: unknown): ChannelProposalStatus | null {
	return value === ChannelProposalStatus.Pending ||
		value === ChannelProposalStatus.Approved ||
		value === ChannelProposalStatus.Discarded
		? value
		: null;
}

/**
 * Read a proposal back off a message's property bag. Fail-closed: anything
 * whose artifact does not re-derive to a known channel kind, or whose fields
 * are not a flat string bag, is not a proposal — a malformed row renders as an
 * ordinary message rather than as an approvable card.
 */
export function readChannelProposal(properties: Record<string, unknown>): ChannelProposal | null {
	const raw = asRecord(properties[CHANNEL_PROPOSAL_PROPERTY_KEY]);
	if (!raw) return null;
	const status = parseStatus(raw.status);
	if (!status) return null;
	const artifact = asRecord(raw.artifact);
	if (!artifact) return null;

	const kind = artifact.kind;
	if (!CHANNEL_PROPOSAL_KINDS.includes(kind as ProposeKind)) return null;
	const id = artifact.id;
	const summary = artifact.summary;
	if (typeof id !== "string" || !id) return null;
	if (typeof summary !== "string" || !summary) return null;

	// The entity type and the field allowlist are RE-DERIVED from the build-time
	// descriptor for this kind — never read from the row. A stored card is just
	// data, so trusting its `entityType` would let whoever can write that row
	// choose what an approval creates; trusting its `fields` would let them
	// bypass the staging clamps. Both were exactly that before review.
	const descriptor = descriptorForKind(kind as ProposeKind);
	if (!descriptor) return null;
	const entityType = descriptor.entityType;

	const rawFields = asRecord(artifact.fields) ?? {};
	const fields: Record<string, string> = {};
	for (const key of descriptor.fields) {
		const value = rawFields[key];
		if (typeof value !== "string" || value === "") continue;
		const max = descriptor.longFields.includes(key) ? PROPOSE_LONG_MAX : PROPOSE_SHORT_MAX;
		fields[key] = value.length > max ? value.slice(0, max) : value;
	}
	// The primary field is what the card summarises and the entity titles on —
	// a card without it is not approvable.
	if (!fields[descriptor.primaryField]) return null;

	const decidedBy = typeof raw.decidedBy === "string" ? raw.decidedBy : undefined;
	const createdEntityId = typeof raw.createdEntityId === "string" ? raw.createdEntityId : undefined;
	const decidedAt = typeof raw.decidedAt === "number" ? raw.decidedAt : undefined;

	return {
		artifact: { id, kind: kind as ProposeKind, entityType, fields, summary },
		status,
		...(decidedBy ? { decidedBy } : {}),
		...(createdEntityId ? { createdEntityId } : {}),
		...(decidedAt !== undefined ? { decidedAt } : {}),
	};
}

/** The property bag for a freshly-staged proposal message. */
export function buildProposalProperty(artifact: ProposedArtifact): Record<string, unknown> {
	return {
		artifact: {
			id: artifact.id,
			kind: artifact.kind,
			entityType: artifact.entityType,
			fields: { ...artifact.fields },
			summary: artifact.summary,
		},
		status: ChannelProposalStatus.Pending,
	};
}

/** The property bag after a human decides. A decision is terminal: the caller
 *  must refuse a second one (see `decideChannelProposal`'s Pending check). */
export function settledProposalProperty(
	proposal: ChannelProposal,
	decision: ChannelProposalStatus.Approved | ChannelProposalStatus.Discarded,
	decidedBy: string,
	decidedAt: number,
	createdEntityId?: string,
): Record<string, unknown> {
	return {
		artifact: {
			id: proposal.artifact.id,
			kind: proposal.artifact.kind,
			entityType: proposal.artifact.entityType,
			fields: { ...proposal.artifact.fields },
			summary: proposal.artifact.summary,
		},
		status: decision,
		decidedBy,
		decidedAt,
		...(createdEntityId ? { createdEntityId } : {}),
	};
}

/** The property bag an APPROVED proposal becomes, via the shared mapper the
 *  Agent app's tray already uses — one implementation, so a channel-approved
 *  Task is byte-identical to a tray-approved one. */
export function proposalEntityProperties(
	artifact: ProposedArtifact,
	now: number,
): { entityType: string; properties: Record<string, unknown> } | null {
	// Belt and braces with the re-derivation in `readChannelProposal`: the type
	// handed to the privileged write is the DESCRIPTOR's, whatever the artifact
	// carries, and a kind with no descriptor produces nothing at all.
	const descriptor = descriptorForKind(artifact.kind);
	if (!descriptor) return null;
	const plan = proposalToEntityProperties({ ...artifact, entityType: descriptor.entityType }, now);
	return { entityType: descriptor.entityType, properties: plan.properties };
}
