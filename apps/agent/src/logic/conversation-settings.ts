/**
 * Agent-5 — per-conversation tool grants, model, and budget. Pure helpers (no
 * React, no SDK runtime) for the three things a conversation can scope:
 *
 * 1. **Tool grants** — the capability subset granted for THIS conversation. The
 *    three-tier ceiling (`effectiveAgentCapabilities` in `agent-tools.ts`) is the
 *    single chokepoint: a grant is only ever effective if the app also holds it,
 *    so these helpers only ever NARROW. They never call the ledger and never
 *    broaden — they just compute the candidate grant set the UI toggles and the
 *    merged set after a user-approved escalation.
 *
 * 2. **Model** — the provider/model the conversation pins. The picker offers only
 *    the providers the app's `ai.provider:<id>` caps allow (so a conversation can
 *    never route to a provider the app lacks); the chokepoint stays the broker's
 *    `aiCapabilitiesForRequest` re-check server-side.
 *
 * 3. **Budget** — a per-conversation prompt-token budget. {@link budgetCheck}
 *    decides — fail-closed — whether a turn whose estimated prompt size would push
 *    cumulative spend past the budget may run. The accounting is deterministic and
 *    unit-tested; the enforcement (refuse the turn) lives in `app.tsx`.
 *
 * Everything here is pure + deterministic so the grant-narrowing, escalation
 * merge, and budget arithmetic are unit-testable without a model or a vault.
 */

import {
	type AiChatMessage,
	OLLAMA_PROVIDER_ID,
	capabilityImplies,
	estimateTokens,
} from "@brainstorm-os/sdk-types";

// ─── Tool grants ─────────────────────────────────────────────────────────────

/** The capability prefixes that are TOGGLEABLE per conversation — the ones that
 *  map to an action the agent loop can take on the user's behalf (intent
 *  dispatch). Infrastructure caps (`ai.*`, `storage.*`, `search.*`,
 *  `entities.*`) are NOT user-toggleable: they're the substrate the chat itself
 *  runs on, not a discretionary "tool", and revoking them would just break the
 *  app rather than narrow what the model can DO. So the grants UI scopes exactly
 *  the `intents.dispatch:*` surface. */
const TOGGLEABLE_GRANT_PREFIX = "intents.dispatch:";

/** Is this capability a per-conversation-toggleable tool grant (an intent the
 *  agent loop can dispatch)? */
export function isToggleableGrant(cap: string): boolean {
	return cap.startsWith(TOGGLEABLE_GRANT_PREFIX);
}

/** The app caps that are NOT toggleable — always carried in a conversation's
 *  grant set so narrowing the tool surface never breaks chat itself
 *  (`ai.use` et al. must always survive). */
export function nonToggleableAppCaps(appCaps: readonly string[]): string[] {
	return appCaps.filter((cap) => !isToggleableGrant(cap));
}

/** The toggleable tool caps the app holds — the rows the grants UI renders.
 *  Sorted + de-duplicated for a stable, testable order. */
export function toggleableAppCaps(appCaps: readonly string[]): string[] {
	return [...new Set(appCaps.filter(isToggleableGrant))].sort();
}

/**
 * The full default grant set for a conversation: every app cap (no narrowing).
 * Behaviour is identical to Agent-3's `defaultConversationGrants` until the user
 * narrows — kept here so the model + budget seam has one settings module.
 */
export function defaultGrants(appCaps: readonly string[]): string[] {
	return [...appCaps];
}

/**
 * Compose a conversation's grant set from the user-chosen TOGGLEABLE subset plus
 * the always-on non-toggleable app caps. SECURITY: the result is filtered to
 * caps the app actually holds (drop anything not implied by an app cap), so a
 * stale / tampered stored grant can never reach the loop with a cap the app
 * lacks — the three-tier intersection enforces this too, but we narrow here
 * as well (defence in depth). Sorted for determinism.
 */
export function composeGrants(
	appCaps: readonly string[],
	enabledToggleable: readonly string[],
): string[] {
	const held = (cap: string): boolean => appCaps.some((a) => capabilityImplies(a, cap));
	const grants = new Set<string>(nonToggleableAppCaps(appCaps));
	for (const cap of enabledToggleable) {
		if (isToggleableGrant(cap) && held(cap)) grants.add(cap);
	}
	return [...grants].sort();
}

/** The toggleable caps a stored grant set currently ENABLES (the UI's checked
 *  rows) — the stored grants intersected with the app's toggleable surface. */
export function enabledToggleableGrants(
	appCaps: readonly string[],
	grants: readonly string[],
): string[] {
	const enabled = new Set(grants.filter(isToggleableGrant));
	return toggleableAppCaps(appCaps).filter((cap) => enabled.has(cap));
}

/**
 * The escalation merge: add one user-approved capability to a conversation's
 * grants. SECURITY KEYSTONE for inline escalation — the cap is added ONLY when
 * the app actually holds it (`capabilityImplies` against an app cap); a request
 * to grant something outside the app's manifest is a no-op (returns the grants
 * unchanged). This is the explicit-consent path: the caller invokes it only
 * from a user action, never automatically. Idempotent + sorted.
 */
export function grantCapability(
	appCaps: readonly string[],
	grants: readonly string[],
	cap: string,
): string[] {
	const held = appCaps.some((a) => capabilityImplies(a, cap));
	if (!held) return [...grants].sort();
	return [...new Set([...grants, cap])].sort();
}

/** Does the conversation's grant set already cover this capability? Used to
 *  decide whether an escalation prompt is even actionable (no prompt for a cap
 *  the conversation already has, or one the app doesn't hold). */
