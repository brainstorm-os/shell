import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_PROVIDER_ID, OLLAMA_PROVIDER_ID } from "@brainstorm/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";
import {
	MAX_APP_CREDIT_BUDGET,
	MAX_APP_TOKEN_BUDGET,
	aiSettingsPath,
	defaultAiSettings,
	readAiSettings,
	setAppBudget,
	setDefaultProvider,
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
