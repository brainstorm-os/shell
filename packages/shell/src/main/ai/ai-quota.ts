/**
 * 14.8 — per-app AI quota enforcement + bundled-credit accounting.
 *
 * `AiQuotaService` sits on the AI broker's dispatch path:
 *
 *   - `checkBudget(appId)` runs BEFORE a model call. It reads the app's
 *     budget (Settings → AI, `ai-settings-store.ts`), sums the app's usage
 *     over the rolling 30-day window from the `ai_usage` table, and throws
 *     the distinct `AiBudgetExhaustedError` (wire kind `AiBudgetExhausted`,
 *     never a generic `Unavailable`) when either the token or the credit
 *     ceiling is reached — so apps can render "AI budget exhausted" with a
 *     path to Settings. FAIL-CLOSED: if a budget exists but the accounting
 *     store can't be read, the call is refused (`Unavailable`), never waved
 *     through. No budget row = unlimited (that's the policy, not a fallback).
 *
 *   - `recordUsage(record)` runs AFTER every model-calling verb (success and
 *     failure), pricing the call via the static rate table and inserting one
 *     `ai_usage` row. Best-effort like the JSONL provenance sink: an insert
 *     failure is logged and swallowed so accounting can never break a
 *     completed call. It also debits the bundled-credit ledger when the
 *     vault's entitlement carries `FeatureFlag.BundledAiCredits` AND the call
 *     was platform-billed.
 *
 * SHELL-CALLER POLICY: budgets bind sandboxed apps. The broker verifies every
 * envelope's `app` against the renderer-identity registry, so an app id is
 * trustworthy here. Two caller classes are exempt: the privileged dashboard
 * (`SHELL_IDENTITY`, registered only for the dashboard webContents — an app
 * cannot claim it past `verifyAppIdentity`) and the reserved `_shell.`
 * namespace (main-process internal callers, e.g. `_shell.ai` network fetches;
 * never registered for any sandboxed renderer). Workflow AI steps run under
 * the automations app's identity (broker-interpreter-ports), so they meter
 * against the automations app's budget like any app call.
 *
 * BUNDLED CREDITS (the 14.3/14.6 seam): today every registered provider is
 * BYO (user key / local Ollama), so `isPlatformBilled` returns false in
 * production and no debit is ever written — the routing the broker already
 * has (pinned provider or default) is untouched and BYO calls never consume
 * plan credits. When platform-managed AI routing lands, its provider flags
 * itself platform-billed and debits start accruing locally; a reporter then
 * replays unsynced debits to `/v1/usage/ingest` (see `credit-ledger-repo.ts`
 * for the documented contract TODO).
 */

import { SHELL_IDENTITY } from "@brainstorm-os/capabilities/default-grants";
import { AI_BUDGET_EXHAUSTED_ERROR_KIND } from "@brainstorm-os/sdk-types";
import type { CreditLedgerRepository } from "../billing/credit-ledger-repo";
import { CreditEntryKind } from "../billing/credit-ledger-repo";
import type { AppAiBudget } from "../vault/ai-settings-store";
import { AiUsageOutcome, type AiUsageRecord } from "./ai-usage-log";
import type { AiUsageRepository } from "./ai-usage-repo";
import { CREDIT_MICROS, creditsMicroForUsage } from "./model-rates";
import { AiServiceError } from "./provider";

/** The rolling budget window (30 days). */
export const AI_BUDGET_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Accounting retention — rows older than this are pruned (3 windows). */
export const AI_USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** How often the opportunistic prune may run. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Reserved main-process caller namespace (e.g. `_shell.ai`, `_shell.mcp`). */
const SHELL_INTERNAL_PREFIX = "_shell.";

export enum AiBudgetUnit {
	Tokens = "tokens",
	Credits = "credits",
}

/** The distinct, app-visible over-budget error. The broker maps `name` to the
 *  wire `error.kind`, so apps see `AiBudgetExhausted` — never `Unavailable`. */
export class AiBudgetExhaustedError extends Error {
	override readonly name = AI_BUDGET_EXHAUSTED_ERROR_KIND;
	readonly appId: string;
	readonly unit: AiBudgetUnit;
	readonly used: number;
	readonly limit: number;

	constructor(appId: string, unit: AiBudgetUnit, used: number, limit: number) {
		super(
			`ai: ${appId} exhausted its 30-day AI budget (${used} of ${limit} ${unit}); raise or clear the budget in Settings → AI`,
		);
		this.appId = appId;
		this.unit = unit;
		this.used = used;
		this.limit = limit;
	}
}

export type AiQuotaDeps = {
	/** The active vault's `ai_usage` repo, or null when no vault is open. */
	getUsageRepo: () => Promise<AiUsageRepository | null>;
	/** The active vault's per-app budgets (Settings → AI). */
	getBudgets: () => Promise<Record<string, AppAiBudget>>;
	/** The active vault's bundled-credit ledger, or null. Optional — omitted
	 *  where bundled credits can't apply (tests without billing). */
	getCreditLedger?: () => Promise<CreditLedgerRepository | null>;
	/** Whether the vault's entitlement carries `FeatureFlag.BundledAiCredits`. */
	hasBundledCredits?: () => Promise<boolean>;
	/** Whether a provider's calls bill against platform credits (vs BYO).
	 *  Production passes `() => false` until platform routing lands (TODO 14.x
	 *  — see module doc). */
	isPlatformBilled?: (providerId: string) => boolean;
	/** Injected pricer, defaulting to the static rate table. */
	priceCall?: typeof creditsMicroForUsage;
	now?: () => number;
	windowMs?: number;
};

