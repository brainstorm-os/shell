import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityLedger } from "../capabilities/ledger";
import type { DashboardStore } from "../dashboard/dashboard-store";
import { DataStores } from "../storage/data-stores";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import type { FirstPartyApp } from "./first-party";
import { InstallOrigin, OFFICIAL_CATALOG_ID } from "./install-provenance";
import { AppInstaller } from "./installer";
import type { AppManifest } from "./manifest";
import { bootstrapApps } from "./seed-packaged-apps";

const FAKE_ALPHA: FirstPartyApp = {
	dir: "alpha",
	label: "Alpha",
	expectedAppId: "io.example.alpha",
};
const FAKE_BETA: FirstPartyApp = { dir: "beta", label: "Beta", expectedAppId: "io.example.beta" };
const fakeApps: FirstPartyApp[] = [FAKE_ALPHA, FAKE_BETA];

type AppOverrides = {
	version?: string;
	capabilities?: string[];
	/** Content written to `dist/index.html` — vary it to force a content-hash
	 *  change at the same version. */
	body?: string;
};

function manifestFor(app: FirstPartyApp, overrides: AppOverrides = {}): AppManifest {
	return {
		id: app.expectedAppId,
		name: app.label,
		version: overrides.version ?? "0.0.1",
		sdk: "1",
		entry: "dist/index.html",
		capabilities: overrides.capabilities ?? [],
		registrations: {},
	};
}

async function writePrebuiltApp(
	appsRoot: string,
	app: FirstPartyApp,
	overrides: AppOverrides = {},
): Promise<void> {
	const dir = join(appsRoot, app.dir);
	await mkdir(join(dir, "dist"), { recursive: true });
	await writeFile(
		join(dir, "manifest.json"),
		JSON.stringify(manifestFor(app, overrides), null, 2),
		"utf8",
	);
	await writeFile(
		join(dir, "dist", "index.html"),
		overrides.body ?? "<!doctype html><html></html>",
		"utf8",
	);
}

type FakeIcon = { x: number; y: number; kind: string; target: string; label: string };

/** Test shim: the `DashboardStore` methods consumed by the seeder
 *  (`snapshot` / `upsertIcon`) plus `batch` (the seeder now coalesces the
 *  per-app icon writes). `batch` just runs `fn` — the coalescing is covered
 *  by the real store's own test. Cast to the real type at the call site so
 *  the contract is checked but the unused methods stay un-implemented. */
function makeFakeDashboard(): DashboardStore {
	const icons: Record<string, FakeIcon> = {};
	const shim = {
		snapshot: () => ({ icons }),
		upsertIcon: (id: string, record: FakeIcon) => {
			icons[id] = record;
		},
		isAppIconDismissed: () => false,
		batch: <T>(fn: () => Promise<T> | T) => Promise.resolve(fn()),
	};
	return shim as unknown as DashboardStore;
}

async function setupHarness() {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-seed-pkg-vault-"));
	const appsRoot = await mkdtemp(join(tmpdir(), "bs-seed-pkg-root-"));
	const stores = new DataStores(vaultDir);
	const registry = await stores.open("registry");
	const ledgerDb = await stores.open("ledger");
	const ledger = new CapabilityLedger(ledgerDb);
	const installer = new AppInstaller(vaultDir, registry, ledger);
	const appsRepo = new AppsRepository(registry);
	const dashboard = makeFakeDashboard();
	return { vaultDir, appsRoot, stores, installer, appsRepo, ledger, dashboard };
}

