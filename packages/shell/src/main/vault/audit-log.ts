import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Per §Logging and audit:
 *
 *   The shell keeps a per-vault audit log of security-relevant events. Format
 *   is JSON-lines (one event per line). Metadata only — no entity payloads,
 *   no file bytes — so the log itself is not a sensitivity multiplier.
 *
 * v1 emits these events:
 *   - vault.create        — vault created
 *   - vault.open          — existing vault opened
 *   - vault.activate      — registry default switched to this vault
 *   - capability.grant    — capability granted to an app (install or runtime)
 *   - capability.revoke   — capability revoked from an app
 *   - ipc.denied          — broker rejected an envelope (denial events from Stage 4)
 */

export type AuditEventKind =
	| "vault.create"
	| "vault.open"
	| "vault.activate"
	| "capability.grant"
	| "capability.revoke"
	| "ipc.denied"
	// Agent-Teams-1 — agent-member lifecycle + per-agent authority changes,
	// keyed on the agent fingerprint so "what happened to this agent" is a
	// filter over one log.
	| "agent.create"
	| "agent.delete"
	| "agent.grant"
	| "agent.revoke";

export type AuditEventInput = {
	kind: AuditEventKind;
	vaultId: string;
	/** Optional override; defaults to Date.now() at write time. */
	ts?: number;
	/** Any additional metadata. Must be JSON-serializable; values stay metadata-only. */
	[metadataKey: string]: unknown;
};

export type AuditEventRecord = {
	ts: number;
	kind: AuditEventKind;
	vaultId: string;
	[metadataKey: string]: unknown;
};

export function auditLogPath(vaultPath: string): string {
	return join(vaultPath, "logs", "audit.log");
}

/**
 * Read the events whose `agent` metadata names `fingerprint` — the Team
 * surface's "what happened to this agent" view (doc 69 §Management: legibility
 * is a query, not a build). Newest first, capped at `limit`. Best-effort like
 * the writer: a missing log or an unparseable line is skipped, never a throw.
 */
export async function readAgentAuditEvents(
	vaultPath: string,
	fingerprint: string,
	limit = 50,
): Promise<AuditEventRecord[]> {
	let raw: string;
	try {
		raw = await readFile(auditLogPath(vaultPath), "utf8");
	} catch {
		return [];
	}
	const matches: AuditEventRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			const record = JSON.parse(line) as AuditEventRecord;
			if (record.agent === fingerprint || record.app === fingerprint) matches.push(record);
		} catch {
			// Skip torn/corrupt lines — the log is best-effort by design.
		}
	}
	return matches.slice(-limit).reverse();
}

/**
 * Append one event. Creates `logs/` if missing. Never throws — the audit log
 * is best-effort; we do not want a failing log to block a vault-create. A
 * failure is logged to console.warn for diagnostics.
 */
export async function appendAuditEvent(vaultPath: string, event: AuditEventInput): Promise<void> {
	const logPath = auditLogPath(vaultPath);
	const { ts, ...rest } = event;
	const record: AuditEventRecord = {
		...rest,
		ts: ts ?? Date.now(),
	};
	const line = `${JSON.stringify(record)}\n`;
	try {
		await mkdir(dirname(logPath), { recursive: true });
		await appendFile(logPath, line, "utf8");
	} catch (error) {
		console.warn("[brainstorm] audit log append failed:", error);
	}
}
