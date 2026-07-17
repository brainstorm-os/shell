/**
 * Iteration 12.8 — the registry-corruption "Add back" surface, main half.
 * Covers `salvageRegistryPaths` (best-effort path extraction from a possibly-
 * corrupt registry.json) and `scanForRecoveredVaults` (the orchestration that
 * feeds salvaged paths into the scanner and drops vaults already registered).
 *
 * `productionScanForVaults` is mocked so the filter + salvage logic is exercised
 * without touching the real default vault root (`defaultVaultRoot()` reads the
 * home directory, which a unit test must not depend on).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";
import type { VaultEntry } from "./registry";

vi.mock("electron", () => ({
	app: { getPath: () => USER_DATA_DIR },
}));

const scanMock = vi.fn<(knownPaths?: readonly string[]) => Promise<VaultEntry[]>>();
vi.mock("./registry-recovery", () => ({
	productionScanForVaults: (knownPaths?: readonly string[]) => scanMock(knownPaths),
}));

let USER_DATA_DIR = "";

const entry = (over: Partial<VaultEntry> = {}): VaultEntry => ({
	id: "vlt_x",
	name: "Vault X",
	color: "#6366f1",
	path: "/vaults/x",
	lastOpenedAt: 0,
	format: "1.0",
	...over,
});

beforeEach(async () => {
	USER_DATA_DIR = await mkdtemp(join(tmpdir(), "brainstorm-recovery-"));
	scanMock.mockReset();
});

afterEach(async () => {
	await removeTestDir(USER_DATA_DIR);
	vi.resetModules();
});

async function writeRegistryRaw(raw: string): Promise<void> {
	await writeFile(join(USER_DATA_DIR, "registry.json"), raw, "utf8");
}

describe("salvageRegistryPaths", () => {
	it("returns [] when the registry file is missing", async () => {
		const { salvageRegistryPaths } = await import("./registry");
		expect(await salvageRegistryPaths()).toEqual([]);
	});

	it("extracts paths from a structurally valid registry", async () => {
		await writeRegistryRaw(
			JSON.stringify({
				version: 1,
				vaults: [
					{ id: "a", path: "/vaults/a" },
					{ id: "b", path: "/vaults/b" },
				],
				defaultVaultId: "a",
			}),
		);
		const { salvageRegistryPaths } = await import("./registry");
		expect(await salvageRegistryPaths()).toEqual(["/vaults/a", "/vaults/b"]);
	});

	it("dedupes repeated paths", async () => {
		await writeRegistryRaw(
			JSON.stringify({
				vaults: [
					{ id: "a", path: "/dup" },
					{ id: "b", path: "/dup" },
				],
			}),
		);
		const { salvageRegistryPaths } = await import("./registry");
		expect(await salvageRegistryPaths()).toEqual(["/dup"]);
	});

	it("lenient-extracts paths from a truncated / malformed registry", async () => {
		// A half-written file: valid up to the first path, then garbage.
		await writeRegistryRaw('{"version":1,"vaults":[{"id":"a","path":"/vaults/a"},{"id":"b","pat');
		const { salvageRegistryPaths } = await import("./registry");
		expect(await salvageRegistryPaths()).toEqual(["/vaults/a"]);
	});

	it("decodes JSON escapes in salvaged paths", async () => {
		await writeRegistryRaw('garbage {"path": "/vaults/with\\"quote"} more garbage');
		const { salvageRegistryPaths } = await import("./registry");
		expect(await salvageRegistryPaths()).toEqual(['/vaults/with"quote']);
	});
});

describe("scanForRecoveredVaults", () => {
	it("drops vaults already in the registry, keeps the rest", async () => {
		await writeRegistryRaw(
			JSON.stringify({
				version: 1,
				vaults: [entry({ id: "registered", path: "/vaults/registered" })],
				defaultVaultId: "registered",
			}),
		);
		scanMock.mockResolvedValue([
			entry({ id: "registered", path: "/vaults/registered" }),
			entry({ id: "lost", path: "/vaults/lost" }),
		]);

		const { scanForRecoveredVaults } = await import("./vault");
		const recovered = await scanForRecoveredVaults();

		expect(recovered.map((v) => v.id)).toEqual(["lost"]);
	});

	it("feeds salvaged registry paths to the scanner as known paths", async () => {
		await writeRegistryRaw('{"vaults":[{"id":"a","path":"/known/a"}],"trailing');
		scanMock.mockResolvedValue([]);

		const { scanForRecoveredVaults } = await import("./vault");
		await scanForRecoveredVaults();

		expect(scanMock).toHaveBeenCalledWith(["/known/a"]);
	});

	it("returns every found vault when the registry is empty", async () => {
		scanMock.mockResolvedValue([entry({ id: "lost", path: "/vaults/lost" })]);

		const { scanForRecoveredVaults } = await import("./vault");
		const recovered = await scanForRecoveredVaults();

		expect(recovered.map((v) => v.id)).toEqual(["lost"]);
	});
});

describe("recoverCorruptVault", () => {
	it("throws when the vault id is not in the registry (nothing to recover)", async () => {
		await writeRegistryRaw(JSON.stringify({ version: 1, vaults: [], defaultVaultId: null }));
		const { recoverCorruptVault } = await import("./vault");
		await expect(recoverCorruptVault("vlt_missing", "entities")).rejects.toThrow(/not in registry/);
	});
});
