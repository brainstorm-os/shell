/**
 * Agent-Teams-3, app half — reading an agent's staged proposal back off a chat
 * message, and reading the host's decision reply.
 *
 * An agent's draft rides on an ordinary `brainstorm/Message/v1` under the
 * `agentProposal` property. This module is the CHAT-SIDE mirror of the main
 * process's `channel-proposals.ts` parser: an app cannot import from
 * `packages/shell/src/main`, so the shape is re-derived here from the same
 * shared `@brainstorm-os/sdk-types` propose descriptors that main writes it
 * with. Only the *kind vocabulary* is shared — the parse itself is local.
 *
 * FAIL-CLOSED is the whole point. A proposal card is an approval affordance
 * over a privileged main-side write, so anything that does not re-derive to a
 * known channel kind with a non-empty summary is NOT a proposal: it renders as
 * an ordinary message (whose plain-text body already reads honestly on its own)
 * rather than as an approvable card. Never loosen a check here to "make a card
 * show up" — main would refuse the approval anyway, and the user would be
 * offered a button that cannot work.
 *
 * Pure — no React, no services — so every branch unit-tests on plain objects.
 */

import { PROPOSE_DESCRIPTORS, ProposeKind } from "@brainstorm-os/sdk-types";

/** The property an agent's proposal rides on its `Message/v1` row. Must match
 *  `CHANNEL_PROPOSAL_PROPERTY_KEY` in the main-process module. */
export const CHANNEL_PROPOSAL_PROPERTY_KEY = "agentProposal";

/** Where a proposal is in its life. Persisted strings — never renumber. */
export enum ChannelProposalStatus {
	Pending = "pending",
	Approved = "approved",
	Discarded = "discarded",
}

/** The kinds a CHANNEL proposal may carry. Mirrors the main-side allowlist:
 *  the five simple kinds whose fields come from a build-time descriptor. A row
 *  / database / code-file draft needs live schema resolution the channel path
 *  never assembles, so it is not approvable here and must not render as a card. */
export const CHANNEL_PROPOSAL_KINDS = [
	ProposeKind.Note,
	ProposeKind.Task,
	ProposeKind.Event,
	ProposeKind.Bookmark,
	ProposeKind.Contact,
] as const;

/** The narrowed kind union a rendered card can carry — so every per-kind label
 *  / glyph table is exhaustive by construction. */
export type ChannelProposalKind = (typeof CHANNEL_PROPOSAL_KINDS)[number];

/** The staged draft as it sits on the message row. */
export type ChannelProposalArtifact = {
	id: string;
	kind: ChannelProposalKind;
	entityType: string;
	fields: Record<string, string>;
	summary: string;
};

