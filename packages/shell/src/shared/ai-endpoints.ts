/**
 * Agent-14 — the wire vocabulary of Settings → AI custom endpoints, shared by
 * the main-process store/handlers and the dashboard panel. Pure (no Node, no
 * DOM), so the renderer can import the enums it switches on.
 */

/** Why `checkEndpointUrl` refused a base URL. */
export enum EndpointUrlError {
	Malformed = "malformed",
	Scheme = "scheme",
	Credentials = "credentials",
	QueryOrFragment = "query-or-fragment",
	InsecurePublic = "insecure-public",
	BlockedPort = "blocked-port",
	TooLong = "too-long",
}

/** Which form a custom endpoint was created from. A preset only seeds the
 *  base URL; the stored record is the same shape either way. */
export enum CustomEndpointPreset {
	Generic = "generic",
	OpenRouter = "openrouter",
}

/** Ollama's built-in default, used when neither Settings → AI nor the env
 *  (`BRAINSTORM_OLLAMA_ENDPOINT` / `BRAINSTORM_OLLAMA_MODEL`) sets one. */
export const OLLAMA_DEFAULT_ENDPOINT = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "llama3.2";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const PRESET_BASE_URL: Readonly<Record<CustomEndpointPreset, string | null>> = {
	[CustomEndpointPreset.Generic]: null,
	[CustomEndpointPreset.OpenRouter]: OPENROUTER_BASE_URL,
};

export enum CustomEndpointError {
	InvalidName = "invalid-name",
	InvalidUrl = "invalid-url",
	InvalidModel = "invalid-model",
	TooMany = "too-many",
	NotFound = "not-found",
}

export enum OllamaSettingsError {
	InvalidUrl = "invalid-url",
	InvalidModel = "invalid-model",
}
