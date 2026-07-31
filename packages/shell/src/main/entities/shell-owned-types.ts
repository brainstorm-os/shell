/**
 * Entity types only the SHELL may author.
 *
 * These carry SECURITY state rather than user content, so a forged or patched
 * row is an authority bug, not a data bug: a `brainstorm/Agent/v1` record binds
 * a ledger principal to a pubkey and to a system-prompt persona, so whoever can
 * write one can run under that principal's ceiling with their own instructions.
 *
 * A shared leaf module because the fence has to hold at EVERY write path, not
 * just the entities service — the pentest walked in through `import.run`, which
 * had its own capability check and never consulted the service's private set.
 * Any new path that creates or mutates entities on behalf of an app must call
 * `isShellOwnedEntityType` before it writes.
 */

import { AGENT_TYPE } from "@brainstorm-os/sdk-types";

const SHELL_OWNED_ENTITY_TYPES: ReadonlySet<string> = new Set([AGENT_TYPE]);

/** True when `type` may only be authored by the shell itself — no app grant,
 *  however broad (`entities.write:*` included), reaches it. */
export function isShellOwnedEntityType(type: string): boolean {
	return SHELL_OWNED_ENTITY_TYPES.has(type);
}
