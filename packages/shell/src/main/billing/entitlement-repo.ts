/**
 * Repository for the `entitlement` table in `account.db` — the per-account
 * cache of the last verified entitlement token (iteration 14.1).
 *
 * Mirrors the cross-plane entitlement-token claims (`brainstorm-cloud/
 * packages/api-client` §EntitlementClaims): the compact JWS `token` is retained
 * for offline re-verification + refresh, with the decoded `plan` / `features` /
 * expiries denormalised so a plan read costs one indexed lookup, no crypto.
 *
 * v1 never writes here (no control-plane integration yet) — the table stays
 * empty and `BillingService` falls back to the hardcoded Free entitlement. The
 * `save`/`get` surface exists so 14.3's refresh path drops a verified token in
 * without a schema change. SQL lives only here (CLAUDE.md §Repository pattern).
 */

import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";
import { type FeatureFlag, type PlanTier, asFeatureFlags, asPlanTier } from "./plan";

export type CachedEntitlement = {
	accountId: string;
	/** The compact JWS entitlement token, for offline re-verify + refresh. */
	token: string;
	plan: PlanTier;
	features: readonly FeatureFlag[];
	issuedAt: number;
	softExp: number;
	hardExp: number;
	cachedAt: number;
};

type DbRow = {
	account_id: string;
	token: string;
	plan: string;
	features: string;
	issued_at: number;
	soft_exp: number;
	hard_exp: number;
	cached_at: number;
};

export class EntitlementRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	get(accountId: string): CachedEntitlement | null {
		const row = this.stmt(
			"SELECT account_id, token, plan, features, issued_at, soft_exp, hard_exp, cached_at FROM entitlement WHERE account_id = ?",
		).get(accountId) as DbRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	/** Store (or replace) the cached entitlement for an account. Idempotent. */
	save(record: CachedEntitlement): void {
		this.stmt(
			"INSERT INTO entitlement (account_id, token, plan, features, issued_at, soft_exp, hard_exp, cached_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
				"ON CONFLICT(account_id) DO UPDATE SET token = excluded.token, plan = excluded.plan, " +
				"features = excluded.features, issued_at = excluded.issued_at, soft_exp = excluded.soft_exp, " +
				"hard_exp = excluded.hard_exp, cached_at = excluded.cached_at",
		).run(
			record.accountId,
			record.token,
			record.plan,
			JSON.stringify(record.features),
			record.issuedAt,
			record.softExp,
			record.hardExp,
			record.cachedAt,
		);
	}

	delete(accountId: string): boolean {
		const result = this.stmt("DELETE FROM entitlement WHERE account_id = ?").run(accountId);
		return Number(result.changes) > 0;
	}
}

function rowToRecord(row: DbRow): CachedEntitlement | null {
	// An unknown plan string means a tampered / unintelligible cache row — treat
	// the whole entry as absent so the caller falls back to Free (fail-closed),
	// rather than surfacing a plan we can't name.
	const plan = asPlanTier(row.plan);
	if (!plan) return null;
	const features = asFeatureFlags(parseFeatures(row.features));
	return {
		accountId: row.account_id,
		token: row.token,
		plan,
		features,
		issuedAt: row.issued_at,
		softExp: row.soft_exp,
		hardExp: row.hard_exp,
		cachedAt: row.cached_at,
	};
}

function parseFeatures(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
	} catch {
		return [];
	}
}
