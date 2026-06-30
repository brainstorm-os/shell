/**
 * 14.34 — end-to-end catalog UPDATE pipeline. Installs v1 from the catalog, then
 * bumps the catalog to v2 and drives UpdateEngine: classify by capability delta,
 * then apply through the REAL AppInstaller.update. Proves the app-update plane
 * (first-party apps update from the catalog, independent of the shell binary)
 * with real crypto + real bundles + the real installer.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519GetPublicKey, ed25519Sign } from "@brainstorm/native";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpdateChannel } from "../../shared/update-wire-types";
import { InstallOrigin } from "../apps/install-provenance";
import { AppInstaller } from "../apps/installer";
import { CapabilityLedger } from "../capabilities/ledger";
import { DataStores } from "../storage/data-stores";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import {
	bundleSha256Hex,
	unpackBrainstormBundleToDir,
	verifyBundleSignature,
} from "./brainstorm-package";
import { CatalogClient, type CatalogTrustedKeys, InMemoryCatalogCache } from "./catalog-client";
import { buildPublishedBundle, publisherKeyForSeed, readAppBundleFiles } from "./catalog-publish";
import type { CatalogIndex, SignedCatalog } from "./catalog-wire-types";
import { InstallEngine, InstallOutcome } from "./install-engine";
import { UpdateClassification, UpdateEngine, UpdateOutcome } from "./update-engine";
import { type InstalledForUpdate, planCatalogUpdates } from "./update-planning";

const PUBLISHER_SEED = new Uint8Array(32).fill(11);
const INDEX_SEED = new Uint8Array(32).fill(9);
const KID = "catalog-k1";
const APP_ID = "io.example.updateapp";
const PUBLISHER_KEY = publisherKeyForSeed(PUBLISHER_SEED);

async function packVersion(
	version: string,
	capabilities: string[],
): Promise<{ bytes: Uint8Array; sha256: string; signature: string }> {
	const dir = await mkdtemp(join(tmpdir(), "bs-upd-src-"));
	await mkdir(join(dir, "dist"), { recursive: true });
	await writeFile(
		join(dir, "manifest.json"),
		JSON.stringify({
			id: APP_ID,
			name: "Update App",
			version,
			sdk: "1",
			entry: "dist/index.html",
			capabilities,
			registrations: {},
		}),
	);
	await writeFile(join(dir, "dist", "index.html"), `<!doctype html><html>v${version}</html>`);
	const published = buildPublishedBundle(await readAppBundleFiles(dir), PUBLISHER_SEED);
	await rm(dir, { recursive: true, force: true });
	return published;
}

function signIndex(index: CatalogIndex): SignedCatalog {
	const payload = Buffer.from(JSON.stringify(index)).toString("base64url");
	const sig = ed25519Sign(INDEX_SEED, new TextEncoder().encode(payload));
	return { payload, kid: KID, signature: Buffer.from(sig).toString("base64url") };
}

function trustedKeys(): CatalogTrustedKeys {
	return new Map([[KID, ed25519GetPublicKey(INDEX_SEED)]]);
}

function indexFor(version: string, sha256: string, signature: string): CatalogIndex {
	return {
		catalogId: "brainstorm-official",
		generatedAt: 1,
		ttlSeconds: 3600,
		listings: [
			{
				id: APP_ID,
				kind: "app",
				publisherKey: PUBLISHER_KEY,
				name: "Update App",
				channels: { stable: version },
				versions: {
					[version]: {
						manifestUrl: `http://cat.test/${APP_ID}/manifest.json`,
						bundleUrl: `http://cat.test/${APP_ID}-${version}.brainstorm`,
						sha256,
						signature,
						sdk: "1",
						minShell: "1.0.0",
					},
				},
				firstParty: false,
			},
		],
	};
}

async function catalogWith(index: CatalogIndex): Promise<CatalogClient> {
	const cache = new InMemoryCatalogCache();
	const envelope = signIndex(index);
	const client = new CatalogClient({
		fetchIndexJson: async () => envelope,
		trustedKeys: trustedKeys(),
		cache,
	});
	await client.refresh();
	return client;
}

describe("catalog update pipeline (end-to-end)", () => {
	let vaultDir: string;
	let stores: DataStores;
	let installer: AppInstaller;
	let appsRepo: AppsRepository;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-upd-vault-"));
		stores = new DataStores(vaultDir);
		const registry = await stores.open("registry");
		const ledger = new CapabilityLedger(await stores.open("ledger"));
		installer = new AppInstaller(vaultDir, registry, ledger);
		appsRepo = new AppsRepository(registry);
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	function unpack() {
		return async (bytes: Uint8Array) =>
			unpackBrainstormBundleToDir(bytes, await mkdtemp(join(tmpdir(), "bs-upd-stage-")));
	}

	async function installV1(): Promise<void> {
		const v1 = await packVersion("1.0.0", []);
		const catalog = await catalogWith(indexFor("1.0.0", v1.sha256, v1.signature));
		const engine = new InstallEngine({
			catalog,
			installer,
			download: async () => v1.bytes,
			sha256Hex: bundleSha256Hex,
			verifyBundle: verifyBundleSignature,
			unpack: unpack(),
		});
		const r = await engine.install(APP_ID, UpdateChannel.Stable);
		expect(r.outcome).toBe(InstallOutcome.Installed);
	}

	function installed(): InstalledForUpdate[] {
		return appsRepo.listActive().map((r) => ({
			id: r.id,
			version: r.version,
			channel: r.channel,
			catalogTracked: r.origin === InstallOrigin.BootstrapCache || r.origin === InstallOrigin.Catalog,
			publisherKey: r.publisherKey,
		}));
	}

	function updateEngine(catalog: CatalogClient, newCaps: string[]): UpdateEngine {
		return new UpdateEngine({
			catalog,
			installer,
			listInstalled: () => installed(),
			installedCapabilities: () => [],
			fetchCapabilities: async () => newCaps,
			autoUpdate: () => true,
			download: async () => updateBytes,
			sha256Hex: bundleSha256Hex,
			verifyBundle: verifyBundleSignature,
			unpack: unpack(),
		});
	}

	let updateBytes: Uint8Array;

	it("plans + applies a no-new-capability update through the real installer (Auto)", async () => {
		await installV1();
		const v2 = await packVersion("2.0.0", []);
		updateBytes = v2.bytes;
		const catalog = await catalogWith(indexFor("2.0.0", v2.sha256, v2.signature));

		// planning sees the newer version
		const cachedIndex = catalog.cachedIndex();
		if (!cachedIndex) throw new Error("expected a cached catalog index");
		const candidates = planCatalogUpdates(installed(), cachedIndex);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.toVersion).toBe("2.0.0");

		const engine = updateEngine(catalog, []); // v2 caps == v1 caps → Auto
		const checked = await engine.check();
		expect(checked[0]?.classification).toBe(UpdateClassification.Auto);

		const applied = await engine.applyAuto();
		expect(applied[0]?.outcome).toBe(UpdateOutcome.Updated);

		const row = appsRepo.getActive(APP_ID);
		expect(row?.version).toBe("2.0.0");
		expect(row?.origin).toBe(InstallOrigin.Catalog);
		expect(row?.catalogVersion).toBe("2.0.0");
	});

	it("classifies a capability-adding update as NeedsConsent and does not auto-apply it", async () => {
		await installV1();
		const v2 = await packVersion("2.0.0", ["storage.kv"]);
		updateBytes = v2.bytes;
		const catalog = await catalogWith(indexFor("2.0.0", v2.sha256, v2.signature));

		const engine = updateEngine(catalog, ["storage.kv"]); // v2 adds a cap
		const checked = await engine.check();
		expect(checked[0]?.classification).toBe(UpdateClassification.NeedsConsent);
		expect(checked[0]?.newCapabilities).toEqual(["storage.kv"]);

		// auto-update skips it; the app stays at v1 until explicit consent
		expect(await engine.applyAuto()).toEqual([]);
		expect(appsRepo.getActive(APP_ID)?.version).toBe("1.0.0");

		// explicit apply (post-consent) updates it
		const [consentCandidate] = checked;
		if (!consentCandidate) throw new Error("expected a checked update candidate");
		const applied = await engine.apply(consentCandidate);
		expect(applied.outcome).toBe(UpdateOutcome.Updated);
		expect(appsRepo.getActive(APP_ID)?.version).toBe("2.0.0");
	});
});
