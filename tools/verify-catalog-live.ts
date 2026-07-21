/**
 * Live catalog smoke: drive the real CatalogClient + InstallEngine over HTTP
 * against a running `catalog-edge` (serving real published bundles), installing
 * an app into a throwaway vault. The same chain the shell runs, with node
 * `fetch` standing in for electron `net.fetch` (behaviourally identical for a
 * plain GET). Verifies the network + verify + unpack + install path end-to-end.
 *
 *   # 1. build apps, publish, serve:
 *   bun run build:apps
 *   CATALOG_OUT=/tmp/catalog-out bun tools/publish-first-party-catalog.ts
 *   CATALOG_BIND=127.0.0.1:8788 CATALOG_BUNDLE_DIR=/tmp/catalog-out \
 *     ../cloud/services/catalog-edge/target/debug/catalog-edge &
 *   # 2. verify:
 *   bun tools/verify-catalog-live.ts io.brainstorm.notes
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { AppInstaller } from "../packages/shell/src/main/apps/installer";
import { CapabilityLedger } from "../packages/shell/src/main/capabilities/ledger";
import {
	bundleSha256Hex,
	unpackBrainstormBundleToDir,
	verifyBundleSignature,
} from "../packages/shell/src/main/catalog/brainstorm-package";
import {
	CatalogClient,
	InMemoryCatalogCache,
} from "../packages/shell/src/main/catalog/catalog-client";
import { officialCatalogTrustedKeys } from "../packages/shell/src/main/catalog/catalog-trusted-keys";
import { InstallEngine, InstallOutcome } from "../packages/shell/src/main/catalog/install-engine";
import { DataStores } from "../packages/shell/src/main/storage/data-stores";
import { AppsRepository } from "../packages/shell/src/main/storage/registry-repo/apps-repo";

const CATALOG = process.env.BRAINSTORM_CATALOG_URL ?? "http://127.0.0.1:8788";
const APP_ID = process.argv[2] ?? "io.brainstorm.notes";

async function main(): Promise<void> {
	const catalog = new CatalogClient({
		fetchIndexJson: async () => (await fetch(`${CATALOG}/v1/catalog/index`)).json(),
		// The shell's baked dev trusted keys (verifies the catalog-edge dev index key).
		trustedKeys: officialCatalogTrustedKeys(),
		cache: new InMemoryCatalogCache(),
	});
	const refresh = await catalog.refresh();
	console.log(`index: ${refresh.status}, ${catalog.listings().length} listings`);
	if (!catalog.listing(APP_ID)) throw new Error(`${APP_ID} not in catalog`);

	const vault = await mkdtemp(join(tmpdir(), "bs-verify-vault-"));
	const stores = new DataStores(vault);
	const registry = await stores.open("registry");
	const ledger = new CapabilityLedger(await stores.open("ledger"));
	const installer = new AppInstaller(vault, registry, ledger);
	const repo = new AppsRepository(registry);

	const engine = new InstallEngine({
		catalog,
		installer,
		download: async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
		sha256Hex: bundleSha256Hex,
		verifyBundle: verifyBundleSignature,
		unpack: async (bytes) =>
			unpackBrainstormBundleToDir(bytes, await mkdtemp(join(tmpdir(), "bs-verify-stage-"))),
	});

	const result = await engine.install(APP_ID, UpdateChannel.Stable);
	const row = repo.getActive(APP_ID);
	stores.close();
	console.log(`install: ${result.outcome}`);
	console.log(
		`row: version=${row?.version} origin=${row?.origin} sha=${row?.bundleSha256.slice(0, 8)}`,
	);
	if (result.outcome !== InstallOutcome.Installed || !row) {
		throw new Error(`install failed: ${"reason" in result ? result.reason : result.outcome}`);
	}
	console.log(`✓ ${APP_ID} installed from the live catalog into ${vault}`);
}

await main();
