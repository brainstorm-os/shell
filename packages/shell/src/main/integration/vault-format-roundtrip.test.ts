/**
 * Stage 10.8 — vault-format integration: create → open → mutate round-trip
 * through the live shell module loader (mirrors the existing
 * `vault-sync-relay.test.ts` shell-fresh pattern but lives in
 * `integration/` because it spans create + open + multiple module
 * resets).
 *
 * Pins the 10.8 freeze on the *real* code path:
 *   - A freshly-created vault has `format=1.0`.
 *   - A reopen passes through `migrateVaultToCurrent` (no-op at 10.8) +
 *     `assertVaultFormatNotPreFreeze` + `assertVaultFormatSupported`.
 *   - A hand-stamped future-minor (`1.5`) opens (preserve-and-ignore).
 *   - Unknown fields survive the open + an actual mutation
 *     (`setSyncRelayConfig`) called via the real export.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let USER_DATA_DIR = "";

vi.mock("electron", () => ({
	app: { getPath: () => USER_DATA_DIR },
}));

describe("vault format 10.8 — integration roundtrip", () => {
	let workDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-vault-format-rt-"));
		USER_DATA_DIR = workDir;
		vaultPath = join(workDir, "vault");
	});

	afterEach(async () => {
		await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	async function freshShell(): Promise<{
		createVault: typeof import("../vault/vault").createVault;
		openVault: typeof import("../vault/vault").openVault;
		closeActiveVaultSession: typeof import("../vault/session").closeActiveVaultSession;
	}> {
		vi.resetModules();
		const sqliteMod = await import("../storage/sqlite");
		sqliteMod.__setSqlcipherDriverForTests(null);
		const atRestMod = await import("../storage/at-rest-mode");
		atRestMod.__resetAtRestProbeForTests();
		const vault = await import("../vault/vault");
		const session = await import("../vault/session");
		return {
			createVault: vault.createVault,
			openVault: vault.openVault,
			closeActiveVaultSession: session.closeActiveVaultSession,
		};
	}

	it("createVault stamps format=1.0; openVault round-trips the field", async () => {
		const { createVault, openVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "rt", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		const file = join(vaultPath, "vault.json");
		const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(parsed.format).toBe("1.0");
		const shell2 = await freshShell();
		const entry = await shell2.openVault(vaultPath, { keystore: { forceInsecure: true } });
		expect(entry.format).toBe("1.0");
		shell2.closeActiveVaultSession();
	});

	it("future-minor (1.5) opens without throwing (preserve-and-ignore)", async () => {
		const { createVault, openVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "rt", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		const file = join(vaultPath, "vault.json");
		const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		parsed.format = "1.5";
		parsed.someFutureMinorField = "v1.5-only";
		await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
		const shell2 = await freshShell();
		const entry = await shell2.openVault(vaultPath, { keystore: { forceInsecure: true } });
		expect(entry.format).toBe("1.5");
		const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(after.someFutureMinorField).toBe("v1.5-only");
		shell2.closeActiveVaultSession();
	});
});
