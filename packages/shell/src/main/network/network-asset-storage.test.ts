/**
 * Asset-storage path in `handlePreview` — the broker downloads the page's
 * favicon + OG cover through the same SSRF/privacy/size guards and stores
 * them encrypted, returning `brainstorm://asset/<id>` URLs:
 *   - favicon + cover both stored → both asset URLs returned, with the right
 *     kind + bytes handed to the store;
 *   - no store wired → preview carries only remote URLs;
 *   - a non-image response (HTML error page) is NOT stored;
 *   - an Allowlist-mode vault that doesn't list the image host skips it;
 *   - a store throw degrades gracefully (preview still returns).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	net: { fetch: vi.fn() },
	session: { defaultSession: { setProxy: vi.fn() } },
}));

import type { LinkPreview } from "@brainstorm-os/sdk-types";
import type { Envelope } from "../../ipc/envelope";
import { AssetKind } from "../assets/asset-types";
import type { FetchImpl, LookupHost } from "./network-service";
import { type NetworkServiceOptions, makeNetworkServiceHandler } from "./network-service-handler";
import { type PrivacyConfig, PrivacyMode } from "./privacy-config";

const PUBLIC_IP = "93.184.216.34";
const PAGE = "https://example.com/";
const PAGE_HTML = `<!doctype html><html><head>
	<meta property="og:title" content="Example">
	<meta property="og:image" content="https://cdn.example.com/cover.png">
	<link rel="icon" href="/favicon.ico">
</head><body>hi</body></html>`;

const FAVICON_BYTES = new Uint8Array([1, 2, 3, 4]);
const COVER_BYTES = new Uint8Array([5, 6, 7, 8, 9]);

function envelope(): Envelope {
	return {
		v: 1,
		msg: "m1",
		app: "io.example.client",
		service: "network",
		method: "preview",
		args: [{ url: PAGE }],
		caps: ["network.preview"],
	};
}

function streamOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	return (async function* () {
		yield bytes;
	})();
}

/** Routes by URL: the page → HTML, favicon/cover → image bytes. A
 *  per-path content-type override lets a test return a non-image body. */
function routedFetch(overrides: { faviconType?: string } = {}): FetchImpl {
	return async (_resolvedIp, request) => {
		const url = request.url;
		if (url === PAGE) {
			return {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
				body: streamOf(new TextEncoder().encode(PAGE_HTML)),
			};
		}
		if (url.endsWith("/favicon.ico")) {
			return {
				status: 200,
				headers: { "content-type": overrides.faviconType ?? "image/x-icon" },
				body: streamOf(FAVICON_BYTES),
			};
		}
		if (url.endsWith("/cover.png")) {
			return {
				status: 200,
				headers: { "content-type": "image/png" },
				body: streamOf(COVER_BYTES),
			};
		}
		throw new Error(`unexpected fetch: ${url}`);
	};
}

const lookup: LookupHost = async () => [PUBLIC_IP];

type StoreCall = { mime: string; kind: AssetKind; originUrl: string; bytes: Uint8Array };

function recordingStore(impl?: () => Promise<{ assetId: string }>): {
	calls: StoreCall[];
	store: NonNullable<NetworkServiceOptions["storeImageAsset"]>;
} {
	const calls: StoreCall[] = [];
	let n = 0;
	return {
		calls,
		store: async (input) => {
			calls.push(input);
			if (impl) return impl();
			n += 1;
			return { assetId: `00000000-0000-4000-8000-00000000000${n}` };
		},
	};
}

function baseOptions(extra: Partial<NetworkServiceOptions> = {}): NetworkServiceOptions {
	return { fetchImpl: routedFetch(), lookupHost: lookup, auditSink: () => {}, ...extra };
}

describe("handlePreview — asset storage", () => {
	it("stores favicon + cover and returns brainstorm://asset URLs", async () => {
		const { calls, store } = recordingStore();
		const handler = makeNetworkServiceHandler(baseOptions({ storeImageAsset: store }));
		const preview = (await handler(envelope())) as LinkPreview;

		expect(preview.faviconAssetUrl).toBe("brainstorm://asset/00000000-0000-4000-8000-000000000001");
		expect(preview.coverAssetUrl).toBe("brainstorm://asset/00000000-0000-4000-8000-000000000002");
		expect(calls).toHaveLength(2);
		const favicon = calls.find((c) => c.kind === AssetKind.Favicon);
		const cover = calls.find((c) => c.kind === AssetKind.Cover);
		expect(favicon?.bytes).toEqual(FAVICON_BYTES);
		expect(favicon?.mime).toBe("image/x-icon");
		expect(favicon?.originUrl).toBe("https://example.com/favicon.ico");
		expect(cover?.bytes).toEqual(COVER_BYTES);
		expect(cover?.mime).toBe("image/png");
	});

	it("returns only remote URLs when no asset store is wired", async () => {
		const handler = makeNetworkServiceHandler(baseOptions());
		const preview = (await handler(envelope())) as LinkPreview;
		expect(preview.faviconAssetUrl).toBeUndefined();
		expect(preview.coverAssetUrl).toBeUndefined();
		expect(preview.favicon).toBe("https://example.com/favicon.ico");
	});

	it("does not store a non-image response (skips that asset)", async () => {
		const { calls, store } = recordingStore();
		const handler = makeNetworkServiceHandler(
			baseOptions({ fetchImpl: routedFetch({ faviconType: "text/html" }), storeImageAsset: store }),
		);
		const preview = (await handler(envelope())) as LinkPreview;
		expect(preview.faviconAssetUrl).toBeUndefined(); // non-image skipped
		expect(preview.coverAssetUrl).toBeDefined(); // cover still stored
		expect(calls.map((c) => c.kind)).toEqual([AssetKind.Cover]);
	});

	it("skips an image host an Allowlist-mode vault does not list", async () => {
		const { calls, store } = recordingStore();
		const privacy: PrivacyConfig = { mode: PrivacyMode.Allowlist, hosts: ["example.com"] };
		const handler = makeNetworkServiceHandler(
			baseOptions({ storeImageAsset: store, getPrivacyConfig: () => privacy }),
		);
		const preview = (await handler(envelope())) as LinkPreview;
		// example.com favicon allowed; cdn.example.com cover host not listed.
		expect(preview.faviconAssetUrl).toBeDefined();
		expect(preview.coverAssetUrl).toBeUndefined();
		expect(calls.map((c) => c.kind)).toEqual([AssetKind.Favicon]);
	});

	it("degrades gracefully when the store throws", async () => {
		const { store } = recordingStore(async () => {
			throw new Error("disk full");
		});
		const handler = makeNetworkServiceHandler(baseOptions({ storeImageAsset: store }));
		const preview = (await handler(envelope())) as LinkPreview;
		expect(preview.faviconAssetUrl).toBeUndefined();
		expect(preview.coverAssetUrl).toBeUndefined();
		expect(preview.title).toBe("Example"); // preview itself still returned
	});
});
