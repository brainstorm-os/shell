/**
 * Capability ledger — CRUD on `ledger.db`'s `capabilities` table.
 *
 * Per §Capabilities:
 *
 *   A capability is a named, scoped grant. Capabilities are listed in the
 *   manifest, presented to the user at install (and on update if new ones
 *   appear), recorded in the capability ledger, and checked on every
 *   host-service call.
 *
 * Capability name convention: `<service>.<verb>[:<scope>]`. We store the
 * service.verb part in `capability` and the optional `:<scope>` separately
 * in `scope` so the broker can match by either exact-scope or wildcard
 * (`entities.read:*` matches any specific type request).
 *
 * Stage 4 ships the CRUD + check API. Stage 5's app-install flow populates
 * grants when the user accepts a manifest's capability requests.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import { ulid } from "ulid";
import { isAgentGrantableCapability } from "./agent-grants";
import { parseCapability } from "./capability-string";
import { isAgentPrincipal } from "./principals";

export { parseCapability } from "./capability-string";

/** How a capability grant was created. String values are persisted in the
 *  `granted_via` column (and its CHECK constraint) — keep them stable. */
export enum GrantedVia {
	Install = "install",
	Runtime = "runtime",
}

export type CapabilityGrant = {
	id: string;
	appId: string;
	capability: string; // e.g. "entities.read"
	scope: string | null; // e.g. "io.example/Note/v1" or null for unscoped (or "*" wildcard)
	grantedAt: number;
	grantedVia: GrantedVia;
};

export type GrantInput = {
	appId: string;
	capability: string;
	scope?: string | null;
	grantedVia: GrantedVia;
};

/** Thrown when a grant would give an AGENT principal a capability outside the
 *  agent-grantable vocabulary (writes, network, MCP, sharing, non-propose
 *  dispatch). Loud by design: this is a policy violation in the caller, never
 *  a condition to handle. */
export class AgentCapabilityRefusedError extends Error {
	constructor(principal: string, capability: string) {
		super(`Capability "${capability}" may never be granted to an agent (${principal}).`);
		this.name = "AgentCapabilityRefused";
	}
}