export function grantsCover(grants: readonly string[], cap: string): boolean {
	return grants.some((g) => capabilityImplies(g, cap));
}

// ─── Model / provider ────────────────────────────────────────────────────────

/** The intent verb a toggleable `intents.dispatch:<verb>` grant dispatches —
 *  the human-facing tool name shown in the grants UI is keyed off this. */
export function grantVerb(cap: string): string {
	return cap.startsWith(TOGGLEABLE_GRANT_PREFIX) ? cap.slice(TOGGLEABLE_GRANT_PREFIX.length) : cap;
}

/** The `ai.provider:<id>` capability prefix. */
const PROVIDER_CAP_PREFIX = "ai.provider:";

/** The sentinel "let the shell route to its configured default" model value —
 *  no provider pinned on the request. Never a real provider id. */
export const AUTO_PROVIDER = "auto";

/** Extract the provider ids the app is granted, from its `ai.provider:<id>`
 *  caps. The model picker offers exactly these (plus the AUTO sentinel), so a
 *  conversation can never pin a provider the app lacks. Sorted, with the
 *  built-in local model first when present (the zero-config default). */
export function grantedProviderIds(appCaps: readonly string[]): string[] {
	const ids = new Set<string>();
	for (const cap of appCaps) {
		if (cap.startsWith(PROVIDER_CAP_PREFIX)) {
			const id = cap.slice(PROVIDER_CAP_PREFIX.length);
			if (id && id !== "*") ids.add(id);
		}
	}
	const sorted = [...ids].sort();
	if (sorted.includes(OLLAMA_PROVIDER_ID)) {
		return [OLLAMA_PROVIDER_ID, ...sorted.filter((id) => id !== OLLAMA_PROVIDER_ID)];
	}
	return sorted;
}

/** Resolve a conversation's stored provider to the value the picker shows: the
 *  stored provider if the app still holds it, else AUTO (a stored provider the
 *  app no longer has caps for can't be used — fail safe to shell routing). */
export function resolveProvider(
	appCaps: readonly string[],
	storedProvider: string | undefined,
): string {
	if (!storedProvider) return AUTO_PROVIDER;
	return grantedProviderIds(appCaps).includes(storedProvider) ? storedProvider : AUTO_PROVIDER;
}

/** Build the `ai.generate`/loop request provider override from the resolved
 *  picker value: a real provider id, or `undefined` for AUTO (shell routes). */
export function providerForRequest(resolved: string): string | undefined {
	return resolved === AUTO_PROVIDER ? undefined : resolved;
}

// ─── Budget ──────────────────────────────────────────────────────────────────

/** Why a turn's budget check resolved as it did. */
export enum BudgetVerdict {
	/** No budget set, or the turn fits — run it. */
	Ok = "ok",
	/** The turn would push cumulative spend past the budget — refuse it. */
	Exceeds = "exceeds",
}

export type BudgetState = {
	verdict: BudgetVerdict;
	/** This turn's estimated prompt tokens (the increment). */
	turnTokens: number;
	/** Cumulative tokens AFTER this turn (spent so far + this turn). */
	projectedTotal: number;
	/** The budget ceiling, when one is set (`undefined` = unbounded). */
	budget?: number;
	/** Tokens remaining under the budget BEFORE this turn (clamped ≥ 0). */
	remainingBefore?: number;
};

/** Estimate a turn's prompt size from the messages that would be sent — the
 *  same rough estimator the broker's `ai.cost` uses ({@link estimateTokens}). */
export function estimateTurnTokens(messages: readonly AiChatMessage[]): number {
	return estimateTokens(messages);
}

/**
 * The fail-closed budget check. Given the conversation's budget + tokens spent
 * so far + this turn's estimated prompt tokens, decide whether the turn may run:
 *  - no budget (`undefined` / non-finite / ≤ 0) → always {@link BudgetVerdict.Ok}
 *    (unbounded);
 *  - a budget set → {@link BudgetVerdict.Exceeds} when `spent + turn > budget`,
 *    else `Ok`. The comparison is STRICTLY greater, so a turn that lands exactly
 *    on the ceiling is allowed; the next turn over it is refused.
 *
 * Pure + deterministic — the enforcement (refuse + warn) is the caller's.
 */
export function budgetCheck(
	budget: number | undefined,
	tokensSpent: number,
	turnTokens: number,
): BudgetState {
	const spent = Number.isFinite(tokensSpent) && tokensSpent > 0 ? tokensSpent : 0;
	const turn = Number.isFinite(turnTokens) && turnTokens > 0 ? turnTokens : 0;
	const projectedTotal = spent + turn;
	if (budget === undefined || !Number.isFinite(budget) || budget <= 0) {
		return { verdict: BudgetVerdict.Ok, turnTokens: turn, projectedTotal };
	}
	const remainingBefore = Math.max(0, budget - spent);
	const verdict = projectedTotal > budget ? BudgetVerdict.Exceeds : BudgetVerdict.Ok;
	return { verdict, turnTokens: turn, projectedTotal, budget, remainingBefore };
}

/** Add a turn's spend to the running total — the new `tokensSpent` to persist on
 *  the conversation after a turn completes. Clamps both inputs to non-negative
 *  finite values so a bad persisted total can't corrupt the accumulator. */
export function accrueSpend(tokensSpent: number, turnTokens: number): number {
	const spent = Number.isFinite(tokensSpent) && tokensSpent > 0 ? tokensSpent : 0;
	const turn = Number.isFinite(turnTokens) && turnTokens > 0 ? turnTokens : 0;
	return spent + turn;
}
