/**
 * Stage 10.4 — `vault.json` `syncRelay` field shape tests.
 *
 * Pins the on-disk contract that 10.5 (pairing UX) will write into:
 *   - `createVault` does NOT default the field (absence ⇒ local-only).
 *   - A round-trip through `openVault` preserves the field byte-for-byte.
 *   - The `isVaultJson` validator rejects a malformed `syncRelay`.
 *   - The exported `isSyncRelayConfig` guard is exhaustive over the
 *     load-bearing shape (empty url / non-finite addedAt / non-object).
 *
 * The vault.json schema is FROZEN at 10.8; this iteration's contract is
 * what 10.8 codifies. Adding a 10.4-side test for it now is the cheapest
 * way to keep that promise structural.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";

let USER_DATA_DIR = "";

vi.mock("electron", () => ({
	app: { getPath: () => USER_DATA_DIR },
}));

describe("vault.json syncRelay field", () => {
	let workDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-vault-syncrelay-"));
		USER_DATA_DIR = workDir;
		vaultPath = join(workDir, "vault");
	});

	afterEach(async () => {
		await removeTestDir(workDir);
	});

	async function freshShell(): Promise<{
		createVault: typeof import("./vault").createVault;
		openVault: typeof import("./vault").openVault;
		closeActiveVaultSession: typeof import("./session").closeActiveVaultSession;
		isSyncRelayConfig: typeof import("./vault").isSyncRelayConfig;
		setSyncRelayConfig: typeof import("./vault").setSyncRelayConfig;
	}> {
		vi.resetModules();
		const sqliteMod = await import("../storage/sqlite");
		sqliteMod.__setSqlcipherDriverForTests(null);
		const atRestMod = await import("../storage/at-rest-mode");
		atRestMod.__resetAtRestProbeForTests();
		const vault = await import("./vault");
		const session = await import("./session");
		return {
			createVault: vault.createVault,
			openVault: vault.openVault,
			closeActiveVaultSession: session.closeActiveVaultSession,
			isSyncRelayConfig: vault.isSyncRelayConfig,
			setSyncRelayConfig: vault.setSyncRelayConfig,
		};
	}

	it("createVault does NOT default syncRelay — absence means local-only", async () => {
		const { createVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "Plain", path: vaultPath, keystore: { forceInsecure: true } });
		const raw = await readFile(join(vaultPath, "vault.json"), "utf8");
		const json = JSON.parse(raw) as { syncRelay?: unknown };
		expect(json.syncRelay).toBeUndefined();
		closeActiveVaultSession();
	});

	it("openVault preserves a hand-written syncRelay round-trip", async () => {
		const { createVault, openVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "Plain", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		const path = join(vaultPath, "vault.json");
		const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		parsed.syncRelay = { url: "wss://relay.example.invalid/", addedAt: 1_700_000_000_000 };
		await writeFile(path, JSON.stringify(parsed), "utf8");

		const shell2 = await freshShell();
		await shell2.openVault(vaultPath, { keystore: { forceInsecure: true } });
		const after = JSON.parse(await readFile(path, "utf8")) as {
			syncRelay?: { url: string; addedAt: number };
		};
		expect(after.syncRelay).toEqual({
			url: "wss://relay.example.invalid/",
			addedAt: 1_700_000_000_000,
		});
		shell2.closeActiveVaultSession();
	});

	it("openVault rejects malformed syncRelay (empty url)", async () => {
		const { createVault, openVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "Plain", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		const path = join(vaultPath, "vault.json");
		const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		parsed.syncRelay = { url: "", addedAt: 1 };
		await writeFile(path, JSON.stringify(parsed), "utf8");
		const shell2 = await freshShell();
		await expect(shell2.openVault(vaultPath, { keystore: { forceInsecure: true } })).rejects.toThrow(
			/malformed/,
		);
	});

	it("openVault rejects malformed syncRelay (non-finite addedAt)", async () => {
		const { createVault, openVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "Plain", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		const path = join(vaultPath, "vault.json");
		const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		parsed.syncRelay = { url: "wss://x/", addedAt: "yesterday" };
		await writeFile(path, JSON.stringify(parsed), "utf8");
		const shell2 = await freshShell();
		await expect(shell2.openVault(vaultPath, { keystore: { forceInsecure: true } })).rejects.toThrow(
			/malformed/,
		);
	});

	it("isSyncRelayConfig accepts the canonical shape", async () => {
		const { isSyncRelayConfig } = await freshShell();
		expect(isSyncRelayConfig({ url: "wss://r/", addedAt: 1 })).toBe(true);
	});

	it("isSyncRelayConfig rejects non-object / missing fields / wrong types", async () => {
		const { isSyncRelayConfig } = await freshShell();
		expect(isSyncRelayConfig(null)).toBe(false);
		expect(isSyncRelayConfig({})).toBe(false);
		expect(isSyncRelayConfig({ url: "wss://r/" })).toBe(false);
		expect(isSyncRelayConfig({ addedAt: 1 })).toBe(false);
		expect(isSyncRelayConfig({ url: "", addedAt: 1 })).toBe(false);
		expect(isSyncRelayConfig({ url: "wss://r/", addedAt: Number.NaN })).toBe(false);
		expect(isSyncRelayConfig({ url: "wss://r/", addedAt: Number.POSITIVE_INFINITY })).toBe(false);
		expect(isSyncRelayConfig({ url: 7, addedAt: 1 })).toBe(false);
	});

	it("setSyncRelayConfig writes the field atomically + preserves unknown keys", async () => {
		const { createVault, setSyncRelayConfig, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "Plain", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		// Stamp a hand-written forward-compat field that the schema doesn't
		// know about. The mutator MUST preserve it on round-trip.
		const path = join(vaultPath, "vault.json");
		const before = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		before.forwardCompatField = "v2-only";
		await writeFile(path, JSON.stringify(before, null, 2), "utf8");

		const result = await setSyncRelayConfig(vaultPath, {
			url: "wss://relay.example/",
			addedAt: 1_800_000_000_000,
		});
		expect(result.changed).toBe(true);
		expect(result.effective).toEqual({
			url: "wss://relay.example/",
			addedAt: 1_800_000_000_000,
		});
		const after = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		expect(after.syncRelay).toEqual({
			url: "wss://relay.example/",
			addedAt: 1_800_000_000_000,
		});
		expect(after.forwardCompatField).toBe("v2-only");
	});

	it("setSyncRelayConfig is idempotent on the same value (changed=false)", async () => {
		const { createVault, setSyncRelayConfig, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "Plain", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		const cfg = { url: "wss://relay.example/", addedAt: 1_800_000_000_000 };
		const first = await setSyncRelayConfig(vaultPath, cfg);
		expect(first.changed).toBe(true);
		const second = await setSyncRelayConfig(vaultPath, { ...cfg });
		expect(second.changed).toBe(false);
		expect(second.effective).toEqual(cfg);
	});

	it("setSyncRelayConfig(null) clears the field", async () => {
		const { createVault, setSyncRelayConfig, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "Plain", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		await setSyncRelayConfig(vaultPath, {
			url: "wss://relay.example/",
			addedAt: 1_800_000_000_000,
		});
		const clearResult = await setSyncRelayConfig(vaultPath, null);
		expect(clearResult.changed).toBe(true);
		expect(clearResult.effective).toBeNull();
		const path = join(vaultPath, "vault.json");
		const after = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		expect(after.syncRelay).toBeUndefined();
	});

	it("setSyncRelayConfig rejects invalid config (empty url)", async () => {
		const { createVault, setSyncRelayConfig, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "Plain", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		await expect(setSyncRelayConfig(vaultPath, { url: "", addedAt: 1 } as never)).rejects.toThrow(
			/invalid SyncRelayConfig/,
		);
	});

	it("setSyncRelayConfig rejects invalid config (non-finite addedAt)", async () => {
		const { createVault, setSyncRelayConfig, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "Plain", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		await expect(
			setSyncRelayConfig(vaultPath, {
				url: "wss://r/",
				addedAt: Number.NaN,
			} as never),
		).rejects.toThrow(/invalid SyncRelayConfig/);
	});
});
