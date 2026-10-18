/**
 * Agent-14 — apply a vault's AI settings to the live provider registry:
 * (re)register the user's custom OpenAI-compatible endpoints, re-point Ollama
 * at the configured endpoint/model, and pin the routing default. Called on
 * vault open and after every Settings → AI change, so an edit takes effect on
 * the next call without a restart.
 *
 * Egress: every provider registered here talks through the injected transport
 * factory, which production wires to the network broker (`executeNetworkFetch`
 * — SSRF floor, DNS pinning, shared proxy, egress audit). `allowPrivate` is
 * derived from the endpoint URL itself (`checkEndpointUrl`), never stored or
 * caller-supplied, so only a host the user typed as loopback/LAN may reach a
 * private address.
 */

import {
	ANTHROPIC_PROVIDER_ID,
	GEMINI_PROVIDER_ID,
	GLM_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	OLLAMA_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
	SOLHEIM_PROVIDER_ID,
	isCustomProviderId,
} from "@brainstorm-os/sdk-types";
import { OLLAMA_DEFAULT_ENDPOINT, OLLAMA_DEFAULT_MODEL } from "../../shared/ai-endpoints";
import type { AiSettings, CustomAiEndpoint, OllamaSettings } from "../vault/ai-settings-store";
import { checkEndpointUrl } from "./endpoint-url";
import { type OllamaHttp, createOllamaProvider } from "./ollama-provider";
import { type OpenAiHttp, createOpenAiProvider } from "./openai-provider";
import type { ProviderRegistry } from "./provider-registry";

/** Model ids offered as suggestions in the Agent picker. Free-form entry stays
 *  open; these are only the common choices per built-in provider. */
export const BUILTIN_MODEL_SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
	[OLLAMA_PROVIDER_ID]: ["llama3.2", "qwen3", "mistral", "gemma3"],
	[ANTHROPIC_PROVIDER_ID]: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
	[OPENAI_PROVIDER_ID]: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "o3"],
	[GLM_PROVIDER_ID]: ["glm-5.2", "glm-4.5"],
	[MISTRAL_PROVIDER_ID]: ["mistral-large-latest", "mistral-small-latest"],
	[GEMINI_PROVIDER_ID]: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
	[SOLHEIM_PROVIDER_ID]: ["qwen3.6-35b-a3b"],
};

/** Display-info helper for a built-in provider: the default first, then the
 *  catalog suggestions, de-duplicated. */
export function builtinInfo(id: string, label: string, defaultModel: string) {
	const models = [...new Set([defaultModel, ...(BUILTIN_MODEL_SUGGESTIONS[id] ?? [])])];
	return { label, defaultModel, models, custom: false };
}

export type ResolvedOllamaConfig = {
	endpoint: string;
	model: string;
	allowPrivate: boolean;
};

/** Settings → AI wins, then the env, then the built-in default. The env /
 *  built-in endpoint keeps the historical `allowPrivate` (it is the local
 *  model server); a UI-set endpoint gets it only when its host is private. */
export function resolveOllamaConfig(
	settings: OllamaSettings,
	env: { endpoint?: string | undefined; model?: string | undefined },
): ResolvedOllamaConfig {
	const model = settings.model ?? env.model ?? OLLAMA_DEFAULT_MODEL;
	if (settings.endpoint) {
		const check = checkEndpointUrl(settings.endpoint);
		if (check.ok) return { endpoint: check.url, model, allowPrivate: check.privateHost };
	}
	return { endpoint: env.endpoint ?? OLLAMA_DEFAULT_ENDPOINT, model, allowPrivate: true };
}

export type ApplyAiSettingsDeps = {
	registry: ProviderRegistry;
	/** Network-broker transport for an OpenAI-compatible endpoint. */
	openAiHttp: (opts: { allowPrivate: boolean }) => OpenAiHttp;
	/** Network-broker transport for Ollama. */
	ollamaHttp: (opts: { allowPrivate: boolean }) => OllamaHttp;
	/** A custom endpoint's optional key from the credential store. */
	getApiKey: (providerId: string) => Promise<string | null>;
	ollamaEnv: { endpoint?: string | undefined; model?: string | undefined };
	/** The provider routing falls back to when the stored default is unset or
	 *  no longer registered. */
	fallbackProviderId: string;
};

function registerCustomEndpoint(endpoint: CustomAiEndpoint, deps: ApplyAiSettingsDeps): boolean {
	const check = checkEndpointUrl(endpoint.baseUrl);
	if (!check.ok) {
		deps.registry.unregister(endpoint.id);
		return false;
	}
	deps.registry.register(
		createOpenAiProvider({
			id: endpoint.id,
			label: endpoint.name,
			baseUrl: check.url,
			defaultModel: endpoint.defaultModel,
			getApiKey: () => deps.getApiKey(endpoint.id),
			// A public endpoint is a paid/hosted API — never send it a transcript
			// without a key. A LAN/loopback server is often keyless.
			requireApiKey: !check.privateHost,
			http: deps.openAiHttp({ allowPrivate: check.privateHost }),
		}),
		{
			info: {
				label: endpoint.name,
				defaultModel: endpoint.defaultModel,
				models: [endpoint.defaultModel],
				custom: true,
			},
		},
	);
	return true;
}

export function applyAiSettings(settings: AiSettings, deps: ApplyAiSettingsDeps): void {
	const wanted = new Set(settings.customEndpoints.map((e) => e.id));
	for (const id of deps.registry.ids()) {
		if (isCustomProviderId(id) && !wanted.has(id)) deps.registry.unregister(id);
	}
	for (const endpoint of settings.customEndpoints) registerCustomEndpoint(endpoint, deps);

	const ollama = resolveOllamaConfig(settings.ollama, deps.ollamaEnv);
	deps.registry.register(
		createOllamaProvider({
			endpoint: ollama.endpoint,
			defaultModel: ollama.model,
			http: deps.ollamaHttp({ allowPrivate: ollama.allowPrivate }),
		}),
		{ info: builtinInfo(OLLAMA_PROVIDER_ID, "Ollama", ollama.model) },
	);

	const pinned = settings.defaultProvider;
	deps.registry.setDefault(pinned && deps.registry.has(pinned) ? pinned : deps.fallbackProviderId);
}
