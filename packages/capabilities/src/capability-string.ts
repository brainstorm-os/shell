/**
 * The capability-string grammar — `<service>.<verb>[:<scope>]`.
 *
 * A leaf module (no imports) so both the ledger and the agent-grant policy can
 * depend on it without a cycle: the ledger enforces the policy at grant time,
 * and the policy needs the parser.
 */

/**
 * Parse "service.verb:scope" into its parts. Scope is optional.
 * Wildcard requests (`entities.read:*`) round-trip as scope === "*".
 */
export function parseCapability(required: string): { capability: string; scope: string | null } {
	const colon = required.indexOf(":");
	if (colon < 0) return { capability: required, scope: null };
	return {
		capability: required.slice(0, colon),
		scope: required.slice(colon + 1),
	};
}
