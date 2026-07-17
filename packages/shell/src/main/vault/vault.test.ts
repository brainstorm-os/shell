import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";

vi.mock("electron", () => ({
	app: {
		getPath: () => USER_DATA_DIR,
	},
}));

let USER_DATA_DIR = "";

describe("activateVault", () => {
	let registryDir: string;
	let missingVaultPath: string;

	beforeEach(async () => {
		registryDir = await mkdtemp(join(tmpdir(), "brainstorm-activate-"));
		USER_DATA_DIR = registryDir;
		missingVaultPath = join(registryDir, "ghost-vault");
		const registry = {
			version: 1,
			vaults: [
				{
					id: "vlt_ghost",
					name: "Ghost",
					color: "#7c3aed",
					path: missingVaultPath,
					lastOpenedAt: 0,
					format: "1.0",
				},
			],
			defaultVaultId: "vlt_ghost",
		};
		await writeFile(join(registryDir, "registry.json"), JSON.stringify(registry), "utf8");
	});

	afterEach(async () => {
		await removeTestDir(registryDir);
	});

	it("drops the entry from the registry when the vault folder is gone", async () => {
		const { activateVault } = await import("./vault");
		const { readRegistry } = await import("./registry");

		await expect(activateVault("vlt_ghost")).rejects.toThrow(/no longer exists/);

		const registry = await readRegistry();
		expect(registry.vaults).toEqual([]);
		expect(registry.defaultVaultId).toBeNull();
	});
});
