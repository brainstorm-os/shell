import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FirstPartyApp } from "../apps/first-party";
import { AppInstaller } from "../apps/installer";
import type { AppManifest } from "../apps/manifest";
import { validateManifest } from "../apps/manifest";
import type { DashboardStore } from "../dashboard/dashboard-store";
import { DataStores } from "../storage/data-stores";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { FIRST_PARTY_APPS, installPrebuiltBundle } from "./seed-demo-apps";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

describe("FIRST_PARTY_APPS", () => {
	it("seeds the built apps (Notes → … → Mailbox) then the remaining coming-soon stubs — the pin order on the dashboard", () => {
		const ids = FIRST_PARTY_APPS.map((app) => app.expectedAppId);
		expect(ids).toEqual([
			// Built apps — lower-numbered grid cells, in pin order.
			"io.brainstorm.notes",
			"io.brainstorm.files",
			"io.brainstorm.database",
			"io.brainstorm.graph",
			"io.brainstorm.tasks",
			"io.brainstorm.calendar",
			"io.brainstorm.journal",
			"io.brainstorm.preview",
			"io.brainstorm.code-editor",
			"io.brainstorm.whiteboard",
			"io.brainstorm.bookmarks",
			// Graduated from stubs into real apps — pinned with the built set.
			"io.brainstorm.theme-editor",
			"io.brainstorm.contacts",
			"io.brainstorm.automations",
			"io.brainstorm.mailbox",
			"io.brainstorm.browser",
			"io.brainstorm.books",
			"io.brainstorm.chat",
			// Still coming-soon stubs (placeholder body), registered + launchable.
			"io.brainstorm.form-designer",
			"io.brainstorm.agent",
		]);
	});

	for (const app of FIRST_PARTY_APPS) {
		it(`points at a real apps/${app.dir}/manifest.json declaring ${app.expectedAppId}`, () => {
			const manifestPath = join(REPO_ROOT, "apps", app.dir, "manifest.json");
			const raw = readFileSync(manifestPath, "utf8");
			const parsed = JSON.parse(raw);
			const result = validateManifest(parsed);
			if (!result.ok) {
				throw new Error(`apps/${app.dir}/manifest.json invalid: ${result.reason} at ${result.path}`);
			}
			expect(result.manifest.id).toBe(app.expectedAppId);
		});
	}
});

const fakeManifest: AppManifest = {
	id: "io.example.fake",
	name: "Fake",
	version: "0.0.1",
	sdk: "1",
	entry: "dist/index.html",
	capabilities: [],
	registrations: {},
};

const fakeApp: FirstPartyApp = {
	dir: "fake",
	label: "Fake",
	expectedAppId: "io.example.fake",
};

type FakeIcon = { x: number; y: number; kind: string; target: string; label: string };

/** Test shim: only the `DashboardStore` methods consumed by
 *  `installPrebuiltBundle` (`snapshot` / `upsertIcon` / `isAppIconDismissed`)
 *  are populated. Cast to the real type at the call site so the contract is
 *  checked, but the unused methods stay un-implemented. */
function makeFakeDashboard(): DashboardStore {
	const icons: Record<string, FakeIcon> = {};
	const shim = {
		snapshot: () => ({ icons }),
		upsertIcon: (id: string, record: FakeIcon) => {
			icons[id] = record;
		},
		isAppIconDismissed: () => false,
	};
	return shim as unknown as DashboardStore;
}

async function setupHarness() {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-seed-prebuilt-"));
	const bundleSrc = await mkdtemp(join(tmpdir(), "bs-seed-bundle-"));
	await writeFile(join(bundleSrc, "manifest.json"), JSON.stringify(fakeManifest, null, 2), "utf8");
	await mkdir(join(bundleSrc, "dist"), { recursive: true });
	await writeFile(join(bundleSrc, "dist", "index.html"), "<!doctype html>", "utf8");
	const stores = new DataStores(vaultDir);
	const registry = await stores.open("registry");
	const ledgerDb = await stores.open("ledger");
	const ledger = new CapabilityLedger(ledgerDb);
	const installer = new AppInstaller(vaultDir, registry, ledger);
	const appsRepo = new AppsRepository(registry);
	const dashboard = makeFakeDashboard();
	return { vaultDir, bundleSrc, stores, installer, appsRepo, dashboard };
}

describe("installPrebuiltBundle", () => {
	let env: Awaited<ReturnType<typeof setupHarness>>;

	beforeEach(async () => {
		env = await setupHarness();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
		await rm(env.bundleSrc, { recursive: true, force: true });
	});

	it("installs a fresh bundle without spawning a vite build", async () => {
		// Sentinel: assert no `bun run build` child is spawned. We can't
		// easily intercept child_process from here, but the test exercises
		// the install end-to-end and the bundle is a one-file stub — a
		// rogue vite spawn against an empty `src/` would explode with a
		// non-zero exit, and `installPrebuiltBundle` never invokes
		// `buildVitebundle` in the first place (separate function).
		const result = await installPrebuiltBundle(fakeApp, env.bundleSrc, {
			installer: env.installer,
			appsRepo: env.appsRepo,
			dashboard: env.dashboard,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.id).toBe("io.example.fake");
		expect(result.pinned).toBe(true);
		expect(env.appsRepo.getActive("io.example.fake")).not.toBeNull();
	});

	it("skips (unchanged: true) when the registered bundle content is identical", async () => {
		const first = await installPrebuiltBundle(fakeApp, env.bundleSrc, {
			installer: env.installer,
			appsRepo: env.appsRepo,
			dashboard: env.dashboard,
		});
		expect(first.ok).toBe(true);
		const before = env.appsRepo.getActive("io.example.fake");
		const second = await installPrebuiltBundle(fakeApp, env.bundleSrc, {
			installer: env.installer,
			appsRepo: env.appsRepo,
			dashboard: env.dashboard,
		});
		expect(second.ok && second.unchanged).toBe(true);
		// The registry row survives untouched — no uninstall/reinstall churn
		// (the churn is what made dashboard icons flash lettered fallbacks
		// on every dev boot).
		expect(env.appsRepo.getActive("io.example.fake")).toEqual(before);
	});

	it("re-installs (uninstall + install) when the registered bundle content changed", async () => {
		const first = await installPrebuiltBundle(fakeApp, env.bundleSrc, {
			installer: env.installer,
			appsRepo: env.appsRepo,
			dashboard: env.dashboard,
		});
		expect(first.ok).toBe(true);
		await writeFile(join(env.bundleSrc, "dist", "index.html"), "<!doctype html>v2", "utf8");
		const second = await installPrebuiltBundle(fakeApp, env.bundleSrc, {
			installer: env.installer,
			appsRepo: env.appsRepo,
			dashboard: env.dashboard,
		});
		expect(second.ok).toBe(true);
		expect(second.ok && second.unchanged).toBeFalsy();
		expect(env.appsRepo.getActive("io.example.fake")).not.toBeNull();
	});

	it("returns an error result when the bundle manifest is invalid", async () => {
		await writeFile(join(env.bundleSrc, "manifest.json"), "{ not json", "utf8");
		const result = await installPrebuiltBundle(fakeApp, env.bundleSrc, {
			installer: env.installer,
			appsRepo: env.appsRepo,
			dashboard: env.dashboard,
		});
		expect(result.ok).toBe(false);
	});
});
