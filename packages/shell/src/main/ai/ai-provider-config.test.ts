import { MessageRole, OLLAMA_PROVIDER_ID } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { CustomEndpointPreset, OLLAMA_DEFAULT_ENDPOINT } from "../../shared/ai-endpoints";
import {
	type AiSettings,
	type CustomAiEndpoint,
	defaultAiSettings,
} from "../vault/ai-settings-store";
import {
	type ApplyAiSettingsDeps,
	applyAiSettings,
	builtinInfo,
	resolveOllamaConfig,
} from "./ai-provider-config";
import { ProviderRegistry } from "./provider-registry";

const OK = JSON.stringify({ choices: [{ message: { content: "hi" } }], model: "m" });
const OLLAMA_OK = JSON.stringify({ message: { content: "hi" } });

function endpoint(over: Partial<CustomAiEndpoint> = {}): CustomAiEndpoint {
	return {
		id: "custom-0000000a",
		name: "Box",
		baseUrl: "http://192.168.1.20:1234/v1",
		defaultModel: "qwen3",
		preset: CustomEndpointPreset.Generic,
		...over,
	};
}

function setup(keys: Record<string, string> = {}) {
	const registry = new ProviderRegistry();
	const transports: Array<{ kind: string; allowPrivate: boolean; url?: string; headers?: unknown }> =
		[];
	const deps: ApplyAiSettingsDeps = {
		registry,
		openAiHttp: ({ allowPrivate }) =>
			vi.fn(async ({ url, headers }) => {
				transports.push({ kind: "openai", allowPrivate, url, headers });
				return { status: 200, text: OK };
			}),
		ollamaHttp: ({ allowPrivate }) =>
			vi.fn(async ({ url }) => {
				transports.push({ kind: "ollama", allowPrivate, url });
				return { status: 200, text: OLLAMA_OK };
			}),
		getApiKey: async (id) => keys[id] ?? null,
		ollamaEnv: {},
		fallbackProviderId: OLLAMA_PROVIDER_ID,
	};
	return { registry, deps, transports };
}

const settingsWith = (over: Partial<AiSettings>): AiSettings => ({
	...defaultAiSettings(),
	...over,
});
const msg = [{ role: MessageRole.User, content: "Hi" }];

describe("applyAiSettings", () => {
	it("registers each custom endpoint, and unregisters it when removed from settings", () => {
		const { registry, deps } = setup();
		const a = endpoint();
		const b = endpoint({
			id: "custom-0000000b",
			name: "Router",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		applyAiSettings(settingsWith({ customEndpoints: [a, b] }), deps);
		expect(registry.has(a.id) && registry.has(b.id)).toBe(true);
		expect(registry.list().find((p) => p.id === b.id)).toEqual({
			id: b.id,
			label: "Router",
			defaultModel: "qwen3",
			models: ["qwen3"],
			custom: true,
		});

		applyAiSettings(settingsWith({ customEndpoints: [b] }), deps);
		expect(registry.has(a.id)).toBe(false);
		expect(registry.has(b.id)).toBe(true);
	});

	it("an edit replaces the provider in place (new base URL + model take effect)", async () => {
		const { registry, deps, transports } = setup();
		applyAiSettings(settingsWith({ customEndpoints: [endpoint()] }), deps);
		applyAiSettings(
			settingsWith({
				customEndpoints: [endpoint({ baseUrl: "http://127.0.0.1:8000/v1", defaultModel: "llama3.3" })],
			}),
			deps,
		);
		await registry.get("custom-0000000a")?.generate({ messages: msg });
		expect(transports.at(-1)?.url).toBe("http://127.0.0.1:8000/v1/chat/completions");
	});

	it("derives allowPrivate from the URL: LAN endpoints get it, public ones never do", async () => {
		const { registry, deps, transports } = setup({ "custom-0000000b": "sk-or" });
		const lan = endpoint();
		const pub = endpoint({ id: "custom-0000000b", baseUrl: "https://openrouter.ai/api/v1" });
		applyAiSettings(settingsWith({ customEndpoints: [lan, pub] }), deps);
		await registry.get(lan.id)?.generate({ messages: msg });
		await registry.get(pub.id)?.generate({ messages: msg });
		const calls = transports.filter((t) => t.kind === "openai");
		expect(calls[0]).toMatchObject({ allowPrivate: true, headers: {} });
		expect(calls[1]).toMatchObject({
			allowPrivate: false,
			headers: { Authorization: "Bearer sk-or" },
		});
	});

	it("a public endpoint without a key fails closed before any egress", async () => {
		const { registry, deps, transports } = setup();
		const pub = endpoint({ baseUrl: "https://openrouter.ai/api/v1" });
		applyAiSettings(settingsWith({ customEndpoints: [pub] }), deps);
		await expect(registry.get(pub.id)?.generate({ messages: msg })).rejects.toMatchObject({
			name: "Unavailable",
		});
		expect(transports).toEqual([]);
	});

	it("skips a stored endpoint whose URL no longer validates", () => {
		const { registry, deps } = setup();
		applyAiSettings(
			settingsWith({ customEndpoints: [endpoint({ baseUrl: "http://api.example.com/v1" })] }),
			deps,
		);
		expect(registry.has("custom-0000000a")).toBe(false);
	});

	it("pins the stored default, falling back when it is not registered", () => {
		const { registry, deps } = setup();
		const a = endpoint();
		applyAiSettings(settingsWith({ customEndpoints: [a], defaultProvider: a.id }), deps);
		expect(registry.get(undefined)?.id).toBe(a.id);
		applyAiSettings(settingsWith({ customEndpoints: [], defaultProvider: a.id }), deps);
		expect(registry.get(undefined)?.id).toBe(OLLAMA_PROVIDER_ID);
	});

	it("re-points Ollama at the configured endpoint + model", async () => {
		const { registry, deps, transports } = setup();
		applyAiSettings(
			settingsWith({ ollama: { endpoint: "https://ollama.example.com", model: "qwen3" } }),
			deps,
		);
		const out = await registry.get(OLLAMA_PROVIDER_ID)?.generate({ messages: msg });
		expect(out?.model).toBe("qwen3");
		expect(transports.at(-1)).toEqual({
			kind: "ollama",
			allowPrivate: false,
			url: "https://ollama.example.com/api/chat",
		});
		expect(registry.list().find((p) => p.id === OLLAMA_PROVIDER_ID)?.defaultModel).toBe("qwen3");
	});
});

describe("resolveOllamaConfig", () => {
	it("Settings wins over env, env over the built-in default", () => {
		const env = { endpoint: "http://10.0.0.2:11434", model: "env-model" };
		expect(resolveOllamaConfig({ endpoint: null, model: null }, {})).toEqual({
			endpoint: OLLAMA_DEFAULT_ENDPOINT,
			model: "llama3.2",
			allowPrivate: true,
		});
		expect(resolveOllamaConfig({ endpoint: null, model: null }, env)).toEqual({
			endpoint: env.endpoint,
			model: "env-model",
			allowPrivate: true,
		});
		expect(resolveOllamaConfig({ endpoint: "http://gpu-box:11434", model: "ui" }, env)).toEqual({
			endpoint: "http://gpu-box:11434",
			model: "ui",
			allowPrivate: true,
		});
	});
});

describe("builtinInfo", () => {
	it("puts the default model first and de-duplicates suggestions", () => {
		const info = builtinInfo(OLLAMA_PROVIDER_ID, "Ollama", "qwen3");
		expect(info.models[0]).toBe("qwen3");
		expect(new Set(info.models).size).toBe(info.models.length);
	});
});
