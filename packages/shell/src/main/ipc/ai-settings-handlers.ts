/**
 * AI settings privileged IPC (11.9 — Settings → AI panel).
 *
 * The dashboard (privileged renderer, not a sandboxed app) manages BYO cloud
 * provider API keys here via direct ipcMain — NOT the broker. The raw key is
 * write-only across this boundary: `set` accepts a key and seals it into the
 * active vault's Tier-2 `CredentialStore` (11.6); `has` returns only a boolean;
 * `clear` deletes it. The key is **never returned** to any renderer, and only a
 * curated set of provider ids may be addressed (so the dashboard can't write
 * arbitrary credential entries under the AI namespace).
 *
 * Agent-14 — custom OpenAI-compatible endpoints and the Ollama override are
 * managed here too. A custom endpoint's key rides the same write-only
 * channels, addressable only while the endpoint exists in the vault's
 * settings; removing an endpoint deletes its key. Every change is re-applied
 * to the live provider registry through `applySettings`.
 */

import {
	ANTHROPIC_PROVIDER_ID,
	GEMINI_PROVIDER_ID,
	GLM_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
	SOLHEIM_PROVIDER_ID,
	isCustomProviderId,
} from "@brainstorm-os/sdk-types";
import { ipcMain } from "electron";
import { AI_BUDGET_WINDOW_MS } from "../ai/ai-quota";
import type { AiAppUsageSummary } from "../ai/ai-usage-repo";
import {
	deleteAiProviderKey,
	readAiProviderKey,
	writeAiProviderKey,
} from "../credentials/ai-provider-keys";
import type { CredentialStore } from "../credentials/store";
import {
	type AiSettings,
	type AppAiBudget,
	type CustomEndpointResult,
	type OllamaSettingsResult,
	defaultAiSettings,
	readAiSettings,
	removeCustomEndpoint,
	setAppBudget,
	setDefaultProvider,
	setOllamaSettings,
	upsertCustomEndpoint,
} from "../vault/ai-settings-store";
import { getActiveVaultSession } from "../vault/session";

export const AI_HAS_PROVIDER_KEY_CHANNEL = "ai-settings:has-provider-key" as const;
export const AI_SET_PROVIDER_KEY_CHANNEL = "ai-settings:set-provider-key" as const;
export const AI_CLEAR_PROVIDER_KEY_CHANNEL = "ai-settings:clear-provider-key" as const;
export const AI_USAGE_CHANNEL = "ai-settings:usage" as const;
export const AI_GET_SETTINGS_CHANNEL = "ai-settings:get-settings" as const;
export const AI_SET_DEFAULT_PROVIDER_CHANNEL = "ai-settings:set-default-provider" as const;
export const AI_SET_APP_BUDGET_CHANNEL = "ai-settings:set-app-budget" as const;
export const AI_UPSERT_ENDPOINT_CHANNEL = "ai-settings:upsert-endpoint" as const;
export const AI_REMOVE_ENDPOINT_CHANNEL = "ai-settings:remove-endpoint" as const;
export const AI_SET_OLLAMA_CHANNEL = "ai-settings:set-ollama" as const;

/** What the Settings → AI usage list renders (14.8): per-app rolling-window
 *  aggregates from the `ai_usage` accounting table — metadata only. */
export type AiUsageView = {
	/** The rolling window the aggregates cover (30 days). */
	readonly windowMs: number;
	readonly apps: readonly AiAppUsageSummary[];
};

export type AiSettingsHandlerDeps = {
	/** Apply changed settings (routing default, custom endpoints, Ollama) to the
	 *  live provider registry so they take effect without a vault re-open.
	 *  Optional — omitted in tests that only assert persistence. */
	readonly applySettings?: (settings: AiSettings) => void;
};

/** The cloud providers whose keys this surface may manage. Bounds the
 *  credential namespace the dashboard can write. */
const KNOWN_CLOUD_PROVIDER_IDS: ReadonlySet<string> = new Set([
	ANTHROPIC_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
	GLM_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	GEMINI_PROVIDER_ID,
	SOLHEIM_PROVIDER_ID,
]);

/** The active vault's credential store, but only for a recognised provider id:
 *  a built-in cloud provider, or a custom endpoint that exists right now. */
async function storeFor(
	providerId: unknown,
): Promise<{ store: CredentialStore; id: string } | null> {
	if (typeof providerId !== "string") return null;
	const session = getActiveVaultSession();
	if (!session) return null;
	if (KNOWN_CLOUD_PROVIDER_IDS.has(providerId))
		return { store: session.credentials, id: providerId };
	if (!isCustomProviderId(providerId)) return null;
	const settings = await readAiSettings(session.vaultPath);
	return settings.customEndpoints.some((e) => e.id === providerId)
		? { store: session.credentials, id: providerId }
		: null;
}

