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

import { parseCapability } from "./capability-string";
import { isAgentPrincipal } from "./principals";

/** The propose-verb prefix — the only `intents.dispatch` scopes an agent may
 *  hold. A propose verb stages a draft; it can never persist bytes. */
export const AGENT_PROPOSE_SCOPE_PREFIX = "propose-";

/** Agent-Teams-5 — "this agent may delegate a subtask to THAT agent". Scoped to
 *  the target agent's ledger principal (its `ed25519:<hex>` fingerprint), so a
 *  grant names exactly one delegate.
 *
 *  WHY THIS IS SAFE TO ADD to an otherwise read-and-propose-only vocabulary:
 *  delegation confers no NEW authority. A delegated child runs under
 *  `child-grants ∩ delegator-grants`, so the reachable authority of the whole
 *  tree is a SUBSET of what the delegator already held — the grant only decides
 *  *who may be asked*, never *what may be done*. Everything the child can
 *  actually do it could already do when a human summoned it directly.
 *
 *  WHY A WILDCARD IS REFUSED: `agents.delegate:*` would mean "delegate to any
 *  agent, including ones created later". The intersection still bounds the
 *  authority, but the grant would silently widen its own blast radius as the
 *  vault grows, and it is exactly the shape a prompt-injected manager would try
 *  to talk a user into. A delegate is named, one grant at a time. */
export const AGENT_DELEGATE_CAPABILITY = "agents.delegate";

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
	// The scope must be a real agent principal — never `*`, never a display
	// name, never an entity id. `isAgentPrincipal` also rejects an uppercase or
	// otherwise non-canonical fingerprint, so one delegate has ONE spelling.
	if (capability === AGENT_DELEGATE_CAPABILITY) {
		return scope !== null && isAgentPrincipal(scope);
	}
	return scope === null && UNSCOPED_AGENT_CAPABILITIES.has(capability);
}