export class AiQuotaService {
	private readonly deps: AiQuotaDeps;
	private readonly now: () => number;
	private readonly windowMs: number;
	private lastPruneMs = 0;

	constructor(deps: AiQuotaDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.windowMs = deps.windowMs ?? AI_BUDGET_WINDOW_MS;
	}

	/** True for callers budgets never bind (see module doc §shell-caller policy). */
	isExemptCaller(appId: string): boolean {
		return appId === SHELL_IDENTITY || appId.startsWith(SHELL_INTERNAL_PREFIX);
	}

	/**
	 * The pre-dispatch gate. Throws `AiBudgetExhaustedError` when the app's
	 * rolling-window usage has reached a configured ceiling; throws
	 * `Unavailable` (fail-closed) when a budget exists but the accounting
	 * store is unreadable. Resolves silently otherwise.
	 */
	async checkBudget(appId: string): Promise<void> {
		if (this.isExemptCaller(appId)) return;
		let budget: AppAiBudget | undefined;
		try {
			budget = (await this.deps.getBudgets())[appId];
		} catch (error) {
			// A budget we can't read might exist — refusing is the only
			// fail-closed answer (mirrors the broker's ledger-error posture).
			throw new AiServiceError(
				"Unavailable",
				`ai: budget store unreadable (${(error as Error).message})`,
			);
		}
		if (!budget || (!budget.maxTokens && !budget.maxCredits)) return;
		let repo: AiUsageRepository | null;
		try {
			repo = await this.deps.getUsageRepo();
		} catch {
			repo = null;
		}
		if (!repo) {
			throw new AiServiceError(
				"Unavailable",
				"ai: usage accounting unavailable, budgeted call refused",
			);
		}
		const totals = repo.totalsForApp(appId, this.now() - this.windowMs);
		if (budget.maxTokens && totals.totalTokens >= budget.maxTokens) {
			throw new AiBudgetExhaustedError(
				appId,
				AiBudgetUnit.Tokens,
				totals.totalTokens,
				budget.maxTokens,
			);
		}
		if (budget.maxCredits && totals.creditsMicro >= budget.maxCredits * CREDIT_MICROS) {
			throw new AiBudgetExhaustedError(
				appId,
				AiBudgetUnit.Credits,
				Math.floor(totals.creditsMicro / CREDIT_MICROS),
				budget.maxCredits,
			);
		}
	}

	/**
	 * The post-call accounting sink (success and failure alike — mirrors the
	 * JSONL provenance semantics). Best-effort: any throw is logged, never
	 * re-thrown, so accounting cannot break a completed call.
	 */
	async recordUsage(record: AiUsageRecord): Promise<void> {
		try {
			const repo = await this.deps.getUsageRepo();
			if (!repo) return; // no vault → nothing to account against
			const price = this.deps.priceCall ?? creditsMicroForUsage;
			const creditsMicro =
				record.provider.length > 0
					? price(record.provider, record.model, record.promptTokens, record.completionTokens)
					: 0;
			repo.insert({
				ts: record.ts,
				appId: record.appId,
				verb: record.verb,
				provider: record.provider,
				model: record.model,
				promptTokens: record.promptTokens,
				completionTokens: record.completionTokens,
				totalTokens: record.totalTokens,
				creditsMicro,
				outcome: record.outcome,
				durationMs: record.durationMs,
			});
			await this.debitBundledCredits(record, creditsMicro);
			this.pruneOpportunistically(repo);
		} catch (error) {
			console.warn(`[ai/quota] usage accounting failed: ${(error as Error).message}`);
		}
	}

	/** Debit the plan's bundled credits for a successful platform-billed call.
	 *  BYO calls (all calls today — see module doc) never debit. */
	private async debitBundledCredits(record: AiUsageRecord, creditsMicro: number): Promise<void> {
		if (record.outcome !== AiUsageOutcome.Ok || creditsMicro <= 0) return;
		if (!this.deps.isPlatformBilled?.(record.provider)) return;
		if (!(await this.deps.hasBundledCredits?.())) return;
		const ledger = await this.deps.getCreditLedger?.();
		if (!ledger) return;
		ledger.append({
			ts: record.ts,
			kind: CreditEntryKind.Debit,
			creditsMicro,
			appId: record.appId,
			provider: record.provider,
			model: record.model,
		});
	}

	private pruneOpportunistically(repo: AiUsageRepository): void {
		const now = this.now();
		if (now - this.lastPruneMs < PRUNE_INTERVAL_MS) return;
		this.lastPruneMs = now;
		repo.deleteBefore(now - AI_USAGE_RETENTION_MS);
	}
}
