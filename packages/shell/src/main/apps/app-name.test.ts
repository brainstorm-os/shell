/**
 * `resolveAppName` caches for the process lifetime — so the cache must be
 * dropped when the thing it describes changes. The name reaches the
 * tool-approval prompt as "who is asking": a stale one would show an updated
 * app under its OLD name, and an uninstalled-then-replaced id under the name
 * of the app that used to hold it.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../storage/data-stores";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { resolveAppName } from "./app-name";
import { AppInstaller } from "./installer";
import type { AppManifest } from "./manifest";

const APP_ID = "io.example.renamed";
const manifest = (name: string, version: string): AppManifest => ({
	id: APP_ID,
	name,
	version,
	sdk: "1",
	entry: "dist/index.html",
	capabilities: [],
	registrations: {},
});

async function bundle(root: string, m: AppManifest): Promise<string> {
	const dir = join(root, m.version);
	await mkdir(join(dir, "dist"), { recursive: true });
	await writeFile(join(dir, "manifest.json"), JSON.stringify(m), "utf8");
	await writeFile(join(dir, "dist", "index.html"), "<!doctype html>", "utf8");
	return dir;
}

describe("resolveAppName cache", () => {
	let vaultDir: string;
	let sourceDir: string;
	let stores: DataStores;
	let installer: AppInstaller;
	let apps: AppsRepository;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-app-name-"));
		sourceDir = await mkdtemp(join(tmpdir(), "bs-app-name-src-"));
		stores = new DataStores(vaultDir);
		const registry = await stores.open("registry");
		installer = new AppInstaller(
			vaultDir,
			registry,
			new CapabilityLedger(await stores.open("ledger")),
		);
		apps = new AppsRepository(registry);
	});
	afterEach(async () => {
		stores.close();
		for (const dir of [vaultDir, sourceDir]) {
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
		}
	});

	it("an UPDATE that renames the app is seen on the next resolve", async () => {
		const first = await installer.install({
			bundleDir: await bundle(sourceDir, manifest("Old Name", "1.0.0")),
		});
		expect(first.ok).toBe(true);
		expect(resolveAppName(apps, APP_ID)).toBe("Old Name");

		const updated = await installer.update({
			bundleDir: await bundle(sourceDir, manifest("Notes", "1.1.0")),
		});
		expect(updated.ok).toBe(true);
		expect(resolveAppName(apps, APP_ID)).toBe("Notes");
	});

	it("an UNINSTALLED app no longer answers to its cached name", async () => {
		await installer.install({ bundleDir: await bundle(sourceDir, manifest("Ghost", "1.0.0")) });
		expect(resolveAppName(apps, APP_ID)).toBe("Ghost");
		const removed = await installer.uninstall(APP_ID);
		expect(removed.ok).toBe(true);
		expect(resolveAppName(apps, APP_ID)).toBe(APP_ID);
	});

	it("a reinstall under the same id is seen under its NEW name", async () => {
		await installer.install({ bundleDir: await bundle(sourceDir, manifest("First", "1.0.0")) });
		expect(resolveAppName(apps, APP_ID)).toBe("First");
		await installer.uninstall(APP_ID);
		await installer.install({ bundleDir: await bundle(sourceDir, manifest("Second", "2.0.0")) });
		expect(resolveAppName(apps, APP_ID)).toBe("Second");
	});
});
