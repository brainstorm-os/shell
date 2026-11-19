/**
 * Agent-13 — `@agent` in a Chat channel: the shared vocabulary between the
 * main process (which runs the loop and writes the rows) and the Chat app
 * (which offers the mention and renders the reply + cards).
 *
 * The built-in agent is the installed Agent APP, not an `Agent/v1` team member:
 * its ledger principal is the app id, its ceiling is the app's own grants, and
 * it runs on the INVOKER's device with the invoker's model provider.
 */

/** The Agent app's bundle id — the ledger principal an `@agent` run uses. */
export const BUILTIN_AGENT_APP_ID = "io.brainstorm.agent";

/** The mention target a composer writes for `@agent` (a `Person` attachment's
 *  `ref`). Carries a `:` so it can never collide with a base64 sovereign pubkey
 *  — a member cannot own a key that reads as the built-in agent. */
export const BUILTIN_AGENT_MENTION_REF = `app:${BUILTIN_AGENT_APP_ID}`;

/** The name agent replies are denormalised under. Vault content, not chrome —
 *  a surface that wants a translated label keys on the mention ref instead. */
export const BUILTIN_AGENT_DISPLAY_NAME = "Agent";

/** Why `@agent` cannot be invoked right now. Wire values — never renumber. */
export enum BuiltinAgentUnavailableReason {
	/** The Agent app is not installed in this vault. */
	NotInstalled = "not-installed",
	/** The Agent app is installed but holds no `ai.use` grant. */
	NoAiPermission = "no-ai-permission",
	/** The asking app holds no `agents.mention` grant. */
	NoMentionPermission = "no-mention-permission",
}

/** The reply to `agentProposals.mentionTarget()`. `ref` is what a composer
 *  commits as the mention; an unavailable target is still described so the
 *  option renders disabled with a reason rather than disappearing. */
export type BuiltinAgentMentionTarget = {
	ref: string;
	displayName: string;
	available: boolean;
	reason?: BuiltinAgentUnavailableReason;
};

/**
 * DISPLAY-ONLY mirror of a staged proposal, written beside the reserved
 * `agentProposal` property.
 *
 * The reserved property never leaves the device that staged it (the entities
 * service strips reserved keys from every app write and from every synced
 * projection), which is exactly what makes it an approval authority — and also
 * why another member of a shared channel would otherwise see nothing. This key
 * is an ordinary synced property, so it carries NO authority: main never reads
 * it when deciding, and a surface must only ever render it as a read-only card.
 */
export const AGENT_PROPOSAL_PREVIEW_PROPERTY_KEY = "agentProposalPreview";

/** Who invoked the agent for this row — `{ pubkey, displayName }`. Display-only
 *  and synced, like the preview: the approval gate reads the invoker from the
 *  reserved proposal property, never from here. */
export const AGENT_INVOKER_PROPERTY_KEY = "agentInvoker";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Parse a `mentionTarget()` reply. Fail-closed: anything unrecognised reads as
 *  an unavailable target with no reason, so a malformed reply can only ever
 *  disable the option. */
export function readBuiltinAgentMentionTarget(value: unknown): BuiltinAgentMentionTarget {
	const record = asRecord(value);
	const reason = Object.values(BuiltinAgentUnavailableReason).find((r) => r === record?.reason);
	const displayName =
		typeof record?.displayName === "string" && record.displayName
			? record.displayName
			: BUILTIN_AGENT_DISPLAY_NAME;
	return {
		ref: BUILTIN_AGENT_MENTION_REF,
		displayName,
		available: record?.available === true && record.ref === BUILTIN_AGENT_MENTION_REF,
		...(reason ? { reason } : {}),
	};
}

/** Read the display-only invoker stamp off a message row. */
export function readAgentInvoker(
	properties: Record<string, unknown>,
): { pubkey: string; displayName: string } | null {
	const raw = asRecord(properties[AGENT_INVOKER_PROPERTY_KEY]);
	if (!raw || typeof raw.pubkey !== "string" || !raw.pubkey) return null;
	return {
		pubkey: raw.pubkey,
		displayName: typeof raw.displayName === "string" ? raw.displayName : "",
	};
}
