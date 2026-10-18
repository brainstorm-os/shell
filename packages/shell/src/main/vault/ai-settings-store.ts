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
 *
 * Agent-14 adds (3) user-added **custom OpenAI-compatible endpoints** (name,
 * base URL, default model — the optional API key is a credential-store entry
 * keyed by the endpoint id, never stored here) and (4) the **Ollama endpoint +
 * model** override. Every endpoint is re-validated on read, so a hand-edited
 * file cannot install a URL the panel would have refused.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	ANTHROPIC_PROVIDER_ID,
	CUSTOM_PROVIDER_ID_PREFIX,
	GEMINI_PROVIDER_ID,
	GLM_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	OLLAMA_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
	SOLHEIM_PROVIDER_ID,
	containsControlChars,
	isCustomProviderId,
	isValidModelId,
} from "@brainstorm-os/sdk-types";
import {
	CustomEndpointError,
	CustomEndpointPreset,
	type EndpointUrlError,
	OllamaSettingsError,
} from "../../shared/ai-endpoints";
import { checkEndpointUrl } from "../ai/endpoint-url";

export const AI_SETTINGS_FILENAME = "ai-settings.json";

/** The built-in provider ids the routing picker may select (every one is
 *  registered in `main/index.ts`). Custom endpoints are routable too, by their
 *  stored id — see {@link isRoutableProviderId}. The wire value IS the id. */
export const ROUTABLE_PROVIDER_IDS: readonly string[] = [
	OLLAMA_PROVIDER_ID,
	ANTHROPIC_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
	GLM_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	GEMINI_PROVIDER_ID,
	SOLHEIM_PROVIDER_ID,
];

/** A user-added OpenAI-compatible endpoint. `id` is shell-minted
 *  (`custom-<hex>`) and stable across edits — it keys the registry entry, the
 *  credential-store key, and the `ai.provider:<id>` cap scope. */
export type CustomAiEndpoint = {
	id: string;
	name: string;
	baseUrl: string;
	defaultModel: string;
	preset: CustomEndpointPreset;
};

/** The Ollama override. `null` = fall back to `BRAINSTORM_OLLAMA_ENDPOINT` /
 *  `BRAINSTORM_OLLAMA_MODEL`, then the built-in default. */
export type OllamaSettings = {
	endpoint: string | null;
	model: string | null;
};

export const MAX_CUSTOM_ENDPOINTS = 16;
export const MAX_ENDPOINT_NAME_LENGTH = 64;

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
	customEndpoints: CustomAiEndpoint[];
	ollama: OllamaSettings;
};

/** Hard ceilings so a hand-edited / stale-renderer value can't install a
 *  nonsense budget (also bounds the number the UI must render). */
export const MAX_APP_TOKEN_BUDGET = 100_000_000;
export const MAX_APP_CREDIT_BUDGET = 1_000_000;

export function defaultAiSettings(): AiSettings {
	return {
		defaultProvider: null,
		appBudgets: {},
		customEndpoints: [],
		ollama: { endpoint: null, model: null },
	};
}

function validName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.trim();
	if (name.length === 0 || name.length > MAX_ENDPOINT_NAME_LENGTH || containsControlChars(name)) {
		return null;
	}
	return name;
}

function validPreset(value: unknown): CustomEndpointPreset {
	return Object.values(CustomEndpointPreset).includes(value as CustomEndpointPreset)
		? (value as CustomEndpointPreset)
		: CustomEndpointPreset.Generic;
}

const CUSTOM_ID_RE = /^custom-[0-9a-f]{8,32}$/;

function validateEndpoint(value: unknown): CustomAiEndpoint | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || !CUSTOM_ID_RE.test(raw.id)) return null;
	const name = validName(raw.name);
	const url = checkEndpointUrl(raw.baseUrl);
	if (!name || !url.ok || !isValidModelId(raw.defaultModel)) return null;
	return {
		id: raw.id,
		name,
		baseUrl: url.url,
		defaultModel: raw.defaultModel,
		preset: validPreset(raw.preset),
	};
}

function validateOllama(value: unknown): OllamaSettings {
	const out: OllamaSettings = { endpoint: null, model: null };
	if (!value || typeof value !== "object") return out;
	const raw = value as { endpoint?: unknown; model?: unknown };
	if (raw.endpoint !== null && raw.endpoint !== undefined) {
		const url = checkEndpointUrl(raw.endpoint);
		if (url.ok) out.endpoint = url.url;
	}
	if (isValidModelId(raw.model)) out.model = raw.model;
	return out;
}

/** A provider id the routing default may name: a built-in, or a custom
 *  endpoint that exists in these settings. */
