/**
 * Ledger principals — the value space of the `capabilities.app_id` column.
 *
 * Per doc 69 §Identity, the ledger's principal generalizes from *app* to
 * *member*: an agent is just a different principal value in the same column —
 * no schema change. The two kinds are naturally disjoint on the wire:
 *
 *   - App principals are reverse-DNS bundle ids (`io.brainstorm.notes`) or the
 *     synthetic `"shell"` — never containing a `:`.
 *   - Agent principals are the agent's own Ed25519 key fingerprint
 *     (`ed25519:<hex>`) — always prefixed `ed25519:`.
 *
 * The broker's fail-closed check (`ledger.has(principal, cap)`) is kind-blind;
 * this module exists so surfaces that must *distinguish* (the grants panel
 * renders apps by manifest, agents by their `Agent/v1` record; `revokeAllFor`
 * on uninstall must never sweep an agent) do it through one predicate instead
 * of per-call-site string sniffing.
 */

/** What kind of member a ledger principal names. */
export enum PrincipalKind {
	App = "app",
	Agent = "agent",
}

/** The prefix every agent principal (an Ed25519 fingerprint) carries. */
export const AGENT_PRINCIPAL_PREFIX = "ed25519:";

/** Lowercase-hex tail required after the prefix — a fingerprint, not free text. */
const AGENT_PRINCIPAL_RE = /^ed25519:[0-9a-f]{8,64}$/;

/** True when `principal` is an agent fingerprint (`ed25519:<hex>`). */
export function isAgentPrincipal(principal: string): boolean {
	return AGENT_PRINCIPAL_RE.test(principal);
}

/** Classify a ledger principal. Anything that is not a well-formed agent
 *  fingerprint is an app id — the pre-existing value space. */
export function principalKindOf(principal: string): PrincipalKind {
	return isAgentPrincipal(principal) ? PrincipalKind.Agent : PrincipalKind.App;
}
