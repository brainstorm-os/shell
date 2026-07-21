/**
 * 14.34 — end-to-end catalog install pipeline. Exercises the whole client chain
 * with REAL crypto + REAL bundles + the REAL installer, in-process (per
 * CLAUDE.md §Reproduce before you patch): pack+sign an app → a signed catalog
 * index → CatalogClient verifies the index → InstallEngine downloads, gates on
 * sha256 + Ed25519, unpacks, and hands it to AppInstaller → a real registry row.
 *
 * This is the verification floor for the catalog vertical: if this is green, the
 * shell wiring is glue over a proven chain.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519GetPublicKey, ed25519Sign } from "@brainstorm-os/native";
import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const PUBLISHER_SEED = new Uint8Array(32).fill(11);
const INDEX_SEED = new Uint8Array(32).fill(9);
const KID = "catalog-k1";
const APP_ID = "io.example.catalogapp";

async function writeFakeApp(dir: string): Promise<void> {
	await mkdir(join(dir, "dist"), { recursive: true });
	await writeFile(
		join(dir, "manifest.json"),
		JSON.stringify({
			id: APP_ID,
			name: "Catalog App",
			version: "1.0.0",
			sdk: "1",
			entry: "dist/index.html",
			capabilities: [],
			registrations: {},
		}),
	);
	await writeFile(
		join(dir, "dist", "index.html"),
		"<!doctype html><html><body>catalog app</body></html>",
	);
}

/** Sign a catalog index into the envelope CatalogClient verifies (matches
 *  catalog-edge's signing.rs: Ed25519 over the exact base64url payload). */
function signIndex(index: CatalogIndex): SignedCatalog {
	const payload = Buffer.from(JSON.stringify(index)).toString("base64url");
	const sig = ed25519Sign(INDEX_SEED, new TextEncoder().encode(payload));
	return { payload, kid: KID, signature: Buffer.from(sig).toString("base64url") };
}

function trustedKeys(): CatalogTrustedKeys {
	return new Map([[KID, ed25519GetPublicKey(INDEX_SEED)]]);
}

function indexFor(sha256: string, signature: string): CatalogIndex {
	return {
		catalogId: "brainstorm-official",
		generatedAt: 1,
		ttlSeconds: 3600,
		listings: [
			{
				id: APP_ID,
				kind: "app",
				publisherKey: publisherKeyForSeed(PUBLISHER_SEED),
				name: "Catalog App",
				channels: { stable: "1.0.0" },
				versions: {
					"1.0.0": {
						manifestUrl: "http://cat.test/manifest.json",
						bundleUrl: `http://cat.test/${APP_ID}-1.0.0.brainstorm`,
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

describe("catalog install pipeline (end-to-end)", () => {
	let vaultDir: string;
	let appSrc: string;
	let stores: DataStores;
	let installer: AppInstaller;
	let appsRepo: AppsRepository;
	let bundleBytes: Uint8Array;
	let sha256: string;
	let signature: string;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-cat-vault-"));
		appSrc = await mkdtemp(join(tmpdir(), "bs-cat-app-"));
		await writeFakeApp(appSrc);
		const published = buildPublishedBundle(await readAppBundleFiles(appSrc), PUBLISHER_SEED);
		bundleBytes = published.bytes;
		sha256 = published.sha256;
		signature = published.signature;

		stores = new DataStores(vaultDir);
		const registry = await stores.open("registry");
		const ledger = new CapabilityLedger(await stores.open("ledger"));
		installer = new AppInstaller(vaultDir, registry, ledger);
		appsRepo = new AppsRepository(registry);
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
		await rm(appSrc, { recursive: true, force: true });
	});

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

	function engineFor(catalog: CatalogClient, download: () => Promise<Uint8Array>): InstallEngine {
		return new InstallEngine({
			catalog,
			installer,
			download,
			sha256Hex: bundleSha256Hex,
			verifyBundle: verifyBundleSignature,
			unpack: async (bytes) =>
				unpackBrainstormBundleToDir(bytes, await mkdtemp(join(tmpdir(), "bs-cat-stage-"))),
		});
	}

	it("fetches, verifies, unpacks, and installs a real signed bundle from the catalog", async () => {
		const catalog = await catalogWith(indexFor(sha256, signature));
		const engine = engineFor(catalog, async () => bundleBytes);

		const result = await engine.install(APP_ID, UpdateChannel.Stable);
		expect(result.outcome).toBe(InstallOutcome.Installed);

		const row = appsRepo.getActive(APP_ID);
		expect(row?.version).toBe("1.0.0");
		expect(row?.origin).toBe(InstallOrigin.Catalog);
		expect(row?.catalogId).toBe("brainstorm-official");
		expect(row?.catalogVersion).toBe("1.0.0");
		expect(row?.publisherKey).toBe(publisherKeyForSeed(PUBLISHER_SEED));

		// The bundle landed in the vault with its manifest intact.
		const manifest = await readFile(join(row?.bundleDir ?? "", "manifest.json"), "utf8");
		expect(manifest).toContain(APP_ID);
	});

	it("refuses to install when the downloaded bytes don't match the catalog sha256", async () => {
		const catalog = await catalogWith(indexFor(sha256, signature));
		const corrupt = new Uint8Array(bundleBytes);
		const last = corrupt.length - 1;
		corrupt[last] = (corrupt[last] ?? 0) ^ 0xff;
		const engine = engineFor(catalog, async () => corrupt);

		const result = await engine.install(APP_ID, UpdateChannel.Stable);
		expect(result.outcome).toBe(InstallOutcome.IntegrityFailed);
		expect(appsRepo.getActive(APP_ID)).toBeNull();
	});

	it("refuses to install when the catalog lists a signature from the wrong publisher", async () => {
		// Sign the bundle with a different key than the listing's publisherKey.
		const wrongSig = Buffer.from(
			ed25519Sign(new Uint8Array(32).fill(3), Buffer.from(sha256, "hex")),
		).toString("base64url");
		const catalog = await catalogWith(indexFor(sha256, wrongSig));
		const engine = engineFor(catalog, async () => bundleBytes);

		const result = await engine.install(APP_ID, UpdateChannel.Stable);
		expect(result.outcome).toBe(InstallOutcome.SignatureFailed);
		expect(appsRepo.getActive(APP_ID)).toBeNull();
	});
});
