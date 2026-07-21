/**
 * Stage 10.8 — pre-freeze + future-major rejection contract.
 *
 * The freeze means the shell takes a stance on every `vault.json.format`
 * value it might encounter:
 *
 *   - `< 1.0`   → `VaultFormatPreFreezeError`, unless
 *                 `BRAINSTORM_ALLOW_PRE_FREEZE_VAULTS=1` (test-only,
 *                 undocumented per OQ-215) downgrades it to a warn.
 *   - `1.0`     → opens as-is.
 *   - `1.<n>`   → opens via preserve-and-ignore (future-minor inside the
 *                 same major series).
 *   - `>= 2.0`  → `VaultFormatTooNew` (the existing guard).
 *
 * These tests own the contract; the `vault.ts` `openVault` path consumes
 * the two assertions back-to-back.
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

describe("vault format pre-freeze + future-major rejection", () => {
	let workDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-vault-format-reject-"));
		USER_DATA_DIR = workDir;
		vaultPath = join(workDir, "vault");
		// biome-ignore lint/performance/noDelete: `delete` is the only way to truly unset an env var (assigning undefined coerces to the string "undefined")
		delete process.env.BRAINSTORM_ALLOW_PRE_FREEZE_VAULTS;
	});

	afterEach(async () => {
		// biome-ignore lint/performance/noDelete: same reason as above
		delete process.env.BRAINSTORM_ALLOW_PRE_FREEZE_VAULTS;
		await removeTestDir(workDir);
	});

	async function freshShell(): Promise<{
		createVault: typeof import("./vault").createVault;
		openVault: typeof import("./vault").openVault;
		closeActiveVaultSession: typeof import("./session").closeActiveVaultSession;
	}> {
		vi.resetModules();
		const sqliteMod = await import("@brainstorm-os/sqlite");
		sqliteMod.__setSqlcipherDriverForTests(null);
		const atRestMod = await import("@brainstorm-os/sqlite/at-rest-mode");
		atRestMod.__resetAtRestProbeForTests();
		const vault = await import("./vault");
		const session = await import("./session");
		return {
			createVault: vault.createVault,
			openVault: vault.openVault,
			closeActiveVaultSession: session.closeActiveVaultSession,
		};
	}

	async function bumpVaultFormat(path: string, format: string): Promise<void> {
		const file = join(path, "vault.json");
		const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		parsed.format = format;
		await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
	}

	it("0.9 (pre-freeze) is rejected with VaultFormatPreFreezeError", async () => {
		const { createVault, openVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "v", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		await bumpVaultFormat(vaultPath, "0.9");
		const shell2 = await freshShell();
		await expect(shell2.openVault(vaultPath, { keystore: { forceInsecure: true } })).rejects.toThrow(
			/predates the 1\.0 freeze/,
		);
	});

	it("0.9 opens (warn only) when BRAINSTORM_ALLOW_PRE_FREEZE_VAULTS=1", async () => {
		const { createVault, openVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "v", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		await bumpVaultFormat(vaultPath, "0.9");
		process.env.BRAINSTORM_ALLOW_PRE_FREEZE_VAULTS = "1";
		const shell2 = await freshShell();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const entry = await shell2.openVault(vaultPath, { keystore: { forceInsecure: true } });
			expect(entry.format).toBe("0.9");
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/predates the 1\.0 freeze/));
		} finally {
			warn.mockRestore();
			shell2.closeActiveVaultSession();
		}
	});

	it("2.0 (future-major) is rejected with VaultFormatTooNew", async () => {
		const { createVault, openVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "v", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		await bumpVaultFormat(vaultPath, "2.0");
		const shell2 = await freshShell();
		await expect(shell2.openVault(vaultPath, { keystore: { forceInsecure: true } })).rejects.toThrow(
			/newer than this shell supports/,
		);
	});

	it("1.5 (future-minor) opens (preserve-and-ignore inside the same major)", async () => {
		const { createVault, openVault, closeActiveVaultSession } = await freshShell();
		await createVault({ name: "v", path: vaultPath, keystore: { forceInsecure: true } });
		closeActiveVaultSession();
		await bumpVaultFormat(vaultPath, "1.5");
		const shell2 = await freshShell();
		const entry = await shell2.openVault(vaultPath, { keystore: { forceInsecure: true } });
		expect(entry.format).toBe("1.5");
		shell2.closeActiveVaultSession();
	});
});
