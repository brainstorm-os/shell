import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ANTHROPIC_PROVIDER_ID,
	GLM_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	OLLAMA_PROVIDER_ID,
	SOLHEIM_PROVIDER_ID,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CustomEndpointError,
	CustomEndpointPreset,
	EndpointUrlError,
	OPENROUTER_BASE_URL,
	OllamaSettingsError,
} from "../../shared/ai-endpoints";
import { removeTestDir } from "../test-support/remove-test-dir";
import {
	MAX_APP_CREDIT_BUDGET,
	MAX_APP_TOKEN_BUDGET,
	MAX_CUSTOM_ENDPOINTS,
	aiSettingsPath,
	applyCustomEndpoint,
	defaultAiSettings,
	readAiSettings,
	removeCustomEndpoint,
	setAppBudget,
	setDefaultProvider,
	setOllamaSettings,
	upsertCustomEndpoint,
	validateAiSettings,
	writeAiSettings,
} from "./ai-settings-store";

describe("validateAiSettings", () => {
	it("keeps a routable default provider and a valid budget", () => {
		const out = validateAiSettings({
			defaultProvider: ANTHROPIC_PROVIDER_ID,
			appBudgets: { "io.brainstorm.agent": { maxTokens: 5000 } },
		});
		expect(out).toEqual({
			...defaultAiSettings(),
			defaultProvider: ANTHROPIC_PROVIDER_ID,
			appBudgets: { "io.brainstorm.agent": { maxTokens: 5000 } },
		});
	});

	it("drops an unroutable provider, non-object input, and bad budgets", () => {
		expect(validateAiSettings({ defaultProvider: "evil-corp" }).defaultProvider).toBeNull();
		expect(validateAiSettings(null)).toEqual(defaultAiSettings());
		expect(validateAiSettings({ appBudgets: { app: { maxTokens: 0 } } }).appBudgets).toEqual({});
		expect(validateAiSettings({ appBudgets: { app: { maxTokens: -1 } } }).appBudgets).toEqual({});
		expect(validateAiSettings({ appBudgets: { "": { maxTokens: 5 } } }).appBudgets).toEqual({});
	});

	it("floors fractional budgets and clamps to the hard max", () => {
		const out = validateAiSettings({
			appBudgets: { a: { maxTokens: 12.9 }, b: { maxTokens: MAX_APP_TOKEN_BUDGET * 10 } },
		});
		expect(out.appBudgets.a).toEqual({ maxTokens: 12 });
		expect(out.appBudgets.b).toEqual({ maxTokens: MAX_APP_TOKEN_BUDGET });
	});

	it("14.8 — keeps credit budgets (alone or with tokens), capped", () => {
		const out = validateAiSettings({
			appBudgets: {
				a: { maxCredits: 25 },
				b: { maxTokens: 100, maxCredits: MAX_APP_CREDIT_BUDGET * 2 },
				c: { maxCredits: -3 },
			},
		});
		expect(out.appBudgets.a).toEqual({ maxCredits: 25 });
		expect(out.appBudgets.b).toEqual({ maxTokens: 100, maxCredits: MAX_APP_CREDIT_BUDGET });
		expect(out.appBudgets.c).toBeUndefined();
	});
});

