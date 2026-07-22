import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileHandleMode } from "../../files/file-handle-registry";
import { DataStores } from "../data-stores";
import { FileWatchGrantsRepository } from "./file-watch-grants-repo";

const APP = "io.brainstorm.automations";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-fwgrants-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("registry");
	let n = 0;
	const repo = new FileWatchGrantsRepository(
		db,
		() => 1000,
		() => `fw_test_${n++}`,
	);
	return { vaultDir, stores, repo };
}

describe("FileWatchGrantsRepository (11b.10)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		await env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("mints a grant and resolves it shell-internally (path included)", () => {
		const watchId = env.repo.mint(APP, "/tmp/report.csv", FileHandleMode.Read);
		const grant = env.repo.resolve(watchId, APP);
		expect(grant).toEqual({
			watchId,
			appId: APP,
			path: "/tmp/report.csv",
			mode: FileHandleMode.Read,
			createdAt: 1000,
		});
	});

	it("is idempotent — re-granting the same (app, path, mode) returns the same id", () => {
		const a = env.repo.mint(APP, "/tmp/a.txt", FileHandleMode.Read);
		const b = env.repo.mint(APP, "/tmp/a.txt", FileHandleMode.Read);
		expect(a).toBe(b);
	});

	it("resolve fails closed on unknown / cross-app watchId", () => {
		const watchId = env.repo.mint(APP, "/tmp/a.txt", FileHandleMode.Read);
		expect(env.repo.resolve("fw_nope", APP)).toBeNull();
		expect(env.repo.resolve(watchId, "io.other.app")).toBeNull();
	});

	it("lists app grants with displayName only (no path leaks)", () => {
		env.repo.mint(APP, "/home/user/secret/report.csv", FileHandleMode.Read);
		const list = env.repo.listByApp(APP);
		expect(list).toHaveLength(1);
		expect(list[0]?.displayName).toBe("report.csv");
		expect(JSON.stringify(list)).not.toContain("/home/user/secret");
	});

	it("revoke removes the grant (resolve then fails closed)", () => {
		const watchId = env.repo.mint(APP, "/tmp/a.txt", FileHandleMode.Read);
		expect(env.repo.revoke(watchId)).toBe(true);
		expect(env.repo.resolve(watchId, APP)).toBeNull();
		expect(env.repo.revoke(watchId)).toBe(false);
	});
});