export type ChannelProposal = {
	artifact: ChannelProposalArtifact;
	status: ChannelProposalStatus;
	/** Sovereign pubkey of the human who approved / discarded it. */
	decidedBy?: string;
	/** The entity an approval created — the card's "open it" back-link. */
	createdEntityId?: string;
	decidedAt?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseKind(value: unknown): ChannelProposalKind | null {
	return CHANNEL_PROPOSAL_KINDS.find((kind) => kind === value) ?? null;
}

function parseStatus(value: unknown): ChannelProposalStatus | null {
	return value === ChannelProposalStatus.Pending ||
		value === ChannelProposalStatus.Approved ||
		value === ChannelProposalStatus.Discarded
		? value
		: null;
}

/**
 * Read a proposal back off a message's property bag, or `null` when the row is
 * not a well-formed proposal of a kind this channel path can honour.
 */
export function readChannelProposal(properties: Record<string, unknown>): ChannelProposal | null {
	const raw = asRecord(properties[CHANNEL_PROPOSAL_PROPERTY_KEY]);
	if (!raw) return null;
	const status = parseStatus(raw.status);
	if (!status) return null;
	const artifact = asRecord(raw.artifact);
	if (!artifact) return null;

	const kind = parseKind(artifact.kind);
	if (!kind) return null;
	const id = artifact.id;
	const entityType = artifact.entityType;
	const summary = artifact.summary;
	if (typeof id !== "string" || !id) return null;
	if (typeof entityType !== "string" || !entityType) return null;
	if (typeof summary !== "string" || !summary) return null;

	// A non-string field is dropped rather than stringified — the card must never
	// invent a value the approval path would not write.
	const rawFields = asRecord(artifact.fields) ?? {};
	const fields: Record<string, string> = {};
	for (const [key, value] of Object.entries(rawFields)) {
		if (typeof value === "string") fields[key] = value;
	}

	const decidedBy = typeof raw.decidedBy === "string" ? raw.decidedBy : undefined;
	const createdEntityId = typeof raw.createdEntityId === "string" ? raw.createdEntityId : undefined;
	const decidedAt = typeof raw.decidedAt === "number" ? raw.decidedAt : undefined;

	return {
		artifact: { id, kind, entityType, fields, summary },
		status,
		...(decidedBy ? { decidedBy } : {}),
		...(createdEntityId ? { createdEntityId } : {}),
		...(decidedAt !== undefined ? { decidedAt } : {}),
	};
}

/** One label/value line of a card. `key` is the descriptor field name — the
 *  card resolves it to a translated label. */
export type ProposalFieldRow = { key: string; value: string };

/** The artifact's fields as ordered card rows: descriptor order first (so a
 *  Task always reads title → due date → status → notes, whatever order the
 *  model filled them in), any unrecognised key trailing, empties dropped. */
export function proposalFieldRows(artifact: ChannelProposalArtifact): ProposalFieldRow[] {
	const descriptor = PROPOSE_DESCRIPTORS.find((d) => d.kind === artifact.kind);
	const order = descriptor ? descriptor.fields : [];
	const rank = (key: string): number => {
		const index = order.indexOf(key);
		return index < 0 ? Number.MAX_SAFE_INTEGER : index;
	};
	return Object.keys(artifact.fields)
		.filter((key) => (artifact.fields[key] ?? "") !== "")
		.sort((a, b) => rank(a) - rank(b))
		.map((key) => ({ key, value: artifact.fields[key] ?? "" }));
}

// ─────────────────────────── deciding a proposal ───────────────────────────

/** Which way the human decided. Matches the host service's method names. */
export enum ProposalDecision {
	Approve = "approve",
	Discard = "discard",
}

/** Why a decision did not happen. The first four are the host's own
 *  `{ ok: false, reason }` values; `Unavailable` is the app-side normalisation
 *  of a throw or an absent service, so a failure is NEVER silent. */
export enum ProposalDecisionFailure {
	NotFound = "not-found",
	NotAProposal = "not-a-proposal",
	AlreadyDecided = "already-decided",
	UntrustedAgent = "untrusted-agent",
	Unavailable = "unavailable",
}

export type ProposalDecisionResult =
	| { ok: true; status: ChannelProposalStatus; createdEntityId?: string }
	| { ok: false; reason: string };

/** Parse the host's decision reply. Anything unrecognised resolves to a
 *  *failure* with an opaque reason rather than a silent success — an approval
 *  the app cannot confirm must not be reported as one. */
export function readDecisionResult(value: unknown): ProposalDecisionResult {
	const record = asRecord(value);
	if (!record) return { ok: false, reason: ProposalDecisionFailure.Unavailable };
	if (record.ok === true) {
		const status = parseStatus(record.status);
		if (!status) return { ok: false, reason: ProposalDecisionFailure.Unavailable };
		const createdEntityId =
			typeof record.createdEntityId === "string" ? record.createdEntityId : undefined;
		return { ok: true, status, ...(createdEntityId ? { createdEntityId } : {}) };
	}
	const reason =
		typeof record.reason === "string" && record.reason
			? record.reason
			: ProposalDecisionFailure.Unavailable;
	return { ok: false, reason };
}