describe("readAiSettings / writeAiSettings + mutators", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "brainstorm-ai-settings-"));
	});
	afterEach(async () => {
		await removeTestDir(dir);
	});

	it("default-on-first-read writes the default", async () => {
		expect(await readAiSettings(dir)).toEqual(defaultAiSettings());
		const raw = JSON.parse(await readFile(aiSettingsPath(dir), "utf8"));
		expect(raw).toEqual(defaultAiSettings());
	});

	it("setDefaultProvider round-trips and null clears", async () => {
		expect((await setDefaultProvider(dir, ANTHROPIC_PROVIDER_ID)).defaultProvider).toBe(
			ANTHROPIC_PROVIDER_ID,
		);
		expect((await readAiSettings(dir)).defaultProvider).toBe(ANTHROPIC_PROVIDER_ID);
		expect((await setDefaultProvider(dir, null)).defaultProvider).toBeNull();
		// An unroutable id is treated as a clear, never persisted.
		expect((await setDefaultProvider(dir, "nope")).defaultProvider).toBeNull();
		// A routable id with no key configured is still allowed (routing intent).
		expect((await setDefaultProvider(dir, OLLAMA_PROVIDER_ID)).defaultProvider).toBe(
			OLLAMA_PROVIDER_ID,
		);
	});

	it("setAppBudget sets, updates, and clears (empty budget)", async () => {
		await setAppBudget(dir, "io.brainstorm.agent", { maxTokens: 1000 });
		expect((await readAiSettings(dir)).appBudgets["io.brainstorm.agent"]).toEqual({
			maxTokens: 1000,
		});
		await setAppBudget(dir, "io.brainstorm.agent", { maxTokens: 2000, maxCredits: 5 });
		expect((await readAiSettings(dir)).appBudgets["io.brainstorm.agent"]).toEqual({
			maxTokens: 2000,
			maxCredits: 5,
		});
		await setAppBudget(dir, "io.brainstorm.agent", {});
		expect((await readAiSettings(dir)).appBudgets["io.brainstorm.agent"]).toBeUndefined();
		// An empty app id is a no-op.
		const before = await readAiSettings(dir);
		expect(await setAppBudget(dir, "", { maxTokens: 50 })).toEqual(before);
	});

	it("setAppBudget with only credits persists a credits-only budget", async () => {
		await setAppBudget(dir, "io.brainstorm.browser", { maxCredits: 12 });
		expect((await readAiSettings(dir)).appBudgets["io.brainstorm.browser"]).toEqual({
			maxCredits: 12,
		});
	});
});

