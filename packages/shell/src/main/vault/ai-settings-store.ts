/**
 * Per-vault AI routing + budget preferences (11.9 — Settings → AI panel).
 * Stored at `<vaultPath>/shell/ai-settings.json`, the same `shell/` convention
 * `network-settings.json` / `app-lock-settings.json` use. Default-on-first-read:
 * a missing/corrupt file returns (and rewrites) the default. Pure I/O — testable.
 *
 * NON-secret config only — provider *keys* live in the Tier-2 `CredentialStore`
 * (11.6), never here. This holds (1) the **default provider** the broker routes
 * to when a call pins none, and (2) a **per-app budget** map (tokens and/or
 * credits per rolling 30-day window). Since 14.8 the AI broker ENFORCES these
 * budgets before dispatching a call (`main/ai/ai-quota.ts` reads this store;
 * over-budget → the distinct `AiBudgetExhausted` error), metering against the
 * `ai_usage` table in `account.db`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	ANTHROPIC_PROVIDER_ID,
	GEMINI_PROVIDER_ID,
	OLLAMA_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
} from "@brainstorm/sdk-types";

export const AI_SETTINGS_FILENAME = "ai-settings.json";

/** The provider ids the routing picker may select. The wire value IS the id. */
export const ROUTABLE_PROVIDER_IDS: readonly string[] = [
	OLLAMA_PROVIDER_ID,
	ANTHROPIC_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
	GEMINI_PROVIDER_ID,
];

/** A per-app AI budget over the rolling 30-day window (14.8). Either unit may
 *  be set; 0 / absent = no cap on that unit; a budget row with neither is
 *  dropped. `maxCredits` is whole credits (1 credit = 1 USD list price — see
 *  `main/ai/model-rates.ts`). */
export type AppAiBudget = {
	maxTokens?: number;
	maxCredits?: number;
};

export type AiSettings = {
	/** The provider the broker routes to when a request pins none. `null` keeps
	 *  the built-in default (local Ollama). */
	defaultProvider: string | null;
	/** Per-app token budgets, keyed by app id. Absent = unbudgeted. */
	appBudgets: Record<string, AppAiBudget>;
};

/** Hard ceilings so a hand-edited / stale-renderer value can't install a
 *  nonsense budget (also bounds the number the UI must render). */
export const MAX_APP_TOKEN_BUDGET = 100_000_000;
export const MAX_APP_CREDIT_BUDGET = 1_000_000;

export function defaultAiSettings(): AiSettings {
	return { defaultProvider: null, appBudgets: {} };
}

function positiveCapped(value: unknown, cap: number): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return Math.min(Math.floor(value), cap);
}

function validateBudget(value: unknown): AppAiBudget | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as { maxTokens?: unknown; maxCredits?: unknown };
	const maxTokens = positiveCapped(raw.maxTokens, MAX_APP_TOKEN_BUDGET);
	const maxCredits = positiveCapped(raw.maxCredits, MAX_APP_CREDIT_BUDGET);
	if (maxTokens === null && maxCredits === null) return null;
	return {
		...(maxTokens !== null ? { maxTokens } : {}),
		...(maxCredits !== null ? { maxCredits } : {}),
	};
}

export function validateAiSettings(value: unknown): AiSettings {
	const out = defaultAiSettings();
	if (!value || typeof value !== "object") return out;
	const raw = value as { defaultProvider?: unknown; appBudgets?: unknown };
	if (
		typeof raw.defaultProvider === "string" &&
		ROUTABLE_PROVIDER_IDS.includes(raw.defaultProvider)
	) {
		out.defaultProvider = raw.defaultProvider;
	}
	if (raw.appBudgets && typeof raw.appBudgets === "object" && !Array.isArray(raw.appBudgets)) {
		for (const [appId, budget] of Object.entries(raw.appBudgets as Record<string, unknown>)) {
			if (appId.length === 0) continue;
			const valid = validateBudget(budget);
			if (valid) out.appBudgets[appId] = valid;
		}
	}
	return out;
}

export function aiSettingsPath(vaultPath: string): string {
	return join(vaultPath, "shell", AI_SETTINGS_FILENAME);
}

export async function readAiSettings(vaultPath: string): Promise<AiSettings> {
	try {
		const raw = await readFile(aiSettingsPath(vaultPath), "utf8");
		return validateAiSettings(JSON.parse(raw));
	} catch {
		const fallback = defaultAiSettings();
		await writeAiSettings(vaultPath, fallback).catch(() => {});
		return fallback;
	}
}

export async function writeAiSettings(vaultPath: string, settings: AiSettings): Promise<void> {
	const path = aiSettingsPath(vaultPath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(validateAiSettings(settings), null, 2), "utf8");
}

/** Set the default provider (`null` clears to the built-in default). Returns the
 *  updated settings. Ignores an unroutable id (defensive). */
export async function setDefaultProvider(
	vaultPath: string,
	providerId: string | null,
): Promise<AiSettings> {
	const next = await readAiSettings(vaultPath);
	next.defaultProvider =
		providerId !== null && ROUTABLE_PROVIDER_IDS.includes(providerId) ? providerId : null;
	await writeAiSettings(vaultPath, next);
	return next;
}

/** Set or clear one app's budget: a budget with at least one positive unit is
 *  stored (values floored + capped); an empty/invalid budget clears the row. */
export async function setAppBudget(
	vaultPath: string,
	appId: string,
	budget: AppAiBudget,
): Promise<AiSettings> {
	const next = await readAiSettings(vaultPath);
	if (appId.length === 0) return next;
	const valid = validateBudget(budget);
	if (valid) {
		next.appBudgets[appId] = valid;
	} else {
		delete next.appBudgets[appId];
	}
	await writeAiSettings(vaultPath, next);
	return next;
}
