/**
 * Repository for the `account` table in `account.db` — the control-plane
 * account this device is signed in as (iteration 14.1).
 *
 * At most one account is linked per device in v1 (no multi-account switching).
 * Holds no payment details — only the identity link (`id` = control-plane
 * account id, NEVER a vault id) and the last-known plan, used as a cheap read
 * before the verified entitlement is consulted. SQL lives only here, per the
 * repository-pattern convention (CLAUDE.md §Repository pattern for SQL).
 */

import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";
import { PlanTier, asPlanTier } from "./plan";

export type AccountRecord = {
	/** Control-plane account id (the entitlement token's `sub`). */
	id: string;
	email: string | null;
	plan: PlanTier;
	linkedAt: number;
	updatedAt: number;
};

type DbRow = {
	id: string;
	email: string | null;
	plan: string;
	linked_at: number;
	updated_at: number;
};

export class AccountRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	/** The currently linked account, or null when signed out (the v1 default). */
	getLinked(): AccountRecord | null {
		const row = this.stmt(
			"SELECT id, email, plan, linked_at, updated_at FROM account ORDER BY linked_at DESC LIMIT 1",
		).get() as DbRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	get(id: string): AccountRecord | null {
		const row = this.stmt(
			"SELECT id, email, plan, linked_at, updated_at FROM account WHERE id = ?",
		).get(id) as DbRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	/** Link (or update) an account. Idempotent on `id`. */
	link(record: AccountRecord): void {
		this.stmt(
			"INSERT INTO account (id, email, plan, linked_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
				"ON CONFLICT(id) DO UPDATE SET email = excluded.email, plan = excluded.plan, updated_at = excluded.updated_at",
		).run(record.id, record.email, record.plan, record.linkedAt, record.updatedAt);
	}

	/** Sign out — remove the linked account. Returns whether a row was removed. */
	unlink(id: string): boolean {
		const result = this.stmt("DELETE FROM account WHERE id = ?").run(id);
		return Number(result.changes) > 0;
	}
}

function rowToRecord(row: DbRow): AccountRecord {
	// A stored plan that no longer maps to a known tier (older client, manual
	// tamper) degrades to Free — fail-closed, never grant a tier we can't name.
	return {
		id: row.id,
		email: row.email,
		plan: asPlanTier(row.plan) ?? PlanTier.Free,
		linkedAt: row.linked_at,
		updatedAt: row.updated_at,
	};
}
