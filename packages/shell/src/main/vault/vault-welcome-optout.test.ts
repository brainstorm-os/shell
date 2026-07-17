/**
 * Welcome-1b opt-out — declining starter content on the create-vault form
 * pre-stamps the welcome seed at the bundled version, so the vault-init seeder
 * (`seedWelcomeOnFreshVault`) reads "already seeded" and never plants the
 * starter set. The default (omitted / `true`) leaves the vault unstamped so the
 * seeder runs on first open.
 */

import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";
import { WELCOME_SEED_VERSION } from "../welcome/welcome-content";
import { WELCOME_SEED_FILENAME } from "../welcome/welcome-seed-store";

let USER_DATA_DIR = "";

vi.mock("electron", () => ({
	app: { getPath: () => USER_DATA_DIR },
}));

describe("createVault — Welcome-1b starter-content opt-out", () => {
	let workDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-welcome-optout-"));
		USER_DATA_DIR = workDir;
		vaultPath = join(workDir, "vault");
		vi.resetModules();
	});

	afterEach(async () => {
		const { closeActiveVaultSession } = await import("./session");
		closeActiveVaultSession();
		await removeTestDir(workDir);
	});

	function stampPath(): string {
		return join(vaultPath, "shell", WELCOME_SEED_FILENAME);
	}

	it("pre-stamps the welcome seed at the bundled version when opted out", async () => {
		const { createVault } = await import("./vault");
		await createVault({
			name: "NoSeed",
			path: vaultPath,
			seedStarterContent: false,
			keystore: { forceInsecure: true },
		});
		const raw = await readFile(stampPath(), "utf8");
		const json = JSON.parse(raw) as { seedVersion?: number };
		expect(json.seedVersion).toBe(WELCOME_SEED_VERSION);
	});

	it("leaves the vault unstamped by default (seeder runs on first open)", async () => {
		const { createVault } = await import("./vault");
		await createVault({ name: "Default", path: vaultPath, keystore: { forceInsecure: true } });
		await expect(access(stampPath())).rejects.toThrow();
	});

	it("leaves the vault unstamped when opting in explicitly", async () => {
		const { createVault } = await import("./vault");
		await createVault({
			name: "OptIn",
			path: vaultPath,
			seedStarterContent: true,
			keystore: { forceInsecure: true },
		});
		await expect(access(stampPath())).rejects.toThrow();
	});
});
