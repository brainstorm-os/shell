/**
 * `account.db` schema — the per-device cache of the commercial control plane's
 * view of this install (iteration 14.1).
 *
 * This DB is the product (data-plane) side of the billing boundary
 * (, [
 * §Commercial backend]). It holds NO vault content and NO payment details —
 * only the *account link* (which control-plane account, if any, this vault is
 * signed in as) and a cached *entitlement* (the offline-verifiable plan + feature
 * flags the client gates features on). The authoritative system-of-record lives
 * in the out-of-repo `brainstorm-cloud` control plane; this is a cache the
 * shell can read offline. v1 ships no commercial surface: the tables exist and
 * stay empty, and `BillingService` synthesises a hardcoded Free entitlement.
 *
 * Like `settings.db` and `cookies.db`, this is per-device, NON-synced state —
 * an account link and entitlement belong to the person on this device, not the
 * vault's CRDT set. A corrupt file is disposable (archive + recreate empty →
 * falls back to Free + re-fetch), so it never blocks vault open (see
 * `recovery-plan.ts`).
 *
 * The `entitlement` row mirrors the cross-plane entitlement-token claims
 * (`brainstorm-cloud/packages/api-client` §EntitlementClaims) so a future
 * control-plane refresh (14.3) can drop a verified token straight in: the
 * compact JWS `token` is retained for offline re-verification + refresh, with
 * the decoded `plan` / `features` / expiries denormalised for cheap reads.
 *
 * v2 (14.8) adds the AI accounting tables: `ai_usage` (one row per AI broker
 * model call — app, verb, provider/model, tokens, credit cost; the substrate
 * for rolling-window per-app budget enforcement + the Settings → AI usage
 * view) and `ai_credit_ledger` (grants/debits against the plan's bundled AI
 * credits, with a `synced` flag so a future control-plane reporter can
 * replay unsynced debits to `/v1/usage/ingest`). Metadata only — never a
 * prompt or completion.
 */

import type { SqliteMigration } from "./migrations";

export const ACCOUNT_MIGRATIONS: SqliteMigration[] = [
	{
		version: 1,
		description: "account.db v1 — account link + cached entitlement",
		up: (db) => {
			db.exec(`
				CREATE TABLE account (
					id          TEXT PRIMARY KEY,
					email       TEXT,
					plan        TEXT NOT NULL,
					linked_at   INTEGER NOT NULL,
					updated_at  INTEGER NOT NULL
				);
				CREATE TABLE entitlement (
					account_id  TEXT PRIMARY KEY,
					token       TEXT NOT NULL,
					plan        TEXT NOT NULL,
					features    TEXT NOT NULL,
					issued_at   INTEGER NOT NULL,
					soft_exp    INTEGER NOT NULL,
					hard_exp    INTEGER NOT NULL,
					cached_at   INTEGER NOT NULL
				);
			`);
		},
	},
	{
		version: 2,
		description: "account.db v2 — per-app AI usage accounting + bundled-credit ledger (14.8)",
		up: (db) => {
			db.exec(`
				CREATE TABLE ai_usage (
					id                 INTEGER PRIMARY KEY AUTOINCREMENT,
					ts                 INTEGER NOT NULL,
					app_id             TEXT NOT NULL,
					verb               TEXT NOT NULL,
					provider           TEXT NOT NULL,
					model              TEXT NOT NULL,
					prompt_tokens      INTEGER NOT NULL,
					completion_tokens  INTEGER NOT NULL,
					total_tokens       INTEGER NOT NULL,
					credits_micro      INTEGER NOT NULL,
					outcome            TEXT NOT NULL,
					duration_ms        INTEGER NOT NULL
				);
				CREATE INDEX ai_usage_app_ts ON ai_usage (app_id, ts);
				CREATE INDEX ai_usage_ts ON ai_usage (ts);
				CREATE TABLE ai_credit_ledger (
					id             INTEGER PRIMARY KEY AUTOINCREMENT,
					ts             INTEGER NOT NULL,
					entry_kind     TEXT NOT NULL,
					credits_micro  INTEGER NOT NULL,
					app_id         TEXT,
					provider       TEXT,
					model          TEXT,
					synced         INTEGER NOT NULL DEFAULT 0,
					remote_ref     TEXT
				);
				CREATE INDEX ai_credit_ledger_synced ON ai_credit_ledger (synced, id);
			`);
		},
	},
];
