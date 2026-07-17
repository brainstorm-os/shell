import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSqlcipherDb } from "../storage/at-rest-fake-driver";
import { AtRestMode } from "../storage/at-rest-mode";
import { removeTestDir } from "../test-support/remove-test-dir";

let USER_DATA_DIR = "";

vi.mock("electron", () => ({
	app: { getPath: () => USER_DATA_DIR },
}));

describe("vault.json atRestMode stamp + reconcile", () => {
	let workDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-vault-atrest-"));
		USER_DATA_DIR = workDir;
		vaultPath = join(workDir, "vault");
	});

	afterEach(async () => {
		await removeTestDir(workDir);
	});

	async function loadVaultModule(opts: { encryptedDriver: boolean }) {
		// Bust Vitest's module cache so each test starts from a clean
		// active-session slate (session.ts holds `let active = null` at
		// module scope; sqlite.ts/at-rest-mode.ts cache the resolved
		// driver + probe result — re-importing them is what reapplies the
		// test seams against the fresh module instance).
		vi.resetModules();
		const sqliteMod = await import("../storage/sqlite");
		const atRestMod = await import("../storage/at-rest-mode");
		sqliteMod.__setSqlcipherDriverForTests(
			opts.encryptedDriver ? (FakeSqlcipherDb as unknown as new (path: string) => never) : null,
		);
		atRestMod.__resetAtRestProbeForTests();
		const vaultMod = await import("./vault");
		const sessionMod = await import("./session");
		return {
			...vaultMod,
			closeActiveVaultSession: sessionMod.closeActiveVaultSession,
			getActiveVaultSession: sessionMod.getActiveVaultSession,
		};
	}

	it("createVault stamps atRestMode=plaintext when no SQLCipher driver is active", async () => {
		const { createVault, closeActiveVaultSession } = await loadVaultModule({
			encryptedDriver: false,
		});
		await createVault({ name: "Plain", path: vaultPath, keystore: { forceInsecure: true } });
		const raw = await readFile(join(vaultPath, "vault.json"), "utf8");
		const json = JSON.parse(raw) as { atRestMode?: string };
		expect(json.atRestMode).toBe(AtRestMode.Plaintext);
		closeActiveVaultSession();
	});

	it("createVault stamps atRestMode=encrypted when the SQLCipher fake is active", async () => {
		const { createVault, closeActiveVaultSession } = await loadVaultModule({
			encryptedDriver: true,
		});
		await createVault({ name: "Crypt", path: vaultPath, keystore: { forceInsecure: true } });
		const raw = await readFile(join(vaultPath, "vault.json"), "utf8");
		const json = JSON.parse(raw) as { atRestMode?: string };
		expect(json.atRestMode).toBe(AtRestMode.Encrypted);
		closeActiveVaultSession();
	});

	it("openVault on a legacy vault (no atRestMode field) first-stamps the probed mode", async () => {
		{
			const { createVault, closeActiveVaultSession } = await loadVaultModule({
				encryptedDriver: false,
			});
			await createVault({ name: "Legacy", path: vaultPath, keystore: { forceInsecure: true } });
			closeActiveVaultSession();
		}
		const path = join(vaultPath, "vault.json");
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		parsed.atRestMode = undefined;
		await writeFile(path, JSON.stringify(parsed), "utf8");

		const { openVault, closeActiveVaultSession } = await loadVaultModule({
			encryptedDriver: false,
		});
		await openVault(vaultPath, { keystore: { forceInsecure: true } });
		const after = JSON.parse(await readFile(path, "utf8")) as { atRestMode?: string };
		expect(after.atRestMode).toBe(AtRestMode.Plaintext);
		closeActiveVaultSession();
	});

	it("openVault refuses a recorded-encrypted vault when the driver is plaintext (fail-closed)", async () => {
		{
			const { createVault, closeActiveVaultSession } = await loadVaultModule({
				encryptedDriver: true,
			});
			await createVault({ name: "Crypt", path: vaultPath, keystore: { forceInsecure: true } });
			closeActiveVaultSession();
		}
		const { openVault } = await loadVaultModule({ encryptedDriver: false });
		await expect(openVault(vaultPath, { keystore: { forceInsecure: true } })).rejects.toThrow(
			/Refusing to open/,
		);
	});

	it("openVault on a recorded-plaintext vault with an active encrypted driver upgrades the stamp", async () => {
		{
			const { createVault, closeActiveVaultSession } = await loadVaultModule({
				encryptedDriver: false,
			});
			await createVault({ name: "Up", path: vaultPath, keystore: { forceInsecure: true } });
			closeActiveVaultSession();
		}
		const { openVault, closeActiveVaultSession } = await loadVaultModule({
			encryptedDriver: true,
		});
		await openVault(vaultPath, { keystore: { forceInsecure: true } });
		const after = JSON.parse(await readFile(join(vaultPath, "vault.json"), "utf8")) as {
			atRestMode?: string;
		};
		expect(after.atRestMode).toBe(AtRestMode.Encrypted);
		closeActiveVaultSession();
	});

	it("activateVault rejects a vault.json whose atRestMode value is non-canonical (silent-downgrade fix)", async () => {
		// Repro of the post-iteration code-review CONFIRMED defect: an
		// atRestMode value that fails isAtRestMode (wrong casing, typo)
		// previously slipped through `tryParseAtRestMode` as `undefined`,
		// so `reconcileAtRestMode(undefined, plaintext, …)` produced
		// FirstStamp and silently downgraded an encrypted vault. The fix
		// validates vault.json via isVaultJson (matching openVault), so
		// any non-canonical atRestMode now fails LOUDLY as malformed.
		let vaultId: string;
		{
			const { createVault, closeActiveVaultSession } = await loadVaultModule({
				encryptedDriver: true,
			});
			const entry = await createVault({
				name: "Crypt",
				path: vaultPath,
				keystore: { forceInsecure: true },
			});
			vaultId = entry.id;
			closeActiveVaultSession();
		}
		const vaultJsonPath = join(vaultPath, "vault.json");
		const parsed = JSON.parse(await readFile(vaultJsonPath, "utf8")) as Record<string, unknown>;
		parsed.atRestMode = "Encrypted"; // wrong case — not the canonical enum value
		await writeFile(vaultJsonPath, JSON.stringify(parsed), "utf8");

		const { activateVault } = await loadVaultModule({ encryptedDriver: false });
		await expect(activateVault(vaultId, { keystore: { forceInsecure: true } })).rejects.toThrow(
			/malformed/,
		);
	});

	it("activateVault rejects when atRestMode is structurally bogus (number, object) — symmetric malformed handling", async () => {
		// Belt-and-braces companion to the wrong-case test: a non-string
		// atRestMode (caused by a buggy writer or a corrupted blob) must
		// also fail loudly, not silently downgrade.
		let vaultId: string;
		{
			const { createVault, closeActiveVaultSession } = await loadVaultModule({
				encryptedDriver: true,
			});
			const entry = await createVault({
				name: "Bogus",
				path: vaultPath,
				keystore: { forceInsecure: true },
			});
			vaultId = entry.id;
			closeActiveVaultSession();
		}
		const vaultJsonPath = join(vaultPath, "vault.json");
		const parsed = JSON.parse(await readFile(vaultJsonPath, "utf8")) as Record<string, unknown>;
		parsed.atRestMode = 1;
		await writeFile(vaultJsonPath, JSON.stringify(parsed), "utf8");

		const { activateVault } = await loadVaultModule({ encryptedDriver: false });
		await expect(activateVault(vaultId, { keystore: { forceInsecure: true } })).rejects.toThrow(
			/malformed/,
		);
	});

	it("activateVault: vault.json rewrite failure does not leave an active session (partial-state fix)", async () => {
		// Repro of the post-iteration code-review CONFIRMED defect: the
		// stamp upgrade was sequenced AFTER setActiveVaultSession, so a
		// rewrite failure (disk full / EACCES) left a live session paired
		// with a rejected IPC call. The fix moves the rewrite BEFORE
		// setActiveVaultSession; a failed rewrite now unwinds cleanly with
		// no active session, mirroring openVault's ordering.
		let vaultId: string;
		{
			const { createVault, closeActiveVaultSession } = await loadVaultModule({
				encryptedDriver: false,
			});
			const entry = await createVault({
				name: "Plain",
				path: vaultPath,
				keystore: { forceInsecure: true },
			});
			vaultId = entry.id;
			closeActiveVaultSession();
		}
		// Make the vault.json read-only so the upgrade rewrite throws.
		const vaultJsonPath = join(vaultPath, "vault.json");
		await chmod(vaultJsonPath, 0o444);
		try {
			// Activate with the encrypted driver — reconcile=UpgradeReady
			// → rewriteVaultJsonAtRestMode runs → writeFile rejects with
			// EACCES on the read-only file → activateVault throws.
			const { activateVault, getActiveVaultSession } = await loadVaultModule({
				encryptedDriver: true,
			});
			await expect(activateVault(vaultId, { keystore: { forceInsecure: true } })).rejects.toThrow();
			expect(getActiveVaultSession()).toBeNull();
		} finally {
			// Restore so the afterEach cleanup can remove the temp dir.
			await chmod(vaultJsonPath, 0o644);
		}
	});

	it("openVault preserves unknown forward-compat fields when rewriting on stamp upgrade", async () => {
		{
			const { createVault, closeActiveVaultSession } = await loadVaultModule({
				encryptedDriver: false,
			});
			await createVault({
				name: "Forward",
				path: vaultPath,
				keystore: { forceInsecure: true },
			});
			closeActiveVaultSession();
		}
		const path = join(vaultPath, "vault.json");
		const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		parsed.unknownFutureField = { kind: "wallet-pubkey-v2", value: "abcd" };
		parsed.atRestMode = undefined;
		await writeFile(path, JSON.stringify(parsed), "utf8");

		const { openVault, closeActiveVaultSession } = await loadVaultModule({
			encryptedDriver: false,
		});
		await openVault(vaultPath, { keystore: { forceInsecure: true } });
		const after = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		expect(after.atRestMode).toBe(AtRestMode.Plaintext);
		expect(after.unknownFutureField).toEqual({ kind: "wallet-pubkey-v2", value: "abcd" });
		closeActiveVaultSession();
	});
});
