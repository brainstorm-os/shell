/**
 * Agent-13 — whether the composer may offer `@agent`, and what to say when it
 * may not.
 *
 * The answer is the host's (`agentProposals.mentionTarget`, gated on the scarce
 * `agents.mention` and re-checked against the ledger in main); this module only
 * short-circuits the cases the app can already see for itself, and turns every
 * failure into an UNAVAILABLE target. It never resolves to "available" on its
 * own evidence — an option the host did not confirm is offered disabled.
 */

import {
	AttachmentKind,
	BUILTIN_AGENT_DISPLAY_NAME,
	BUILTIN_AGENT_MENTION_REF,
	type BuiltinAgentMentionTarget,
	BuiltinAgentUnavailableReason,
	readBuiltinAgentMentionTarget,
} from "@brainstorm-os/sdk-types";
import type { ContextCandidate } from "@brainstorm-os/sdk/composer-context";
import type { ChatMessageId } from "../i18n";

/** The capability Chat must hold to invite the agent into a channel. */
export const AGENTS_MENTION_CAPABILITY = "agents.mention";

function unavailable(reason?: BuiltinAgentUnavailableReason): BuiltinAgentMentionTarget {
	return {
		ref: BUILTIN_AGENT_MENTION_REF,
		displayName: BUILTIN_AGENT_DISPLAY_NAME,
		available: false,
		...(reason ? { reason } : {}),
	};
}

/**
 * Ask the host. `capabilities` is this app's granted set when the runtime
 * reports one: if it is reported and lacks `agents.mention`, the host would
 * refuse the question itself, so it is not asked. Never throws.
 */
export async function resolveAgentMentionTarget(
	capabilities: readonly string[] | undefined,
	service: { mentionTarget?(): Promise<unknown> } | null,
): Promise<BuiltinAgentMentionTarget> {
	if (capabilities && !capabilities.includes(AGENTS_MENTION_CAPABILITY)) {
		return unavailable(BuiltinAgentUnavailableReason.NoMentionPermission);
	}
	if (!service?.mentionTarget) return unavailable();
	try {
		return readBuiltinAgentMentionTarget(await service.mentionTarget());
	} catch {
		return unavailable();
	}
}

const UNAVAILABLE_MESSAGE: Record<BuiltinAgentUnavailableReason, ChatMessageId> = {
	[BuiltinAgentUnavailableReason.NotInstalled]: "agent.unavailable.notInstalled",
	[BuiltinAgentUnavailableReason.NoAiPermission]: "agent.unavailable.noAi",
	[BuiltinAgentUnavailableReason.NoMentionPermission]: "agent.unavailable.noMention",
};

/** The hint a disabled `@agent` option carries. */
export function agentUnavailableMessageId(
	reason: BuiltinAgentUnavailableReason | undefined,
): ChatMessageId {
	return reason ? UNAVAILABLE_MESSAGE[reason] : "agent.unavailable.generic";
}

/**
 * The `@agent` row of the mention typeahead, or null when `query` does not
 * match it. An unavailable target still yields a row — DISABLED, with the
 * reason as its caption — because an option that vanishes cannot be discovered.
 * Matches the literal handle as well as the translated label, so "@agent" finds
 * it in every locale.
 */
export function agentMentionCandidate(
	query: string,
	target: BuiltinAgentMentionTarget,
	translate: (id: ChatMessageId) => string,
): ContextCandidate | null {
	const q = query.trim().toLowerCase();
	const label = translate("agent.name");
	if (q && !"agent".includes(q) && !label.toLowerCase().includes(q)) return null;
	return {
		id: BUILTIN_AGENT_MENTION_REF,
		kind: AttachmentKind.Person,
		label,
		description: target.available
			? translate("agent.caption")
			: translate(agentUnavailableMessageId(target.reason)),
		...(target.available ? {} : { disabled: true }),
	};
}

/** Whether `query` could match the `@agent` row — lets the caller skip the
 *  host round-trip while the user is plainly typing someone else's name. */
export function queryMayMatchAgent(
	query: string,
	translate: (id: ChatMessageId) => string,
): boolean {
	return agentMentionCandidate(query, unavailable(), translate) !== null;
}
