/**
 * Agent-14 — the Settings → AI privileged ipcMain surface for custom endpoints
 * and the Ollama override. Electron is mocked; the store + credential store are
 * real (on a temp vault). Asserts persistence, the live-registry apply hook,
 * that a custom endpoint's key is addressable only while the endpoint exists,
 * and that removing an endpoint deletes its key.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettings, CustomEndpointResult } from "../vault/ai-settings-store";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();
let session: { vaultPath: string; credentials: CredentialStore } | null = null;

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: IpcHandler) => {
			handlers.set(channel, fn);
		},
	},
}));
vi.mock("../vault/session", () => ({ getActiveVaultSession: () => session }));

import { readAiProviderKey } from "../credentials/ai-provider-keys";
import { CredentialStore } from "../credentials/store";
import { removeTestDir } from "../test-support/remove-test-dir";
import {
	AI_CLEAR_PROVIDER_KEY_CHANNEL,
	AI_HAS_PROVIDER_KEY_CHANNEL,
	AI_REMOVE_ENDPOINT_CHANNEL,
	AI_SET_DEFAULT_PROVIDER_CHANNEL,
	AI_SET_OLLAMA_CHANNEL,
	AI_SET_PROVIDER_KEY_CHANNEL,
	AI_UPSERT_ENDPOINT_CHANNEL,
	registerAiSettingsHandlers,
} from "./ai-settings-handlers";

const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> =>
	(await handlers.get(channel)?.({}, ...args)) as T;

let dir: string;
let applied: AiSettings[];

beforeEach(async () => {
	handlers.clear();
	dir = await mkdtemp(join(tmpdir(), "bs-ai-ipc-"));
	session = { vaultPath: dir, credentials: new CredentialStore(dir, new Uint8Array(32).fill(7)) };
	applied = [];
	registerAiSettingsHandlers({ applySettings: (s) => applied.push(s) });
});

afterEach(async () => {
	session = null;
	await removeTestDir(dir);
});

const box = { name: "Box", baseUrl: "http://192.168.1.20:1234/v1", defaultModel: "qwen3" };

describe("ai-settings custom endpoint handlers", () => {
	it("add applies to the live registry; edit and remove re-apply", async () => {
		const added = await invoke<CustomEndpointResult>(AI_UPSERT_ENDPOINT_CHANNEL, box);
		if (!added.ok) throw new Error("add failed");
		expect(applied.at(-1)?.customEndpoints).toHaveLength(1);

		await invoke(AI_UPSERT_ENDPOINT_CHANNEL, { ...box, id: added.endpoint.id, name: "Box 2" });
		expect(applied.at(-1)?.customEndpoints[0]?.name).toBe("Box 2");

		await invoke(AI_REMOVE_ENDPOINT_CHANNEL, added.endpoint.id);
		expect(applied.at(-1)?.customEndpoints).toEqual([]);
	});

	it("a refused endpoint is reported and never applied", async () => {
		const out = await invoke<CustomEndpointResult>(AI_UPSERT_ENDPOINT_CHANNEL, {
			...box,
			baseUrl: "http://api.example.com/v1",
		});
		expect(out.ok).toBe(false);
		expect(applied).toEqual([]);
	});

	it("a custom key is addressable only while its endpoint exists, and removal deletes it", async () => {
		expect(await invoke(AI_SET_PROVIDER_KEY_CHANNEL, "custom-deadbeef", "sk")).toBe(false);

		const added = await invoke<CustomEndpointResult>(AI_UPSERT_ENDPOINT_CHANNEL, box);
		if (!added.ok) throw new Error("add failed");
		const id = added.endpoint.id;
		expect(await invoke(AI_SET_PROVIDER_KEY_CHANNEL, id, "  sk-local  ")).toBe(true);
		expect(await invoke(AI_HAS_PROVIDER_KEY_CHANNEL, id)).toBe(true);
		expect(await readAiProviderKey(session?.credentials as CredentialStore, id)).toBe("sk-local");

		await invoke(AI_REMOVE_ENDPOINT_CHANNEL, id);
		expect(await readAiProviderKey(session?.credentials as CredentialStore, id)).toBeNull();
		expect(await invoke(AI_HAS_PROVIDER_KEY_CHANNEL, id)).toBe(false);
		expect(await invoke(AI_CLEAR_PROVIDER_KEY_CHANNEL, id)).toBe(false);
	});

	it("rejects arbitrary credential ids outside the AI provider set", async () => {
		expect(await invoke(AI_SET_PROVIDER_KEY_CHANNEL, "io.brainstorm.mail", "x")).toBe(false);
		expect(await invoke(AI_REMOVE_ENDPOINT_CHANNEL, "anthropic")).toBeNull();
	});

	it("routing default may name an existing custom endpoint", async () => {
		const added = await invoke<CustomEndpointResult>(AI_UPSERT_ENDPOINT_CHANNEL, box);
		if (!added.ok) throw new Error("add failed");
		const next = await invoke<AiSettings>(AI_SET_DEFAULT_PROVIDER_CHANNEL, added.endpoint.id);
		expect(next.defaultProvider).toBe(added.endpoint.id);
		expect(applied.at(-1)?.defaultProvider).toBe(added.endpoint.id);
	});

	it("set-ollama persists, applies, and refuses a cleartext public host", async () => {
		const ok = await invoke<{ ok: boolean }>(AI_SET_OLLAMA_CHANNEL, {
			endpoint: "http://gpu-box:11434",
			model: "qwen3",
		});
		expect(ok.ok).toBe(true);
		expect(applied.at(-1)?.ollama).toEqual({ endpoint: "http://gpu-box:11434", model: "qwen3" });
		const bad = await invoke<{ ok: boolean }>(AI_SET_OLLAMA_CHANNEL, {
			endpoint: "http://x.example.com",
		});
		expect(bad.ok).toBe(false);
	});

	it("no open vault → every mutator is a null no-op", async () => {
		session = null;
		expect(await invoke(AI_UPSERT_ENDPOINT_CHANNEL, box)).toBeNull();
		expect(await invoke(AI_SET_OLLAMA_CHANNEL, { model: "x" })).toBeNull();
		expect(applied).toEqual([]);
	});
});
