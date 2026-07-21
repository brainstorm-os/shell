/**
 * Repository for the `ai_credit_ledger` table in `account.db` (iteration 14.8).
 *
 * The local double-entry-lite ledger for the plan's **bundled AI credits**
 * (`FeatureFlag.BundledAiCredits`, Pro+): `grant` rows add credits (dropped in
 * by the entitlement refresh when a billing period starts), `debit` rows
 * consume them (recorded by `AiQuotaService` for platform-billed calls).
 * Balance = grants − debits, in integer micro-credits.
 *
 * The `synced` flag is the remote-sync seam: a future reporter replays
 * unsynced debits to the control plane's `/v1/usage/ingest`
 * (`brainstorm-cloud/packages/api-client` §UsageIngestRequest — today that
 * contract meters `storage.bytes` / `sync.egress.bytes` only; an `ai.credits`
 * meter is the documented TODO) and marks them with the remote receipt.
 * Local-first: the ledger is authoritative for the offline balance; the
 * control plane reconciles.
 *
 * SQL lives only here (CLAUDE.md §Repository pattern for SQL).
 */

import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";

export enum CreditEntryKind {
	/** Credits added (plan grant / top-up). */
	Grant = "grant",
	/** Credits consumed by a platform-billed AI call. */
	Debit = "debit",
}

export type CreditLedgerEntry = {
	ts: number;
	kind: CreditEntryKind;
	/** Always positive; the kind decides the sign in the balance. */
	creditsMicro: number;
	/** Debits carry the consuming call's app/provider/model; grants leave null. */
	appId?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
};

export type CreditLedgerRow = CreditLedgerEntry & {
	id: number;
	synced: boolean;
	remoteRef: string | null;
};

type DbRow = {
	id: number;
	ts: number;
	entry_kind: string;
	credits_micro: number;
	app_id: string | null;
	provider: string | null;
	model: string | null;
	synced: number;
	remote_ref: string | null;
};

export class CreditLedgerRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	/** Append one entry. Rejects non-positive amounts (fail-closed accounting:
	 *  a zero/negative row could silently mint credits). Returns the rowid. */
	append(entry: CreditLedgerEntry): number {
		if (!Number.isFinite(entry.creditsMicro) || entry.creditsMicro <= 0) {
			throw new Error(`credit ledger: creditsMicro must be positive, got ${entry.creditsMicro}`);
		}
		const result = this.stmt(
			"INSERT INTO ai_credit_ledger (ts, entry_kind, credits_micro, app_id, provider, model) " +
				"VALUES (?, ?, ?, ?, ?, ?)",
		).run(
			entry.ts,
			entry.kind,
			Math.floor(entry.creditsMicro),
			entry.appId ?? null,
			entry.provider ?? null,
			entry.model ?? null,
		);
		return Number(result.lastInsertRowid);
	}

	/** Current balance in micro-credits (grants − debits). Can go negative —
	 *  the consumer decides the floor policy (14.8 debits before checking). */
	balanceMicro(): number {
		const row = this.stmt(
			"SELECT COALESCE(SUM(CASE WHEN entry_kind = ? THEN credits_micro ELSE -credits_micro END), 0) AS balance " +
				"FROM ai_credit_ledger",
		).get(CreditEntryKind.Grant) as { balance: number };
		return Number(row.balance);
	}

	/** Oldest-first unsynced entries, for the future usage-ingest reporter. */
	unsynced(limit = 100): readonly CreditLedgerRow[] {
		const rows = this.stmt(
			"SELECT id, ts, entry_kind, credits_micro, app_id, provider, model, synced, remote_ref " +
				"FROM ai_credit_ledger WHERE synced = 0 ORDER BY id ASC LIMIT ?",
		).all(limit) as DbRow[];
		return rows.map(rowToRecord);
	}

	/** Mark entries as reported to the control plane. */
	markSynced(ids: readonly number[], remoteRef: string): void {
		if (ids.length === 0) return;
		const update = this.stmt("UPDATE ai_credit_ledger SET synced = 1, remote_ref = ? WHERE id = ?");
		const txn = this.db.transaction(() => {
			for (const id of ids) update.run(remoteRef, id);
		});
		txn();
	}
}

function rowToRecord(row: DbRow): CreditLedgerRow {
	return {
		id: row.id,
		ts: row.ts,
		kind: row.entry_kind === CreditEntryKind.Grant ? CreditEntryKind.Grant : CreditEntryKind.Debit,
		creditsMicro: row.credits_micro,
		appId: row.app_id ?? undefined,
		provider: row.provider ?? undefined,
		model: row.model ?? undefined,
		synced: row.synced === 1,
		remoteRef: row.remote_ref,
	};
}
