import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIRM_SKIP_KEY_PREFIX, ConfirmKind, confirmSkipKey } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { DataStores } from "../storage/data-stores";
import { SettingsRepository } from "../storage/settings-repo";
import { makeSettingsServiceHandler } from "./settings-service";

function env(app: string, method: string, arg: unknown): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m",
		app,
		service: "settings",
		method,
		args: [arg],
		caps: [],
	};
}

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-settings-"));
	const stores = new DataStores(vaultDir);
	const repo = new SettingsRepository(await stores.open("settings"));
	const handler = makeSettingsServiceHandler({ getRepo: async () => repo });
	return { vaultDir, stores, repo, handler };
}

describe("settings service handler", () => {
	let e: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		e = await setup();
	});
	afterEach(async () => {
		e.stores.close();
		await rm(e.vaultDir, { recursive: true, force: true });
	});

	it("put then get round-trips a JSON value", async () => {
		await e.handler(
			env("io.x", "put", { key: "graph:state", value: { zoom: 1.5, pattern: "type" } }),
		);
		expect(await e.handler(env("io.x", "get", { key: "graph:state" }))).toEqual({
			zoom: 1.5,
			pattern: "type",
		});
	});

	it("get returns null for a missing key", async () => {
		expect(await e.handler(env("io.x", "get", { key: "nope" }))).toBeNull();
	});

	it("put overwrites the existing value", async () => {
		await e.handler(env("io.x", "put", { key: "k", value: 1 }));
		await e.handler(env("io.x", "put", { key: "k", value: 2 }));
		expect(await e.handler(env("io.x", "get", { key: "k" }))).toBe(2);
	});

	it("is app-scoped — one app cannot read another app's settings", async () => {
		await e.handler(env("io.a", "put", { key: "shared", value: "a-secret" }));
		expect(await e.handler(env("io.b", "get", { key: "shared" }))).toBeNull();
		await e.handler(env("io.b", "put", { key: "shared", value: "b-value" }));
		expect(await e.handler(env("io.a", "get", { key: "shared" }))).toBe("a-secret");
		expect(await e.handler(env("io.b", "get", { key: "shared" }))).toBe("b-value");
	});

	it("delete removes a key and reports whether it existed", async () => {
		await e.handler(env("io.x", "put", { key: "k", value: 1 }));
		expect(await e.handler(env("io.x", "delete", { key: "k" }))).toBe(true);
		expect(await e.handler(env("io.x", "get", { key: "k" }))).toBeNull();
		expect(await e.handler(env("io.x", "delete", { key: "k" }))).toBe(false);
	});

	it("list returns this app's entries filtered by prefix", async () => {
		await e.handler(env("io.x", "put", { key: "view:board", value: 1 }));
		await e.handler(env("io.x", "put", { key: "view:list", value: 2 }));
		await e.handler(env("io.x", "put", { key: "other", value: 3 }));
		await e.handler(env("io.y", "put", { key: "view:board", value: 99 }));

		const viewEntries = (await e.handler(env("io.x", "list", { prefix: "view:" }))) as Array<{
			key: string;
			value: unknown;
		}>;
		expect(viewEntries).toEqual([
			{ key: "view:board", value: 1 },
			{ key: "view:list", value: 2 },
		]);
		const all = (await e.handler(env("io.x", "list", {}))) as unknown[];
		expect(all).toHaveLength(3);
	});

	it("put with a missing key is Invalid", async () => {
		await expect(e.handler(env("io.x", "put", { value: 1 }))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("a LIKE-wildcard prefix matches literally (no injection)", async () => {
		await e.handler(env("io.x", "put", { key: "a%b", value: 1 }));
		await e.handler(env("io.x", "put", { key: "axxb", value: 2 }));
		const hits = (await e.handler(env("io.x", "list", { prefix: "a%" }))) as Array<{ key: string }>;
		expect(hits.map((h) => h.key)).toEqual(["a%b"]);
	});

	it("6.15: stores a skip for a reversible confirmation kind only", async () => {
		const reversible = confirmSkipKey(ConfirmKind.MoveToBin);
		await e.handler(env("io.x", "put", { key: reversible, value: true }));
		expect(await e.handler(env("io.x", "get", { key: reversible }))).toBe(true);
		for (const key of [
			confirmSkipKey(ConfirmKind.EmptyBin),
			confirmSkipKey(ConfirmKind.PurgeFromBin),
			confirmSkipKey(ConfirmKind.DeleteVault),
			confirmSkipKey(ConfirmKind.RemoveCredential),
			`${CONFIRM_SKIP_KEY_PREFIX}some-future-kind`,
		]) {
			await expect(e.handler(env("io.x", "put", { key, value: true })), key).rejects.toMatchObject({
				name: "Invalid",
			});
			expect(e.repo.get("io.x", key)).toBeNull();
		}
	});

	it("6.15: deleteKeyForAllApps resets one key across every app namespace", async () => {
		const key = confirmSkipKey(ConfirmKind.MoveToBin);
		await e.handler(env("io.a", "put", { key, value: true }));
		await e.handler(env("io.b", "put", { key, value: true }));
		await e.handler(env("io.b", "put", { key: "other", value: 1 }));
		expect(e.repo.deleteKeyForAllApps(key)).toBe(2);
		expect(e.repo.get("io.a", key)).toBeNull();
		expect(e.repo.get("io.b", "other")).toBe("1");
	});

	it("no active vault → Unavailable, fail closed", async () => {
		const handler = makeSettingsServiceHandler({ getRepo: async () => null });
		await expect(handler(env("io.x", "get", { key: "k" }))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("a corrupt stored blob reads back as null rather than throwing", async () => {
		e.repo.set("io.x", "k", "{not json");
		expect(await e.handler(env("io.x", "get", { key: "k" }))).toBeNull();
	});
});
