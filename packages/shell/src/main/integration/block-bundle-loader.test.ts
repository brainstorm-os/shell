/**
 * BP block-bundle loader integration test — 9.5.x.
 *
 * Drives the FULL install→serve path a real embed exercises:
 *
 *   1. A real `AppInstaller` installs an app whose manifest declares a BP
 *      block registration AND ships a built `dist/blocks/<name>.js` bundle.
 *      The installer's `readBlockSources` copies the bundle into
 *      `registry.db.blocks.source` (the same path the first-party apps —
 *      tasks/calendar/bookmarks — already use).
 *   2. The `bsblock://` loader (`serveBlockFrameRequest`) is handed a real
 *      `getBlocksRepo` over THAT installed `registry.db` and asked to serve
 *      the block frame URL the `BpBlockMount`/`createBlockFrame` seam mints
 *      (`makeBlockFrameUrl(blockId, { channelId, entityId })`).
 *
 * The verification claim that closes the 9.5.x gap: the loader serves the
 * app-contributed bundle source (NOT the inert `BLOCK_FRAME_SRCDOC` stub),
 * wraps it in the pinned block-frame security shell (own CSP header,
 * bootstrap routing identity), and the SDK mount-path URL resolves to it.
 * A block with no bundle 404s — the host then keeps the documented fallback
 * card (the stub mount path), which is the only retained stub use.
 *
 * Every gate here is real: real installer, real registry.db read via a real
 * `BlocksRepository`, real `makeBlockFrameUrl` from the SDK seam, real
 * `buildBlockSrcdoc`/`BLOCK_FRAME_CSP` the loader returns.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BLOCK_FRAME_BOOTSTRAP_GLOBAL,
	BLOCK_FRAME_CSP,
	BLOCK_FRAME_ROOT_ID,
	BLOCK_FRAME_SRCDOC,
	makeBlockFrameUrl,
} from "@brainstorm/sdk/block-frame";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppInstaller } from "../apps/installer";
import type { AppManifest } from "../apps/manifest";
import { CapabilityLedger } from "../capabilities/ledger";
import { DataStores } from "../storage/data-stores";
import { BlocksRepository } from "../storage/registry-repo/blocks-repo";

// `block-frame-protocol.ts` imports `protocol` from electron only to register
// the scheme handler; the pure request handler we test never touches it.
vi.mock("electron", () => ({ protocol: { handle: () => {} } }));

const { serveBlockFrameRequest } = await import("../blocks/block-frame-protocol");

const APP_ID = "io.example.embeds";
const BUNDLE_BLOCK_ID = `${APP_ID}/inline-card`;
const BUNDLE_BLOCK_NAME = "inline-card";
const NO_BUNDLE_BLOCK_ID = `${APP_ID}/header-only`;
const NO_BUNDLE_BLOCK_NAME = "header-only";

// A self-contained IIFE, the shape an app's `dist/blocks/<name>.js` actually
// ships — distinctive marker so the assertion proves it's THIS source, not the
// stub or some other block.
const BLOCK_BUNDLE_SOURCE =
	'(function(){var r=document.getElementById("bs-block-root");r.textContent="LIVE-BUNDLE-9c1f";})();';

const manifest: AppManifest = {
	id: APP_ID,
	name: "Embeds Example",
	version: "0.1.0",
	sdk: "1",
	entry: "dist/index.html",
	capabilities: [],
	registrations: {
		blocks: [
			{ id: BUNDLE_BLOCK_ID, name: "Inline Card", entityTypes: ["io.example/Card/v1"] },
			{ id: NO_BUNDLE_BLOCK_ID, name: "Header Only" },
		],
	},
};

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-block-loader-"));
	const sourceDir = await mkdtemp(join(tmpdir(), "bs-block-loader-src-"));

	await writeFile(join(sourceDir, "manifest.json"), JSON.stringify(manifest), "utf8");
	await mkdir(join(sourceDir, "dist"), { recursive: true });
	await writeFile(join(sourceDir, "dist", "index.html"), "<!doctype html>", "utf8");
	// The built block bundle the installer's readBlockSources reads:
	// dist/blocks/<block-name>.js (block-id's last `/`-segment). Only the
	// bundle block ships a file; the other block ships none → fallback card.
	await mkdir(join(sourceDir, "dist", "blocks"), { recursive: true });
	await writeFile(
		join(sourceDir, "dist", "blocks", `${BUNDLE_BLOCK_NAME}.js`),
		BLOCK_BUNDLE_SOURCE,
		"utf8",
	);

	const stores = new DataStores(vaultDir);
	const ledger = new CapabilityLedger(await stores.open("ledger"));
	const installer = new AppInstaller(vaultDir, await stores.open("registry"), ledger);
	const result = await installer.install({ bundleDir: sourceDir });
	if (!result.ok) throw new Error(`install failed: ${result.reason}`);

	// The loader's dependency, wired to the REAL installed registry.db — this
	// is exactly what `main/index.ts` passes `registerBlockFrameProtocol`.
	const blocksRepo = new BlocksRepository(await stores.open("registry"));
	const deps = { getBlocksRepo: async () => blocksRepo };

	return { vaultDir, sourceDir, stores, blocksRepo, deps };
}

describe("BP block-bundle loader (install → serve) — 9.5.x", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
		await rm(env.sourceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("the real installer persists the app-contributed bundle into registry.db", () => {
		// Proves the source-of-truth the loader reads from is populated by the
		// real install flow, not a fixture.
		expect(env.blocksRepo.getSource(BUNDLE_BLOCK_ID)).toBe(BLOCK_BUNDLE_SOURCE);
		expect(env.blocksRepo.getSource(NO_BUNDLE_BLOCK_ID)).toBeNull();
	});

	it("the loader serves the installed bundle (not the stub) over the SDK mount-path URL", async () => {
		const channelId = "chan-loader-1";
		const entityId = "ent-embed-host-42";
		// The EXACT URL the BpBlockMount → createBlockFrame seam mints.
		const frameUrl = makeBlockFrameUrl(BUNDLE_BLOCK_ID, { channelId, entityId });

		const res = await serveBlockFrameRequest(frameUrl, env.deps);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		// The block document carries its OWN CSP (escaping the embedder's
		// script-src 'self'), the whole reason the bundle path exists.
		expect(res.headers.get("content-security-policy")).toBe(BLOCK_FRAME_CSP);

		const body = await res.text();
		// The served document is the REAL bundle wrapped in the pinned shell —
		// NOT the inert stub.
		expect(body).toContain(BLOCK_BUNDLE_SOURCE);
		expect(body).toContain("LIVE-BUNDLE-9c1f");
		expect(body).not.toBe(BLOCK_FRAME_SRCDOC);
		expect(body).toContain(`id="${BLOCK_FRAME_ROOT_ID}"`);
		// Routing identity injected into the frame's own document (channel id +
		// entity id can't arrive via the channel-gated Startup envelope).
		expect(body).toContain(BLOCK_FRAME_BOOTSTRAP_GLOBAL);
		expect(body).toContain(channelId);
		expect(body).toContain(entityId);
	});

	it("a registered block with NO bundle 404s — the host keeps the fallback card (only retained stub use)", async () => {
		const frameUrl = makeBlockFrameUrl(NO_BUNDLE_BLOCK_ID, {
			channelId: "chan-2",
			entityId: "ent-2",
		});
		const res = await serveBlockFrameRequest(frameUrl, env.deps);
		expect(res.status).toBe(404);
	});

	it("an unregistered (uninstalled-provider) block 404s", async () => {
		const frameUrl = makeBlockFrameUrl(`${APP_ID}/never-installed`, {
			channelId: "c",
			entityId: "e",
		});
		const res = await serveBlockFrameRequest(frameUrl, env.deps);
		expect(res.status).toBe(404);
	});

	it("400s a malformed block id or missing routing identity (loader fail-closed)", async () => {
		// Bypass makeBlockFrameUrl to forge malformed requests the way a hostile
		// frame would.
		for (const params of [
			{ b: "no-namespace-slash", c: "c", e: "e" },
			{ b: BUNDLE_BLOCK_ID, c: "", e: "e" },
			{ b: BUNDLE_BLOCK_ID, c: "c", e: "" },
		]) {
			const u = `bsblock://frame/?${new URLSearchParams(params).toString()}`;
			const res = await serveBlockFrameRequest(u, env.deps);
			expect(res.status).toBe(400);
		}
	});

	it("404s when no vault session is active (loader has no registry to read)", async () => {
		const frameUrl = makeBlockFrameUrl(BUNDLE_BLOCK_ID, { channelId: "c", entityId: "e" });
		const res = await serveBlockFrameRequest(frameUrl, { getBlocksRepo: async () => null });
		expect(res.status).toBe(404);
	});
});
