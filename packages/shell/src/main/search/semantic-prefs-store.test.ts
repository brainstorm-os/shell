import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SemanticPrefsStore,
	defaultSemanticPrefs,
	semanticPrefsPath,
} from "./semantic-prefs-store";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "bs-semantic-prefs-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function store() {
	return new SemanticPrefsStore({ path: semanticPrefsPath(dir) });
}

describe("SemanticPrefsStore", () => {
	it("defaults to not-consented on first read and re-seeds disk", async () => {
		const prefs = await store().load();
		expect(prefs).toEqual(defaultSemanticPrefs());
		expect(prefs.consented).toBe(false);
		const onDisk = JSON.parse(await fs.readFile(semanticPrefsPath(dir), "utf8"));
		expect(onDisk.consented).toBe(false);
	});

	it("persists consent and reloads it on a fresh store", async () => {
		await store().setConsent(true);
		const reloaded = await store().load();
		expect(reloaded.consented).toBe(true);
	});

	it("can revoke consent back to false", async () => {
		const s = store();
		await s.setConsent(true);
		await s.setConsent(false);
		expect((await s.load()).consented).toBe(false);
	});

	it("caches after load so a re-read does not touch disk", async () => {
		const s = store();
		await s.setConsent(true);
		// Corrupt the file behind the cache — the cached value must win.
		await fs.writeFile(semanticPrefsPath(dir), "garbage", "utf8");
		expect((await s.load()).consented).toBe(true);
	});

	it("falls back to the default on a corrupt file and re-seeds", async () => {
		await fs.writeFile(semanticPrefsPath(dir), "{ not json", "utf8");
		const prefs = await store().load();
		expect(prefs.consented).toBe(false);
		const onDisk = JSON.parse(await fs.readFile(semanticPrefsPath(dir), "utf8"));
		expect(onDisk.consented).toBe(false);
	});

	it("rejects a wrong-typed consented field as corrupt", async () => {
		await fs.writeFile(semanticPrefsPath(dir), JSON.stringify({ consented: "yes" }), "utf8");
		expect((await store().load()).consented).toBe(false);
	});
});
