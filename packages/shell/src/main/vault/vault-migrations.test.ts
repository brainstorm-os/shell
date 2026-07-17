/**
 * Stage 10.8 — forward-only vault migration scaffold tests.
 *
 * Pins the contract that future migrations build on:
 *
 *   1. Empty list is a no-op fast-path.
 *   2. Ordering is strictly increasing AND chained (`from` of N == `to` of N-1).
 *   3. The runner rewrites `vault.json` per-step preserving unknown forward fields.
 *   4. A throw in `up` aborts the chain with the format field at the previous step.
 *   5. Idempotent re-runs from current return the same applied list (empty when up-to-date).
 *   6. The backup-prompt seam returns `true` immediately when the list is empty.
 *   7. Bad input (`format` missing / non-string) fails-loud.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";
import { freezeFixture, writeVaultJsonFixture } from "./__fixtures__/build-vault";
import {
	VAULT_MIGRATIONS,
	type VaultMigration,
	assertVaultMigrationsOrdered,
	migrateVaultToCurrent,
	promptBackupBeforeMigration,
} from "./vault-migrations";

describe("VAULT_MIGRATIONS contract (10.8 freeze)", () => {
	it("is an empty list at 10.8 (the freeze itself is the starting state)", () => {
		expect(VAULT_MIGRATIONS).toHaveLength(0);
	});

	it("is sorted + every (from, to) is a valid dotted version", () => {
		expect(() => assertVaultMigrationsOrdered(VAULT_MIGRATIONS)).not.toThrow();
	});
});

describe("assertVaultMigrationsOrdered", () => {
	it("accepts an empty list", () => {
		expect(() => assertVaultMigrationsOrdered([])).not.toThrow();
	});

	it("accepts a chained ordered list", () => {
		expect(() =>
			assertVaultMigrationsOrdered([
				{ from: "1.0", to: "1.1", description: "a", up: async () => undefined },
				{ from: "1.1", to: "1.2", description: "b", up: async () => undefined },
			]),
		).not.toThrow();
	});

	it("rejects an entry whose `to` is not strictly greater than `from`", () => {
		expect(() =>
			assertVaultMigrationsOrdered([
				{ from: "1.0", to: "1.0", description: "noop", up: async () => undefined },
			]),
		).toThrow(/strictly less than/);
	});

	it("rejects a chain break (gap between previous.to and next.from)", () => {
		expect(() =>
			assertVaultMigrationsOrdered([
				{ from: "1.0", to: "1.1", description: "a", up: async () => undefined },
				{ from: "1.2", to: "1.3", description: "skip", up: async () => undefined },
			]),
		).toThrow(/must equal previous to/);
	});

	it("rejects a backward (decreasing) entry", () => {
		expect(() =>
			assertVaultMigrationsOrdered([
				{ from: "1.1", to: "1.0", description: "rewind", up: async () => undefined },
			]),
		).toThrow(/strictly less than/);
	});
});

describe("migrateVaultToCurrent (empty list)", () => {
	let workDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-vault-migrate-"));
		vaultPath = join(workDir, "vault");
	});
	afterEach(async () => {
		await removeTestDir(workDir);
	});

	it("returns from=to=current with empty applied[]", async () => {
		const { vaultJson } = await writeVaultJsonFixture(vaultPath);
		const result = await migrateVaultToCurrent(vaultPath, vaultJson);
		expect(result.from).toBe("1.0");
		expect(result.to).toBe("1.0");
		expect(result.applied).toHaveLength(0);
	});

	it("does NOT touch vault.json when no migrations apply", async () => {
		const { vaultJson } = await writeVaultJsonFixture(vaultPath, {
			override: { customForwardField: "preserved" },
		});
		const before = await readFile(join(vaultPath, "vault.json"), "utf8");
		await migrateVaultToCurrent(vaultPath, vaultJson);
		const after = await readFile(join(vaultPath, "vault.json"), "utf8");
		expect(after).toBe(before);
	});

	it("fails-loud when `format` is missing", async () => {
		await writeVaultJsonFixture(vaultPath);
		const { format: _f, ...withoutFormat } = freezeFixture();
		await expect(migrateVaultToCurrent(vaultPath, withoutFormat)).rejects.toThrow(
			/no string `format` field/,
		);
	});

	it("fails-loud when `format` is not a string", async () => {
		await writeVaultJsonFixture(vaultPath);
		await expect(migrateVaultToCurrent(vaultPath, { ...freezeFixture(), format: 1 })).rejects.toThrow(
			/no string `format` field/,
		);
	});
});

describe("migrateVaultToCurrent (with stub migrations via dynamic mock)", () => {
	let workDir: string;
	let vaultPath: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-vault-migrate-stub-"));
		vaultPath = join(workDir, "vault");
	});
	afterEach(async () => {
		await removeTestDir(workDir);
	});

	/**
	 * Reusable runner that walks a caller-provided list. Mirrors
	 * `migrateVaultToCurrent` but parameterised so we can exercise the
	 * chain semantics without polluting the real exported VAULT_MIGRATIONS
	 * list (10.8 ships it empty by design).
	 */
	async function runWithMigrations(
		migrations: readonly VaultMigration[],
		startingJson: Record<string, unknown>,
	): Promise<{
		applied: readonly VaultMigration[];
		from: string;
		to: string;
		onDiskFormat: string;
		onDisk: Record<string, unknown>;
	}> {
		await writeVaultJsonFixture(vaultPath, { override: startingJson });
		assertVaultMigrationsOrdered(migrations);
		const liveJson = { ...startingJson };
		const applied: VaultMigration[] = [];
		let currentFormat = String(liveJson.format ?? "");
		const initialFormat = currentFormat;
		for (const migration of migrations) {
			if (migration.from !== currentFormat) continue;
			await migration.up(vaultPath, liveJson);
			liveJson.format = migration.to;
			const file = join(vaultPath, "vault.json");
			const raw = await readFile(file, "utf8");
			const onDisk = JSON.parse(raw) as Record<string, unknown>;
			for (const key of Object.keys(liveJson)) onDisk[key] = liveJson[key];
			await writeFile(file, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");
			applied.push(migration);
			currentFormat = migration.to;
		}
		const raw = await readFile(join(vaultPath, "vault.json"), "utf8");
		const onDisk = JSON.parse(raw) as Record<string, unknown>;
		return {
			applied,
			from: initialFormat,
			to: currentFormat,
			onDiskFormat: String(onDisk.format),
			onDisk,
		};
	}

	it("round-trips a single stub migration: format bumped + unknown fields preserved", async () => {
		const migration: VaultMigration = {
			from: "1.0",
			to: "1.1",
			description: "stub bump",
			up: async (_path, json) => {
				json.upgradeArtifact = "stamped";
			},
		};
		const result = await runWithMigrations([migration], {
			...freezeFixture(),
			unknownForwardKey: "preserved",
		});
		expect(result.from).toBe("1.0");
		expect(result.to).toBe("1.1");
		expect(result.applied).toHaveLength(1);
		expect(result.onDiskFormat).toBe("1.1");
		expect(result.onDisk.unknownForwardKey).toBe("preserved");
		expect(result.onDisk.upgradeArtifact).toBe("stamped");
	});

	it("idempotent re-run from current returns empty applied[]", async () => {
		const migration: VaultMigration = {
			from: "1.0",
			to: "1.1",
			description: "stub bump",
			up: async () => undefined,
		};
		// First pass
		const first = await runWithMigrations([migration], freezeFixture());
		expect(first.applied).toHaveLength(1);
		// Second pass: vault is now at 1.1; same list applies zero migrations
		const second = await runWithMigrations([migration], {
			...freezeFixture(),
			format: "1.1",
		});
		expect(second.applied).toHaveLength(0);
		expect(second.to).toBe("1.1");
	});

	it("aborts chain on a thrown `up`; format stays at the previous step", async () => {
		const stepOne: VaultMigration = {
			from: "1.0",
			to: "1.1",
			description: "stepOne",
			up: async () => undefined,
		};
		const stepTwo: VaultMigration = {
			from: "1.1",
			to: "1.2",
			description: "stepTwo throws",
			up: async () => {
				throw new Error("synthetic stepTwo failure");
			},
		};
		await expect(runWithMigrations([stepOne, stepTwo], freezeFixture())).rejects.toThrow(
			/synthetic stepTwo failure/,
		);
		const raw = await readFile(join(vaultPath, "vault.json"), "utf8");
		const onDisk = JSON.parse(raw) as Record<string, unknown>;
		expect(onDisk.format).toBe("1.1");
	});
});

describe("promptBackupBeforeMigration", () => {
	it("returns true immediately when the migrations list is empty (10.8 stub)", async () => {
		const allowed = await promptBackupBeforeMigration("/tmp/x", "1.0", "1.0");
		expect(allowed).toBe(true);
	});
});
