/**
 * What a human may grant TO AN AGENT (Agent-Teams-1) — the fail-closed
 * vocabulary behind the Team surface's per-agent capability sheet.
 *
 * Doc 69 scopes v1 agent grants to "which collections it can read and whether
 * it may propose". Writes are deliberately NOT grantable to an agent: every
 * persisted entity flows through the propose→approve pipeline, where the
 * approving human's gesture exercises the app-held `entities.write:<type>`
 * (the Agent-11b injection mitigation). Granting an agent a write cap would
 * reopen exactly the hole that pipeline closed, so the vocabulary refuses it
 * structurally — as does anything that reaches outside the vault (network,
 * MCP) or manages other principals (sharing, roster.write).
 */

import { parseCapability } from "./ledger";

/** The propose-verb prefix — the only `intents.dispatch` scopes an agent may
 *  hold. A propose verb stages a draft; it can never persist bytes. */
export const AGENT_PROPOSE_SCOPE_PREFIX = "propose-";

const UNSCOPED_AGENT_CAPABILITIES: ReadonlySet<string> = new Set([
	// Model access — whether the agent may run at all.
	"ai.use",
	// Grounding — retrieval over the vault index.
	"search.read",
	"search.hybrid",
	// Membership visibility — the roster it is itself part of.
	"roster.read",
]);

/**
 * True when `required` (a `service.verb[:scope]` capability string) is inside
 * the agent-grantable vocabulary. Fail-closed: anything unrecognized is NOT
 * grantable.
 */
export function isAgentGrantableCapability(required: string): boolean {
	const { capability, scope } = parseCapability(required);
	if (capability === "entities.read") return scope !== null && scope.length > 0;
	if (capability === "intents.dispatch") {
		return scope?.startsWith(AGENT_PROPOSE_SCOPE_PREFIX) === true;
	}
	return scope === null && UNSCOPED_AGENT_CAPABILITIES.has(capability);
}
