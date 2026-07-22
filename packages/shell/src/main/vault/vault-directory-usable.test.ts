import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtRestMode } from "@brainstorm-os/sqlite/at-rest-mode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";

let USER_DATA_DIR = "";

vi.mock("electron", () => ({
	app: { getPath: () => USER_DATA_DIR },
}));

describe("createVault target-folder usability", () => {
	let workDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-vault-usable-"));
		USER_DATA_DIR = workDir;
		vaultPath = join(workDir, "vault");
	});

	afterEach(async () => {
		await removeTestDir(workDir);
	});

	async function loadVaultModule() {
		vi.resetModules();
		const vaultMod = await import("./vault");
		const sessionMod = await import("./session");
		return {
			...vaultMod,
			closeActiveVaultSession: sessionMod.closeActiveVaultSession,
		};
	}

	it("creates a vault in a folder that only holds OS metadata (Windows Downloads desktop.ini)", async () => {
		await mkdir(vaultPath, { recursive: true });
		await writeFile(join(vaultPath, "desktop.ini"), "[.ShellClassInfo]\n", "utf8");
		await writeFile(join(vaultPath, "Thumbs.db"), "", "utf8");
		await writeFile(join(vaultPath, ".DS_Store"), "", "utf8");

		const { createVault, closeActiveVaultSession } = await loadVaultModule();
		await createVault({ name: "Downloads", path: vaultPath, keystore: { forceInsecure: true } });

		const raw = await readFile(join(vaultPath, "vault.json"), "utf8");
		const json = JSON.parse(raw) as { atRestMode?: string; name?: string };
		expect(json.name).toBe("Downloads");
		expect(json.atRestMode).toBe(AtRestMode.Plaintext);
		closeActiveVaultSession();
	});

	it("rejects a folder that holds real user content", async () => {
		await mkdir(vaultPath, { recursive: true });
		await writeFile(join(vaultPath, "report.pdf"), "%PDF-1.7\n", "utf8");

		const { createVault } = await loadVaultModule();
		await expect(
			createVault({ name: "Busy", path: vaultPath, keystore: { forceInsecure: true } }),
		).rejects.toThrow(/not empty/i);
	});
});
