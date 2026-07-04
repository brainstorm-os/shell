/**
 * 14.8 — pure view-model logic for the Settings → AI usage + budget list.
 * Kept free of React/IPC so the aggregation/formatting rules are unit-testable.
 */

const CREDIT_MICROS = 1_000_000;

export type AiBudgetView = {
	maxTokens?: number;
	maxCredits?: number;
};

export type AiUsageRowView = {
	totalTokens: number;
	creditsMicro: number;
};

/** Micro-credits → whole credits for display: 2 decimals below 100, whole
 *  above (a budget list wants magnitude, not micro-precision). */
export function formatCredits(creditsMicro: number): string {
	const credits = creditsMicro / CREDIT_MICROS;
	if (credits >= 100) return String(Math.round(credits));
	return (Math.ceil(credits * 100) / 100).toFixed(2);
}

/** True once the app's window usage has reached any configured ceiling —
 *  mirrors the broker's `AiQuotaService.checkBudget` comparison exactly
 *  (>=, credits compared in micro units) so the panel badge and the actual
 *  enforcement can never disagree. */
export function isBudgetExhausted(
	usage: AiUsageRowView | undefined,
	budget: AiBudgetView | undefined,
): boolean {
	if (!usage || !budget) return false;
	if (budget.maxTokens && usage.totalTokens >= budget.maxTokens) return true;
	if (budget.maxCredits && usage.creditsMicro >= budget.maxCredits * CREDIT_MICROS) return true;
	return false;
}

/** Fraction of the tightest configured ceiling consumed (0..1, capped), or
 *  null when unbudgeted — drives the row's usage meter. */
export function budgetConsumedFraction(
	usage: AiUsageRowView | undefined,
	budget: AiBudgetView | undefined,
): number | null {
	if (!budget || (!budget.maxTokens && !budget.maxCredits)) return null;
	const fractions: number[] = [];
	if (budget.maxTokens) fractions.push((usage?.totalTokens ?? 0) / budget.maxTokens);
	if (budget.maxCredits) {
		fractions.push((usage?.creditsMicro ?? 0) / (budget.maxCredits * CREDIT_MICROS));
	}
	return Math.min(1, Math.max(...fractions));
}
