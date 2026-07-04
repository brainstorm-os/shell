/**
 * Repository for the `ai_usage` table in `account.db` (iteration 14.8).
 *
 * One row per AI broker model call — the accounting substrate for rolling-
 * window per-app budget enforcement and the Settings → AI usage view. Rows
 * carry metadata only (app, verb, provider/model, token counts, credit cost,
 * outcome, duration) — never a prompt or completion. Distinct from the 11.8
 * JSONL provenance log (a per-device diagnostics stream); this table is the
 * queryable per-vault ledger budgets are enforced against.
 *
 * SQL lives only here (CLAUDE.md §Repository pattern for SQL).
 */

import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite";
import { AiUsageOutcome } from "./ai-usage-log";

export type AiUsageRow = {
	ts: number;
	appId: string;
	verb: string;
	provider: string;
	model: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Cost in integer micro-credits (see `model-rates.ts`). */
	creditsMicro: number;
	outcome: AiUsageOutcome;
	durationMs: number;
};

/** Window totals for one app — what the budget check compares against. */
export type AiUsageTotals = {
	calls: number;
	totalTokens: number;
	creditsMicro: number;
};

/** Per (provider, model) slice of one app's window usage. */
export type AiProviderModelUsage = {
	provider: string;
	model: string;
	calls: number;
	totalTokens: number;
	creditsMicro: number;
};

/** One app's aggregated window usage for the Settings → AI panel. */
export type AiAppUsageSummary = {
	appId: string;
	calls: number;
	errors: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	creditsMicro: number;
	lastSeenMs: number;
	byProviderModel: readonly AiProviderModelUsage[];
};

export class AiUsageRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	/** Record one call. Returns the inserted rowid. */
	insert(row: AiUsageRow): number {
		const result = this.stmt(
			"INSERT INTO ai_usage (ts, app_id, verb, provider, model, prompt_tokens, completion_tokens, total_tokens, credits_micro, outcome, duration_ms) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			row.ts,
			row.appId,
			row.verb,
			row.provider,
			row.model,
			row.promptTokens,
			row.completionTokens,
			row.totalTokens,
			row.creditsMicro,
			row.outcome,
			row.durationMs,
		);
		return Number(result.lastInsertRowid);
	}

	/** One app's totals since `sinceTs` (inclusive) — the budget-check read. */
	totalsForApp(appId: string, sinceTs: number): AiUsageTotals {
		const row = this.stmt(
			"SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(credits_micro), 0) AS credits " +
				"FROM ai_usage WHERE app_id = ? AND ts >= ?",
		).get(appId, sinceTs) as { calls: number; tokens: number; credits: number };
		return {
			calls: Number(row.calls),
			totalTokens: Number(row.tokens),
			creditsMicro: Number(row.credits),
		};
	}

	/** Window usage grouped per app (with a per provider/model breakdown),
	 *  most-recently-active first — the Settings → AI usage list. */
	summarizeByApp(sinceTs: number): readonly AiAppUsageSummary[] {
		const rows = this.stmt(
			"SELECT app_id, provider, model, COUNT(*) AS calls, " +
				"SUM(CASE WHEN outcome = ? THEN 1 ELSE 0 END) AS errors, " +
				"COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, " +
				"COALESCE(SUM(completion_tokens), 0) AS completion_tokens, " +
				"COALESCE(SUM(total_tokens), 0) AS total_tokens, " +
				"COALESCE(SUM(credits_micro), 0) AS credits_micro, " +
				"MAX(ts) AS last_seen " +
				"FROM ai_usage WHERE ts >= ? GROUP BY app_id, provider, model",
		).all(AiUsageOutcome.Error, sinceTs) as Array<{
			app_id: string;
			provider: string;
			model: string;
			calls: number;
			errors: number;
			prompt_tokens: number;
			completion_tokens: number;
			total_tokens: number;
			credits_micro: number;
			last_seen: number;
		}>;
		const byApp = new Map<string, AiAppUsageSummary & { byProviderModel: AiProviderModelUsage[] }>();
		for (const row of rows) {
			let app = byApp.get(row.app_id);
			if (!app) {
				app = {
					appId: row.app_id,
					calls: 0,
					errors: 0,
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					creditsMicro: 0,
					lastSeenMs: 0,
					byProviderModel: [],
				};
				byApp.set(row.app_id, app);
			}
			app.calls += Number(row.calls);
			app.errors += Number(row.errors);
			app.promptTokens += Number(row.prompt_tokens);
			app.completionTokens += Number(row.completion_tokens);
			app.totalTokens += Number(row.total_tokens);
			app.creditsMicro += Number(row.credits_micro);
			app.lastSeenMs = Math.max(app.lastSeenMs, Number(row.last_seen));
			// Failed-before-resolve rows carry an empty provider — they count in
			// the app totals but aren't a meaningful provider/model slice.
			if (row.provider.length > 0) {
				app.byProviderModel.push({
					provider: row.provider,
					model: row.model,
					calls: Number(row.calls),
					totalTokens: Number(row.total_tokens),
					creditsMicro: Number(row.credits_micro),
				});
			}
		}
		const out = [...byApp.values()];
		for (const app of out) {
			app.byProviderModel.sort((a, b) => {
				if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
				return `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`);
			});
		}
		out.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
		return out;
	}

	/** Retention: drop rows older than `beforeTs`. Returns rows deleted. */
	deleteBefore(beforeTs: number): number {
		const result = this.stmt("DELETE FROM ai_usage WHERE ts < ?").run(beforeTs);
		return Number(result.changes);
	}
}