describe("Agent-14 — custom endpoints + Ollama override", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "brainstorm-ai-endpoints-"));
	});
	afterEach(async () => {
		await removeTestDir(dir);
	});

	const lan = { name: "Studio box", baseUrl: "http://192.168.1.20:1234/v1/", defaultModel: "qwen3" };

	it("GLM, Mistral and Solheim are routable defaults", () => {
		for (const id of [GLM_PROVIDER_ID, MISTRAL_PROVIDER_ID, SOLHEIM_PROVIDER_ID]) {
			expect(validateAiSettings({ defaultProvider: id }).defaultProvider).toBe(id);
		}
	});

	it("add → edit → remove round-trips through the file; the id is stable and routable", async () => {
		const added = await upsertCustomEndpoint(dir, lan);
		if (!added.ok) throw new Error("add failed");
		const id = added.endpoint.id;
		expect(id).toMatch(/^custom-[0-9a-f]{12}$/);
		expect(added.endpoint).toEqual({
			id,
			name: "Studio box",
			baseUrl: "http://192.168.1.20:1234/v1",
			defaultModel: "qwen3",
			preset: CustomEndpointPreset.Generic,
		});
		expect((await readAiSettings(dir)).customEndpoints).toEqual([added.endpoint]);

		expect((await setDefaultProvider(dir, id)).defaultProvider).toBe(id);

		const edited = await upsertCustomEndpoint(dir, { ...lan, id, defaultModel: "llama3.3" });
		expect(edited.ok && edited.endpoint).toMatchObject({ id, defaultModel: "llama3.3" });
		expect((await readAiSettings(dir)).customEndpoints).toHaveLength(1);

		const removed = await removeCustomEndpoint(dir, id);
		expect(removed?.customEndpoints).toEqual([]);
		expect(removed?.defaultProvider).toBeNull();
		expect(await removeCustomEndpoint(dir, id)).toBeNull();
	});

	it("keeps the OpenRouter preset on the record", async () => {
		const added = await upsertCustomEndpoint(dir, {
			name: "OpenRouter",
			baseUrl: OPENROUTER_BASE_URL,
			defaultModel: "anthropic/claude-sonnet-4.6",
			preset: CustomEndpointPreset.OpenRouter,
		});
		expect(added.ok && added.endpoint.preset).toBe(CustomEndpointPreset.OpenRouter);
	});

	it("validates name, URL and model, and reports the URL reason", () => {
		const base = defaultAiSettings();
		expect(applyCustomEndpoint(base, { ...lan, name: " " })).toEqual({
			ok: false,
			error: CustomEndpointError.InvalidName,
		});
		expect(applyCustomEndpoint(base, { ...lan, name: "a\u0007b" })).toMatchObject({
			error: CustomEndpointError.InvalidName,
		});
		expect(applyCustomEndpoint(base, { ...lan, baseUrl: "http://api.example.com/v1" })).toEqual({
			ok: false,
			error: CustomEndpointError.InvalidUrl,
			urlError: EndpointUrlError.InsecurePublic,
		});
		expect(applyCustomEndpoint(base, { ...lan, defaultModel: "a\nb" })).toMatchObject({
			error: CustomEndpointError.InvalidModel,
		});
		expect(applyCustomEndpoint(base, { ...lan, id: "custom-ffffffff" })).toMatchObject({
			error: CustomEndpointError.NotFound,
		});
	});

	it("caps the number of endpoints", () => {
		let settings = defaultAiSettings();
		let n = 0;
		const mint = () => `custom-${(n++).toString(16).padStart(8, "0")}`;
		for (let i = 0; i < MAX_CUSTOM_ENDPOINTS; i++) {
			const r = applyCustomEndpoint(settings, lan, mint);
			if (!r.ok) throw new Error("unexpected");
			settings = r.settings;
		}
		expect(applyCustomEndpoint(settings, lan, mint)).toMatchObject({
			error: CustomEndpointError.TooMany,
		});
	});

	it("drops hand-edited endpoints that would fail validation, and a default pointing at one", () => {
		const out = validateAiSettings({
			defaultProvider: "custom-deadbeef",
			customEndpoints: [
				{ id: "custom-deadbeef", name: "x", baseUrl: "http://api.example.com", defaultModel: "m" },
				{ id: "anthropic", name: "spoof", baseUrl: "https://example.com", defaultModel: "m" },
				{ id: "custom-00000001", name: "ok", baseUrl: "https://example.com/v1", defaultModel: "m" },
				{ id: "custom-00000001", name: "dup", baseUrl: "https://example.com/v1", defaultModel: "m" },
			],
		});
		expect(out.customEndpoints.map((e) => e.id)).toEqual(["custom-00000001"]);
		expect(out.defaultProvider).toBeNull();
		expect(validateAiSettings({ defaultProvider: "custom-99999999" }).defaultProvider).toBeNull();
	});

	it("setOllamaSettings validates and an empty field clears back to the default", async () => {
		const set = await setOllamaSettings(dir, { endpoint: "http://gpu-box:11434/", model: "qwen3" });
		expect(set.ok && set.settings.ollama).toEqual({
			endpoint: "http://gpu-box:11434",
			model: "qwen3",
		});
		expect((await readAiSettings(dir)).ollama.model).toBe("qwen3");

		expect(await setOllamaSettings(dir, { endpoint: "http://ollama.example.com" })).toEqual({
			ok: false,
			error: OllamaSettingsError.InvalidUrl,
			urlError: EndpointUrlError.InsecurePublic,
		});
		expect(await setOllamaSettings(dir, { model: "bad\u0000" })).toMatchObject({
			error: OllamaSettingsError.InvalidModel,
		});

		const cleared = await setOllamaSettings(dir, { endpoint: "", model: "" });
		expect(cleared.ok && cleared.settings.ollama).toEqual({ endpoint: null, model: null });
	});
});
