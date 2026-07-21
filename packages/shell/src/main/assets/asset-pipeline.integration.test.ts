/**
 * End-to-end asset pipeline (A1–A4, shell side): a `network.preview` that
 * downloads a page's favicon + cover, stores them through the REAL encrypted
 * `AssetStore`, and serves them back through the `brainstorm://asset`
 * resolver — proving the favicon/cover a bookmark paints are the same bytes
 * the broker fetched, encrypted at rest, with no remote URL in the loop.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	net: { fetch: vi.fn() },
	session: { defaultSession: { setProxy: vi.fn() } },
}));

import type { LinkPreview } from "@brainstorm-os/sdk-types";
import type { Envelope } from "../../ipc/envelope";
import { generateSymmetricKey } from "../credentials/crypto";
import type { FetchImpl, LookupHost } from "../network/network-service";
import { makeNetworkServiceHandler } from "../network/network-service-handler";
import { DataStores } from "../storage/data-stores";
import { AssetDeksRepository, AssetsRepository } from "../storage/entities-repo";
import { AssetDekStore } from "./asset-dek-store";
import { AssetStore } from "./asset-store";
import { resolveAssetForServe } from "./serve-asset";

const PUBLIC_IP = "93.184.216.34";
const PAGE = "https://example.com/";
const PAGE_HTML = `<!doctype html><html><head>
	<meta property="og:image" content="https://example.com/cover.png">
	<link rel="icon" href="/favicon.ico">
</head><body>hi</body></html>`;
const FAVICON_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const COVER_BYTES = new Uint8Array([10, 20, 30, 40, 50, 60]);

function streamOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	return (async function* () {
		yield bytes;
	})();
}

const fetchImpl: FetchImpl = async (_ip, request) => {
	if (request.url === PAGE) {
		return {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
			body: streamOf(new TextEncoder().encode(PAGE_HTML)),
		};
	}
	if (request.url.endsWith("/favicon.ico")) {
		return {
			status: 200,
			headers: { "content-type": "image/x-icon" },
			body: streamOf(FAVICON_BYTES),
		};
	}
	if (request.url.endsWith("/cover.png")) {
		return { status: 200, headers: { "content-type": "image/png" }, body: streamOf(COVER_BYTES) };
	}
	throw new Error(`unexpected fetch ${request.url}`);
};
const lookup: LookupHost = async () => [PUBLIC_IP];

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-asset-pipeline-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	const masterKey = generateSymmetricKey();
	const assetStore = new AssetStore(
		new AssetsRepository(db),
		new AssetDekStore(new AssetDeksRepository(db), masterKey),
		join(vaultDir, "data", "assets"),
		(fn) => db.transaction(fn)(),
	);
	const handler = makeNetworkServiceHandler({
		fetchImpl,
		lookupHost: lookup,
		auditSink: () => {},
		storeImageAsset: (input) => assetStore.writeAsset(input),
	});
	return { vaultDir, stores, assetStore, handler };
}

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
	env = await setup();
});
afterEach(async () => {
	env.stores.close();
	await rm(env.vaultDir, { recursive: true, force: true });
});

function previewEnvelope(): Envelope {
	return {
		v: 1,
		msg: "m1",
		app: "io.brainstorm.bookmarks",
		service: "network",
		method: "preview",
		args: [{ url: PAGE }],
		caps: ["network.preview"],
	};
}

function assetIdOf(url: string | undefined): string {
	expect(url).toMatch(/^brainstorm:\/\/asset\/[0-9a-f-]{36}$/);
	return (url as string).replace("brainstorm://asset/", "");
}

describe("asset pipeline (preview → encrypted store → serve)", () => {
	it("serves the exact favicon + cover bytes the broker fetched", async () => {
		const preview = (await env.handler(previewEnvelope())) as LinkPreview;

		const favId = assetIdOf(preview.faviconAssetUrl);
		const coverId = assetIdOf(preview.coverAssetUrl);

		const favServed = await resolveAssetForServe(env.assetStore, favId);
		const coverServed = await resolveAssetForServe(env.assetStore, coverId);
		if (!favServed.ok || !coverServed.ok) throw new Error("expected both assets to serve");

		expect(favServed.bytes).toEqual(FAVICON_BYTES);
		expect(favServed.mime).toBe("image/x-icon");
		expect(coverServed.bytes).toEqual(COVER_BYTES);
		expect(coverServed.mime).toBe("image/png");

		// The remote URL is metadata only — the bookmark would paint the asset
		// URL, never `preview.favicon`.
		expect(preview.favicon).toBe("https://example.com/favicon.ico");
		expect(preview.faviconAssetUrl).not.toContain("example.com");
	});

	it("a non-existent asset id fails closed (404)", async () => {
		const result = await resolveAssetForServe(env.assetStore, "00000000-0000-4000-8000-000000000000");
		expect(result).toEqual({ ok: false, status: 404 });
	});
});