export class LedgerUnavailableError extends Error {
	constructor(cause: unknown) {
		super(
			`Capability ledger is unavailable — failing closed. ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "LedgerUnavailable";
	}
}

export class CapabilityLedger {
	constructor(private readonly db: SqliteDatabase) {}

	/**
	 * Record a new grant. Idempotent: granting the same `(appId, capability, scope)`
	 * twice returns the existing grant unchanged. Re-granting a previously revoked
	 * capability inserts a fresh row (the old row stays for audit).
	 */
	grant(input: GrantInput): CapabilityGrant {
		// Agent-Teams-1 — the agent-grantable vocabulary is enforced HERE, at the
		// one choke point every grant path funnels through, not only at the Team
		// surface's call site. Otherwise a sibling grant path (the egress/ingress
		// consent prompts take a caller-supplied principal string) could hand an
		// agent a capability the policy exists to forbid.
		if (isAgentPrincipal(input.appId)) {
			const required =
				input.scope === null || input.scope === undefined
					? input.capability
					: `${input.capability}:${input.scope}`;
			if (!isAgentGrantableCapability(required)) {
				throw new AgentCapabilityRefusedError(input.appId, required);
			}
		}
		const existing = this.findActive(input.appId, input.capability, input.scope ?? null);
		if (existing) return existing;
		const row: CapabilityGrant = {
			id: `cap_${ulid()}`,
			appId: input.appId,
			capability: input.capability,
			scope: input.scope ?? null,
			grantedAt: Date.now(),
			grantedVia: input.grantedVia,
		};
		this.run(
			"INSERT INTO capabilities (id, app_id, capability, scope, granted_at, granted_via) VALUES (?, ?, ?, ?, ?, ?)",
			[row.id, row.appId, row.capability, row.scope, row.grantedAt, row.grantedVia],
		);
		return row;
	}

	/**
	 * Mark a grant revoked. Returns true if a live grant was found and revoked,
	 * false if no matching live grant existed. Revoked grants keep their row so
	 * the audit trail isn't lost.
	 */
	revoke(appId: string, capability: string, scope: string | null = null): boolean {
		const existing = this.findActive(appId, capability, scope);
		if (!existing) return false;
		this.run("UPDATE capabilities SET revoked_at = ? WHERE id = ?", [Date.now(), existing.id]);
		return true;
	}

	/** Mark every grant for an app revoked. Used by uninstall flows in Stage 5. */
	revokeAllFor(appId: string): number {
		const result = this.run(
			"UPDATE capabilities SET revoked_at = ? WHERE app_id = ? AND revoked_at IS NULL",
			[Date.now(), appId],
		);
		return Number(result.changes);
	}

	/** All live grants for an app, sorted by capability for stable display. */
	listActive(appId: string): CapabilityGrant[] {
		const rows = this.all<DbRow>(
			"SELECT id, app_id, capability, scope, granted_at, granted_via FROM capabilities WHERE app_id = ? AND revoked_at IS NULL ORDER BY capability, scope",
			[appId],
		);
		return rows.map(rowToGrant);
	}

	/**
	 * Does this app have a live grant that satisfies the requested capability?
	 *
	 *   - Exact match: required="entities.read:io.example/Note/v1" matches a
	 *     grant with the same capability + scope.
	 *   - Wildcard grant: a grant with `scope = "*"` matches any specific
	 *     scope request for the same capability.
	 *   - Unscoped: a request without a scope is satisfied by a grant whose
	 *     scope is null (or "*").
	 *
	 * On any SQL failure (corrupt DB, locked file), this throws
	 * `LedgerUnavailableError` so the broker can fail closed per
	 */
	has(appId: string, required: string): boolean {
		const { capability, scope } = parseCapability(required);
		try {
			if (scope === null) {
				const row = this.get<{ n: number }>(
					"SELECT COUNT(*) AS n FROM capabilities WHERE app_id = ? AND capability = ? AND scope IS NULL AND revoked_at IS NULL",
					[appId, capability],
				);
				return (row?.n ?? 0) > 0;
			}
			const row = this.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM capabilities WHERE app_id = ? AND capability = ? AND (scope = ? OR scope = '*') AND revoked_at IS NULL",
				[appId, capability, scope],
			);
			return (row?.n ?? 0) > 0;
		} catch (error) {
			throw new LedgerUnavailableError(error);
		}
	}

	/**
	 * Convenience: did this app at any point have the capability? Surfaces
	 * revoked + live grants together. Used by the broker to log "previously
	 * granted; revoked" with helpful context.
	 */
	historyFor(appId: string, capability: string, scope: string | null = null): CapabilityGrant[] {
		const rows = this.all<DbRow>(
			"SELECT id, app_id, capability, scope, granted_at, granted_via FROM capabilities WHERE app_id = ? AND capability = ? AND ((? IS NULL AND scope IS NULL) OR scope = ? OR scope = '*') ORDER BY granted_at DESC",
			[appId, capability, scope, scope],
		);
		return rows.map(rowToGrant);
	}

	private findActive(
		appId: string,
		capability: string,
		scope: string | null,
	): CapabilityGrant | null {
		const row = this.get<DbRow>(
			scope === null
				? "SELECT id, app_id, capability, scope, granted_at, granted_via FROM capabilities WHERE app_id = ? AND capability = ? AND scope IS NULL AND revoked_at IS NULL"
				: "SELECT id, app_id, capability, scope, granted_at, granted_via FROM capabilities WHERE app_id = ? AND capability = ? AND scope = ? AND revoked_at IS NULL",
			scope === null ? [appId, capability] : [appId, capability, scope],
		);
		return row ? rowToGrant(row) : null;
	}

	private run(
		sql: string,
		params: unknown[],
	): { changes: number; lastInsertRowid: number | bigint } {
		return this.db.prepare(sql).run(...params);
	}

	private get<T>(sql: string, params: unknown[]): T | undefined {
		return this.db.prepare(sql).get(...params) as T | undefined;
	}

	private all<T>(sql: string, params: unknown[]): T[] {
		return this.db.prepare(sql).all(...params) as T[];
	}
}

type DbRow = {
	id: string;
	app_id: string;
	capability: string;
	scope: string | null;
	granted_at: number;
	granted_via: GrantedVia;
};

function rowToGrant(row: DbRow): CapabilityGrant {
	return {
		id: row.id,
		appId: row.app_id,
		capability: row.capability,
		scope: row.scope,
		grantedAt: row.granted_at,
		grantedVia: row.granted_via,
	};
}
