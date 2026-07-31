/**
 * The main-side gate every `Agent/v1` row passes before it is treated as an
 * agent member (Agent-Teams-1 hardening).
 *
 * The `sdk-types` codec validates SHAPE; it has no crypto dependency, so it
 * cannot check the one thing that actually matters: that a record's
 * `fingerprint` — the value used as the LEDGER PRINCIPAL — is genuinely
 * derived from its `pubkey`. Without that binding, a row claiming a granted
 * agent's fingerprint alongside an attacker's pubkey would run under the real
 * agent's ceiling, and a decoy carrying a real fingerprint would destroy that
 * agent's (unrecoverable, device-local) key on delete.
 *
 * Two independent gates, both required:
 *   1. AUTHORSHIP — the row must have been written by the shell. The privileged
 *      directory is the only writer; the entities service refuses `Agent/v1`
 *      writes from every app, so this catches rows that predate that fence or
 *      arrive from elsewhere.
 *   2. BINDING — `fingerprint === fingerprintPublicKey(decode(pubkey))`.
 *
 * A row failing either is not "an agent with a problem" — it is not an agent.
 */

import { type AgentDef, readAgentDef } from "@brainstorm-os/sdk-types";
import {
	fingerprintPublicKey,
	publicKeyFromBase64,
	publicKeyToBase64,
} from "../credentials/identity";

/** The `createdBy` value the shell stamps on rows it authors. */
export const SHELL_PRINCIPAL = "shell";

/**
 * True when `fingerprint` is the real fingerprint of `pubkey` AND `pubkey` is
 * spelled CANONICALLY.
 *
 * The canonical check is not pedantry: a 32-byte key has several valid base64
 * spellings (padded/unpadded, and the unused trailing bits of the final symbol
 * are ignored on decode), and the pubkey STRING is the roster/mention map key
 * while the fingerprint is the ledger principal. Without canonicalization the
 * two are not 1:1 — two "different" agents could share one ceiling, which is
 * how the pentest hung an attacker-authored persona off a granted agent.
 */
export function bindsIdentity(pubkey: string, fingerprint: string): boolean {
	try {
		const key = publicKeyFromBase64(pubkey);
		if (publicKeyToBase64(key) !== pubkey) return false;
		return fingerprintPublicKey(key) === fingerprint;
	} catch {
		return false;
	}
}

/**
 * Parse a persisted row into an `AgentDef`, or null when it is not a
 * trustworthy agent record. `createdBy` must be the shell and the identity
 * halves must bind.
 */
export function readTrustedAgentDef(row: {
	createdBy: string;
	properties: Record<string, unknown>;
}): AgentDef | null {
	if (row.createdBy !== SHELL_PRINCIPAL) return null;
	const def = readAgentDef(row.properties);
	if (!def) return null;
	return bindsIdentity(def.pubkey, def.fingerprint) ? def : null;
}

/**
 * The raw `fingerprint` string on a row, whatever its trust state — used ONLY
 * by delete, so an agent whose record was later mangled can still have its
 * authority revoked and its key destroyed. Never use this to decide what an
 * agent may DO.
 */
export function rawFingerprintOf(properties: Record<string, unknown>): string | null {
	const value = properties.fingerprint;
	return typeof value === "string" && value.length > 0 ? value : null;
}