describe("bootstrapApps", () => {
	let env: Awaited<ReturnType<typeof setupHarness>>;

	beforeEach(async () => {
		env = await setupHarness();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
		await rm(env.appsRoot, { recursive: true, force: true });
	});

	it("installs every first-party app on a fresh vault", async () => {
		for (const app of fakeApps) await writePrebuiltApp(env.appsRoot, app);
		const result = await bootstrapApps({
			appsRoot: env.appsRoot,
			appsRepo: env.appsRepo,
			installer: env.installer,
			dashboard: env.dashboard,
			apps: fakeApps,
		});
		expect(result.installed.sort()).toEqual(["io.example.alpha", "io.example.beta"]);
		expect(result.upgraded).toEqual([]);
		expect(result.skipped).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(env.appsRepo.getActive("io.example.alpha")).not.toBeNull();
		expect(env.appsRepo.getActive("io.example.beta")).not.toBeNull();
	});

	it("stamps bootstrap-cache provenance on installed apps (doc 59 / 14.30)", async () => {
		for (const app of fakeApps) await writePrebuiltApp(env.appsRoot, app);
		await bootstrapApps({
			appsRoot: env.appsRoot,
			appsRepo: env.appsRepo,
			installer: env.installer,
			dashboard: env.dashboard,
			apps: fakeApps,
		});
		const alpha = env.appsRepo.getActive("io.example.alpha");
		expect(alpha?.origin).toBe(InstallOrigin.BootstrapCache);
		expect(alpha?.catalogId).toBe(OFFICIAL_CATALOG_ID);
		expect(alpha?.channel).toBe(UpdateChannel.Stable);
	});

	it("skips apps that are already registered, returning them in the skipped list", async () => {
		for (const app of fakeApps) await writePrebuiltApp(env.appsRoot, app);
		// Pre-install alpha so the second call should skip it.
		await env.installer.install({ bundleDir: join(env.appsRoot, "alpha") });
		const result = await bootstrapApps({
			appsRoot: env.appsRoot,
			appsRepo: env.appsRepo,
			installer: env.installer,
			dashboard: env.dashboard,
			apps: fakeApps,
		});
		expect(result.skipped).toEqual(["io.example.alpha"]);
		expect(result.installed).toEqual(["io.example.beta"]);
		expect(result.upgraded).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("reads each bundle from <appsRoot>/<dir>", async () => {
		// Only write alpha; beta absent → install fails for beta.
		await writePrebuiltApp(env.appsRoot, FAKE_ALPHA);
		const result = await bootstrapApps({
			appsRoot: env.appsRoot,
			appsRepo: env.appsRepo,
			installer: env.installer,
			dashboard: env.dashboard,
			apps: fakeApps,
		});
		expect(result.installed).toEqual(["io.example.alpha"]);
		// beta has no bundle dir → install fails, surfaces in errors.
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("beta");
	});

	it("returns the install + skip lists shape on partial states", async () => {
		await writePrebuiltApp(env.appsRoot, FAKE_ALPHA);
		await writePrebuiltApp(env.appsRoot, FAKE_BETA);
		await env.installer.install({ bundleDir: join(env.appsRoot, "alpha") });
		const result = await bootstrapApps({
			appsRoot: env.appsRoot,
			appsRepo: env.appsRepo,
			installer: env.installer,
			dashboard: env.dashboard,
			apps: fakeApps,
		});
		expect(result).toMatchObject({
			installed: expect.any(Array),
			upgraded: expect.any(Array),
			skipped: expect.any(Array),
			errors: expect.any(Array),
		});
		expect(result.installed.length + result.skipped.length + result.upgraded.length).toBe(2);
	});

	it("isolates a failing install so siblings still install", async () => {
		await writePrebuiltApp(env.appsRoot, FAKE_ALPHA);
		// beta gets an invalid manifest — install fails but alpha goes through.
		const betaDir = join(env.appsRoot, FAKE_BETA.dir);
		await mkdir(betaDir, { recursive: true });
		await writeFile(join(betaDir, "manifest.json"), "{ not json", "utf8");
		const result = await bootstrapApps({
			appsRoot: env.appsRoot,
			appsRepo: env.appsRepo,
			installer: env.installer,
			dashboard: env.dashboard,
			apps: fakeApps,
		});
		expect(result.installed).toEqual(["io.example.alpha"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("beta");
	});

	it("throws an actionable error when appsRoot does not exist", async () => {
		const missing = join(env.appsRoot, "does-not-exist-xyz");
		await expect(
			bootstrapApps({
				appsRoot: missing,
				appsRepo: env.appsRepo,
				installer: env.installer,
				dashboard: env.dashboard,
				apps: fakeApps,
			}),
		).rejects.toThrow(/extraResources\/apps tree|does not exist/i);
	});

	describe("upgrade path (13.10)", () => {
		const onlyAlpha = [FAKE_ALPHA];

		async function seedOnce(): Promise<void> {
			await bootstrapApps({
				appsRoot: env.appsRoot,
				appsRepo: env.appsRepo,
				installer: env.installer,
				dashboard: env.dashboard,
				apps: onlyAlpha,
			});
		}

		function reseed() {
			return bootstrapApps({
				appsRoot: env.appsRoot,
				appsRepo: env.appsRepo,
				installer: env.installer,
				dashboard: env.dashboard,
				apps: onlyAlpha,
			});
		}

		it("upgrades an already-registered app when the manifest version bumps", async () => {
			await writePrebuiltApp(env.appsRoot, FAKE_ALPHA, { version: "0.0.1" });
			await seedOnce();
			expect(env.appsRepo.getActive("io.example.alpha")?.version).toBe("0.0.1");

			// Ship a higher version into the same appsRoot, then re-seed.
			await writePrebuiltApp(env.appsRoot, FAKE_ALPHA, { version: "0.1.0" });
			const result = await reseed();

			expect(result.upgraded).toEqual(["io.example.alpha"]);
			expect(result.installed).toEqual([]);
			expect(result.skipped).toEqual([]);
			expect(result.errors).toEqual([]);
			expect(env.appsRepo.getActive("io.example.alpha")?.version).toBe("0.1.0");
		});

		it("grants a newly-requested capability on upgrade", async () => {
			await writePrebuiltApp(env.appsRoot, FAKE_ALPHA, { version: "0.0.1", capabilities: [] });
			await seedOnce();
			expect(env.ledger.has("io.example.alpha", "mail.manage")).toBe(false);

			await writePrebuiltApp(env.appsRoot, FAKE_ALPHA, {
				version: "0.2.0",
				capabilities: ["mail.manage"],
			});
			const result = await reseed();

			expect(result.upgraded).toEqual(["io.example.alpha"]);
			expect(env.ledger.has("io.example.alpha", "mail.manage")).toBe(true);
		});

		it("skips an already-registered app whose bundle is byte-identical", async () => {
			await writePrebuiltApp(env.appsRoot, FAKE_ALPHA, { version: "0.0.1" });
			await seedOnce();

			// Re-seed with no change — no update should fire.
			const result = await reseed();
			expect(result.skipped).toEqual(["io.example.alpha"]);
			expect(result.upgraded).toEqual([]);
			expect(result.installed).toEqual([]);
			expect(result.errors).toEqual([]);
		});

		it("upgrades on a same-version content change (hash tiebreak)", async () => {
			await writePrebuiltApp(env.appsRoot, FAKE_ALPHA, { version: "0.0.1", body: "<html>v1</html>" });
			await seedOnce();
			const before = env.appsRepo.getActive("io.example.alpha")?.bundleSha256;

			// Same version, different bundle bytes — the content tiebreak fires.
			await writePrebuiltApp(env.appsRoot, FAKE_ALPHA, { version: "0.0.1", body: "<html>v2</html>" });
			const result = await reseed();

			expect(result.upgraded).toEqual(["io.example.alpha"]);
			expect(result.skipped).toEqual([]);
			const after = env.appsRepo.getActive("io.example.alpha")?.bundleSha256;
			expect(after).not.toBe(before);
			expect(env.appsRepo.getActive("io.example.alpha")?.version).toBe("0.0.1");
		});

		it("fresh-installs an unregistered app even while a sibling is unchanged", async () => {
			await writePrebuiltApp(env.appsRoot, FAKE_ALPHA, { version: "0.0.1" });
			await writePrebuiltApp(env.appsRoot, FAKE_BETA, { version: "0.0.1" });
			// Pre-install only alpha.
			await env.installer.install({ bundleDir: join(env.appsRoot, "alpha") });

			const result = await bootstrapApps({
				appsRoot: env.appsRoot,
				appsRepo: env.appsRepo,
				installer: env.installer,
				dashboard: env.dashboard,
				apps: fakeApps,
			});
			expect(result.installed).toEqual(["io.example.beta"]);
			expect(result.skipped).toEqual(["io.example.alpha"]);
			expect(result.upgraded).toEqual([]);
		});
	});
});