export function isRoutableProviderId(
	id: string,
	settings: Pick<AiSettings, "customEndpoints">,
): boolean {
	if (ROUTABLE_PROVIDER_IDS.includes(id)) return true;
	return isCustomProviderId(id) && settings.customEndpoints.some((e) => e.id === id);
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
	const raw = value as {
		defaultProvider?: unknown;
		appBudgets?: unknown;
		customEndpoints?: unknown;
		ollama?: unknown;
	};
	if (Array.isArray(raw.customEndpoints)) {
		const seen = new Set<string>();
		for (const entry of raw.customEndpoints) {
			if (out.customEndpoints.length >= MAX_CUSTOM_ENDPOINTS) break;
			const valid = validateEndpoint(entry);
			if (!valid || seen.has(valid.id)) continue;
			seen.add(valid.id);
			out.customEndpoints.push(valid);
		}
	}
	out.ollama = validateOllama(raw.ollama);
	if (typeof raw.defaultProvider === "string" && isRoutableProviderId(raw.defaultProvider, out)) {
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
		providerId !== null && isRoutableProviderId(providerId, next) ? providerId : null;
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

export type CustomEndpointInput = {
	/** Absent = add a new endpoint; present = edit that one. */
	id?: string;
	name: string;
	baseUrl: string;
	defaultModel: string;
	preset?: CustomEndpointPreset;
};

export type CustomEndpointResult =
	| { ok: true; settings: AiSettings; endpoint: CustomAiEndpoint }
	| { ok: false; error: CustomEndpointError; urlError?: EndpointUrlError };

function mintCustomId(): string {
	return `${CUSTOM_PROVIDER_ID_PREFIX}${randomBytes(6).toString("hex")}`;
}

/** Pure validation of an add/edit request against the current settings. */
export function applyCustomEndpoint(
	current: AiSettings,
	input: unknown,
	mintId: () => string = mintCustomId,
): CustomEndpointResult {
	if (!input || typeof input !== "object")
		return { ok: false, error: CustomEndpointError.InvalidName };
	const raw = input as Record<string, unknown>;
	const name = validName(raw.name);
	if (!name) return { ok: false, error: CustomEndpointError.InvalidName };
	const url = checkEndpointUrl(raw.baseUrl);
	if (!url.ok) return { ok: false, error: CustomEndpointError.InvalidUrl, urlError: url.error };
	const model = typeof raw.defaultModel === "string" ? raw.defaultModel.trim() : raw.defaultModel;
	if (!isValidModelId(model)) return { ok: false, error: CustomEndpointError.InvalidModel };
	const preset = validPreset(raw.preset);

	const next: AiSettings = {
		...current,
		customEndpoints: [...current.customEndpoints],
	};
	if (raw.id !== undefined) {
		const index = next.customEndpoints.findIndex((e) => e.id === raw.id);
		const existing = next.customEndpoints[index];
		if (!existing) return { ok: false, error: CustomEndpointError.NotFound };
		const endpoint = { id: existing.id, name, baseUrl: url.url, defaultModel: model, preset };
		next.customEndpoints[index] = endpoint;
		return { ok: true, settings: next, endpoint };
	}
	if (next.customEndpoints.length >= MAX_CUSTOM_ENDPOINTS) {
		return { ok: false, error: CustomEndpointError.TooMany };
	}
	const endpoint = { id: mintId(), name, baseUrl: url.url, defaultModel: model, preset };
	next.customEndpoints.push(endpoint);
	return { ok: true, settings: next, endpoint };
}

export async function upsertCustomEndpoint(
	vaultPath: string,
	input: unknown,
): Promise<CustomEndpointResult> {
	const result = applyCustomEndpoint(await readAiSettings(vaultPath), input);
	if (result.ok) await writeAiSettings(vaultPath, result.settings);
	return result;
}

/** Remove an endpoint; a routing default pointing at it falls back to the
 *  built-in default. Returns `null` when the id is unknown. */
export async function removeCustomEndpoint(
	vaultPath: string,
	id: string,
): Promise<AiSettings | null> {
	const next = await readAiSettings(vaultPath);
	const kept = next.customEndpoints.filter((e) => e.id !== id);
	if (kept.length === next.customEndpoints.length) return null;
	next.customEndpoints = kept;
	if (next.defaultProvider === id) next.defaultProvider = null;
	await writeAiSettings(vaultPath, next);
	return next;
}

export type OllamaSettingsResult =
	| { ok: true; settings: AiSettings }
	| { ok: false; error: OllamaSettingsError; urlError?: EndpointUrlError };

/** Set the Ollama override. An empty / null field clears that half back to
 *  the env-or-built-in default. */
export async function setOllamaSettings(
	vaultPath: string,
	input: { endpoint?: unknown; model?: unknown },
): Promise<OllamaSettingsResult> {
	const ollama: OllamaSettings = { endpoint: null, model: null };
	const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : null;
	if (endpoint) {
		const url = checkEndpointUrl(endpoint);
		if (!url.ok) return { ok: false, error: OllamaSettingsError.InvalidUrl, urlError: url.error };
		ollama.endpoint = url.url;
	}
	const model = typeof input.model === "string" ? input.model.trim() : null;
	if (model) {
		if (!isValidModelId(model)) return { ok: false, error: OllamaSettingsError.InvalidModel };
		ollama.model = model;
	}
	const next = await readAiSettings(vaultPath);
	next.ollama = ollama;
	await writeAiSettings(vaultPath, next);
	return { ok: true, settings: next };
}