export function registerAiSettingsHandlers(deps: AiSettingsHandlerDeps): void {
	ipcMain.handle(AI_USAGE_CHANNEL, async (): Promise<AiUsageView> => {
		// 14.8 — per-app rolling-window aggregates from the active vault's
		// `ai_usage` accounting table (metadata only; per-call rows never cross
		// IPC). No open vault → an empty window.
		const session = getActiveVaultSession();
		if (!session) return { windowMs: AI_BUDGET_WINDOW_MS, apps: [] };
		const repo = await session.aiUsageRepo();
		return {
			windowMs: AI_BUDGET_WINDOW_MS,
			apps: repo.summarizeByApp(Date.now() - AI_BUDGET_WINDOW_MS),
		};
	});

	ipcMain.handle(
		AI_HAS_PROVIDER_KEY_CHANNEL,
		async (_event, providerId: unknown): Promise<boolean> => {
			const target = await storeFor(providerId);
			return target ? (await readAiProviderKey(target.store, target.id)) !== null : false;
		},
	);

	ipcMain.handle(
		AI_SET_PROVIDER_KEY_CHANNEL,
		async (_event, providerId: unknown, key: unknown): Promise<boolean> => {
			const target = await storeFor(providerId);
			if (!target || typeof key !== "string" || key.trim().length === 0) return false;
			await writeAiProviderKey(target.store, target.id, key.trim());
			return true;
		},
	);

	ipcMain.handle(
		AI_CLEAR_PROVIDER_KEY_CHANNEL,
		async (_event, providerId: unknown): Promise<boolean> => {
			const target = await storeFor(providerId);
			return target ? deleteAiProviderKey(target.store, target.id) : false;
		},
	);

	// 11.9 routing + per-app budgets. Non-secret per-vault config (the keys stay
	// in the credential store). `null` vaultPath → no active session: return the
	// defaults, persist nothing.
	ipcMain.handle(AI_GET_SETTINGS_CHANNEL, async (): Promise<AiSettings> => {
		const vaultPath = getActiveVaultSession()?.vaultPath ?? null;
		if (!vaultPath) return defaultAiSettings();
		return readAiSettings(vaultPath);
	});

	ipcMain.handle(
		AI_SET_DEFAULT_PROVIDER_CHANNEL,
		async (_event, providerId: unknown): Promise<AiSettings | null> => {
			const vaultPath = getActiveVaultSession()?.vaultPath ?? null;
			if (!vaultPath) return null;
			const id = typeof providerId === "string" ? providerId : null;
			const next = await setDefaultProvider(vaultPath, id);
			// Reflect the (validated) stored value into the live registry so the
			// next AI call routes there immediately.
			deps.applySettings?.(next);
			return next;
		},
	);

	ipcMain.handle(
		AI_UPSERT_ENDPOINT_CHANNEL,
		async (_event, input: unknown): Promise<CustomEndpointResult | null> => {
			const vaultPath = getActiveVaultSession()?.vaultPath ?? null;
			if (!vaultPath) return null;
			const result = await upsertCustomEndpoint(vaultPath, input);
			if (result.ok) deps.applySettings?.(result.settings);
			return result;
		},
	);

	ipcMain.handle(
		AI_REMOVE_ENDPOINT_CHANNEL,
		async (_event, id: unknown): Promise<AiSettings | null> => {
			const session = getActiveVaultSession();
			if (!session || typeof id !== "string" || !isCustomProviderId(id)) return null;
			const next = await removeCustomEndpoint(session.vaultPath, id);
			if (!next) return null;
			await deleteAiProviderKey(session.credentials, id);
			deps.applySettings?.(next);
			return next;
		},
	);

	ipcMain.handle(
		AI_SET_OLLAMA_CHANNEL,
		async (_event, input: unknown): Promise<OllamaSettingsResult | null> => {
			const vaultPath = getActiveVaultSession()?.vaultPath ?? null;
			if (!vaultPath || !input || typeof input !== "object") return null;
			const result = await setOllamaSettings(vaultPath, input as Record<string, unknown>);
			if (result.ok) deps.applySettings?.(result.settings);
			return result;
		},
	);

	ipcMain.handle(
		AI_SET_APP_BUDGET_CHANNEL,
		async (_event, appId: unknown, budget: unknown): Promise<AiSettings | null> => {
			const vaultPath = getActiveVaultSession()?.vaultPath ?? null;
			if (!vaultPath || typeof appId !== "string" || appId.length === 0) return null;
			return setAppBudget(vaultPath, appId, coerceBudget(budget));
		},
	);
}

/** Accept the 14.8 `{maxTokens?, maxCredits?}` shape and the legacy bare
 *  number (a stale pre-14.8 renderer); anything else clears the budget
 *  (the store drops budgets with no positive unit). */
function coerceBudget(value: unknown): AppAiBudget {
	if (typeof value === "number") return { maxTokens: value };
	if (value && typeof value === "object") {
		const raw = value as { maxTokens?: unknown; maxCredits?: unknown };
		return {
			...(typeof raw.maxTokens === "number" ? { maxTokens: raw.maxTokens } : {}),
			...(typeof raw.maxCredits === "number" ? { maxCredits: raw.maxCredits } : {}),
		};
	}
	return {};
}
