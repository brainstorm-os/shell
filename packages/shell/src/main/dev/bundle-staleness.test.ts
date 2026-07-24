import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBundleBuildStale } from "./bundle-staleness";

let root = "";
let appDir = "";
let sharedDir = "";

/** Write `file` and stamp it at `whenSec` so mtime ordering is deterministic
 *  (a same-millisecond write would make "newer" ambiguous). */
async function writeAt(file: string, whenSec: number): Promise<void> {
	await writeFile(file, "x", "utf8");
	await utimes(file, whenSec, whenSec);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bs-staleness-"));
	appDir = join(root, "app");
	sharedDir = join(root, "packages", "sdk", "src");
	await mkdir(join(appDir, "src"), { recursive: true });
	await mkdir(join(appDir, "dist"), { recursive: true });
	await mkdir(sharedDir, { recursive: true });
	await writeAt(join(appDir, "src", "app.tsx"), 1_000);
	await writeAt(join(sharedDir, "index.ts"), 1_000);
	await writeAt(join(appDir, "dist", "index.js"), 2_000); // built after sources
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("isBundleBuildStale — the dev-boot build gate", () => {
	it("is fresh when dist is newer than every input (the common boot)", () => {
		expect(isBundleBuildStale({ appBundleDir: appDir, sharedSourceRoots: [sharedDir] })).toBe(false);
	});

	it("is stale when the app's own source changed", async () => {
		await writeAt(join(appDir, "src", "app.tsx"), 3_000);
		expect(isBundleBuildStale({ appBundleDir: appDir, sharedSourceRoots: [sharedDir] })).toBe(true);
	});

	it("is stale when a SHARED package changed — every app compiles it in", async () => {
		await writeAt(join(sharedDir, "index.ts"), 3_000);
		expect(isBundleBuildStale({ appBundleDir: appDir, sharedSourceRoots: [sharedDir] })).toBe(true);
	});

	it("is stale when the manifest changed (not just src/)", async () => {
		await writeAt(join(appDir, "manifest.json"), 3_000);
		expect(isBundleBuildStale({ appBundleDir: appDir })).toBe(true);
	});

	it("is stale when there is no dist at all", async () => {
		await rm(join(appDir, "dist"), { recursive: true, force: true });
		expect(isBundleBuildStale({ appBundleDir: appDir })).toBe(true);
	});

	it("is stale for an empty dist (a half-finished build leaves one behind)", async () => {
		await rm(join(appDir, "dist"), { recursive: true, force: true });
		await mkdir(join(appDir, "dist"), { recursive: true });
		expect(isBundleBuildStale({ appBundleDir: appDir })).toBe(true);
	});

	it("ignores node_modules churn inside the bundle", async () => {
		await mkdir(join(appDir, "node_modules", "dep"), { recursive: true });
		await writeAt(join(appDir, "node_modules", "dep", "index.js"), 9_000);
		expect(isBundleBuildStale({ appBundleDir: appDir })).toBe(false);
	});

	it("fails safe: an unreadable bundle directory rebuilds rather than skipping", () => {
		expect(isBundleBuildStale({ appBundleDir: join(root, "does-not-exist") })).toBe(true);
	});
});
