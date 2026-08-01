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
 *
 * v3 (Agent-12a, doc 77) adds the agent-observability trace: `agent_runs`
 * (one row per chat turn / automation run) + `agent_events` (ordered events
 * within a run — tool calls, denials with the missing capability, proposal
 * gestures), and a nullable `run_id` on `ai_usage` so the timeline derives
 * model-call steps from the accounting substrate instead of duplicating it
 * (OQ-AO-5). Same metadata-only posture: never prompt/completion/argument
 * bytes. Retention is tiered + count-capped (OQ-AO-1) — see
 * `agents/trace/agent-trace-repo.ts` for the prune contract.
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
	{
		version: 3,
		description: "account.db v3 — agent run/event trace substrate + ai_usage.run_id (Agent-12a)",
		up: (db) => {
			db.exec(`
				CREATE TABLE agent_runs (
					id               TEXT PRIMARY KEY,
					surface          TEXT NOT NULL,
					conversation_id  TEXT,
					workflow_run_id  TEXT,
					agent            TEXT NOT NULL,
					started_at       INTEGER NOT NULL,
					ended_at         INTEGER,
					outcome          TEXT,
					denial_count     INTEGER NOT NULL DEFAULT 0
				);
				CREATE INDEX agent_runs_started ON agent_runs (started_at);
				CREATE INDEX agent_runs_agent ON agent_runs (agent, started_at);
				CREATE INDEX agent_runs_conversation ON agent_runs (conversation_id, started_at);
				CREATE TABLE agent_events (
					run_id           TEXT NOT NULL,
					seq              INTEGER NOT NULL,
					ts               INTEGER NOT NULL,
					kind             TEXT NOT NULL,
					tool             TEXT NOT NULL DEFAULT '',
					target_entity_id TEXT,
					capability       TEXT,
					outcome          TEXT NOT NULL,
					detail           TEXT,
					duration_ms      INTEGER NOT NULL DEFAULT 0,
					PRIMARY KEY (run_id, seq)
				);
				CREATE INDEX agent_events_ts ON agent_events (ts);
				CREATE INDEX agent_events_target ON agent_events (target_entity_id)
					WHERE target_entity_id IS NOT NULL;
				ALTER TABLE ai_usage ADD COLUMN run_id TEXT;
			`);
		},
	},
];
