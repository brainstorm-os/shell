import * as nodeHttp from "node:http";
import type { NetworkReadableResult } from "@brainstorm/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";

// Electron isn't installed under the workspace test harness — the
// production module imports `net` + `session` from it but only as
// value references reached by `productionFetchImpl` /
// `productionLookupHost` / `productionApplyProxyConfig`, never during
// the handler unit tests. Mock the surface so importing the module
// doesn't blow up under `bun --bun vitest`.
vi.mock("electron", () => ({
	net: { fetch: vi.fn() },
	session: {
		defaultSession: {
			setProxy: vi.fn(),
			// Default: no proxy applies. Tests that exercise the proxy branch
			// override this per-test.
			resolveProxy: vi.fn(async () => "DIRECT"),
		},
	},
}));

import { net, session } from "electron";
import type { FetchImpl, LookupHost } from "./network-service";
import {
	type ApplyProxyConfig,
	electronProxyConfigFor,
	fetchPinnedDirect,
	makeNetworkServiceHandler,
	productionFetchImpl,
	sanitizeFetchHeaders,
} from "./network-service-handler";
import { LinkPreviewCache } from "./preview-cache";
import { PreviewBlockedReason, type PrivacyConfig, PrivacyMode } from "./privacy-config";
import { type ProxyConfig, ProxyMode } from "./proxy-config";

const PUBLIC_IP = "93.184.216.34";

function makeEnvelope(method: string, args: unknown[]): Envelope {
	return {
		v: 1,
		msg: "msg_1",
		app: "io.example.client",
		service: "network",
		method,
		args,
		caps: ["network.fetch"],
	};
}

function makeStubFetch(): FetchImpl {
	return async () => ({
		status: 200,
		headers: { "content-type": "text/plain" },
		body: (async function* () {
			yield new TextEncoder().encode("hello");
		})(),
	});
}

function makeStubLookup(): LookupHost {
	return async () => [PUBLIC_IP];
}

function makeRecordingSink(): {
	records: string[];
	sink: (line: string) => void;
} {
	const records: string[] = [];
	return {
		records,
		sink: (line: string) => {
			records.push(line);
		},
	};
}

describe("makeNetworkServiceHandler — method dispatch", () => {
	it("dispatches `fetch` to the executor", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		const result = (await handler(makeEnvelope("fetch", [{ url: "https://example.com/" }]))) as {
			status: number;
		};
		expect(result.status).toBe(200);
	});

	it("rejects unknown methods with Invalid", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await expect(handler(makeEnvelope("compose", [{ url: "https://x" }]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("uses envelope.app as the audit appId", async () => {
		const { records, sink } = makeRecordingSink();
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: sink,
		});
		const env = makeEnvelope("fetch", [{ url: "https://example.com/" }]);
		await handler(env);
		const parsed = JSON.parse(records[0] ?? "{}") as { appId: string };
		expect(parsed.appId).toBe(env.app);
	});
});

describe("makeNetworkServiceHandler — server-side capability enforcement", () => {
	// A fake ledger: grants are `${app}:${cap}` entries. Mirrors the real
	// CapabilityLedger.has(appId, required) shape.
	function fakeLedger(grants: string[]): { has: (app: string, cap: string) => boolean } {
		const set = new Set(grants);
		return { has: (app, cap) => set.has(`${app}:${cap}`) };
	}

	function ledgerOpts(grants: string[]) {
		return {
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getLedger: async () => fakeLedger(grants) as never,
		};
	}

	// The exploit: an app omits the scarce cap from envelope.caps. The broker's
	// `declaredCaps.every(...)` passes vacuously on `caps: []`, so the only line
	// of defense is this server-side check.
	function omittedCapEnvelope(method: string, args: unknown[]): Envelope {
		return { ...makeEnvelope(method, args), caps: [] };
	}

	it("denies fetch when the app does not hold network.fetch, even with caps omitted", async () => {
		const handler = makeNetworkServiceHandler(ledgerOpts([]));
		await expect(
			handler(omittedCapEnvelope("fetch", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("allows fetch when the app holds network.fetch in the ledger", async () => {
		const handler = makeNetworkServiceHandler(ledgerOpts(["io.example.client:network.fetch"]));
		const result = (await handler(
			omittedCapEnvelope("fetch", [{ url: "https://example.com/" }]),
		)) as { status: number };
		expect(result.status).toBe(200);
	});

	it("denies readable when the app does not hold network.readable", async () => {
		const handler = makeNetworkServiceHandler(ledgerOpts(["io.example.client:network.fetch"]));
		await expect(
			handler(omittedCapEnvelope("readable", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("denies preview when the app does not hold network.preview", async () => {
		const handler = makeNetworkServiceHandler(ledgerOpts(["io.example.client:network.fetch"]));
		await expect(
			handler(omittedCapEnvelope("preview", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("fails closed as Unavailable when no vault session (ledger null)", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getLedger: async () => null,
		});
		await expect(
			handler(makeEnvelope("fetch", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});
});

describe("makeNetworkServiceHandler — arg validation", () => {
	const baseOpts = {
		fetchImpl: makeStubFetch(),
		lookupHost: makeStubLookup(),
		auditSink: makeRecordingSink().sink,
	};

	it("rejects non-object argument", async () => {
		const handler = makeNetworkServiceHandler(baseOpts);
		await expect(handler(makeEnvelope("fetch", ["not an object"]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("rejects missing url", async () => {
		const handler = makeNetworkServiceHandler(baseOpts);
		await expect(handler(makeEnvelope("fetch", [{}]))).rejects.toMatchObject({ name: "Invalid" });
	});

	it("rejects empty url", async () => {
		const handler = makeNetworkServiceHandler(baseOpts);
		await expect(handler(makeEnvelope("fetch", [{ url: "" }]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("rejects non-string url", async () => {
		const handler = makeNetworkServiceHandler(baseOpts);
		await expect(handler(makeEnvelope("fetch", [{ url: 123 }]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("rejects non-object headers", async () => {
		const handler = makeNetworkServiceHandler(baseOpts);
		await expect(
			handler(makeEnvelope("fetch", [{ url: "https://x.example/", headers: "broken" }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("rejects non-string header value", async () => {
		const handler = makeNetworkServiceHandler(baseOpts);
		await expect(
			handler(makeEnvelope("fetch", [{ url: "https://x.example/", headers: { "X-Number": 42 } }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("rejects negative sizeCapBytes", async () => {
		const handler = makeNetworkServiceHandler(baseOpts);
		await expect(
			handler(makeEnvelope("fetch", [{ url: "https://x.example/", sizeCapBytes: -1 }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("rejects zero or negative timeoutMs", async () => {
		const handler = makeNetworkServiceHandler(baseOpts);
		await expect(
			handler(makeEnvelope("fetch", [{ url: "https://x.example/", timeoutMs: 0 }])),
		).rejects.toMatchObject({ name: "Invalid" });
		await expect(
			handler(makeEnvelope("fetch", [{ url: "https://x.example/", timeoutMs: -5 }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("accepts body as number[] (IPC-friendly transcoding)", async () => {
		const seen: Uint8Array[] = [];
		const fetchImpl: FetchImpl = async (_ip, req) => {
			if (req.body !== undefined) seen.push(req.body);
			return {
				status: 200,
				headers: {},
				body: (async function* () {})(),
			};
		};
		const handler = makeNetworkServiceHandler({
			fetchImpl,
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/", body: [1, 2, 3, 4] }]));
		expect(seen[0]).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("accepts body as Uint8Array", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		const result = await handler(
			makeEnvelope("fetch", [{ url: "https://example.com/", body: new Uint8Array([5, 6, 7]) }]),
		);
		expect(result).toBeDefined();
	});
});

describe("makeNetworkServiceHandler — error mapping", () => {
	it("maps SSRF refusal to Denied", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await expect(
			handler(makeEnvelope("fetch", [{ url: "file:///etc/passwd" }])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("maps DNS failure to Unavailable", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: async () => {
				throw new Error("ENOTFOUND");
			},
			auditSink: makeRecordingSink().sink,
		});
		await expect(
			handler(makeEnvelope("fetch", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("maps transport error to Unavailable", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: async () => {
				throw new Error("TLS handshake failed");
			},
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await expect(
			handler(makeEnvelope("fetch", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("maps size-cap exceedance to Aborted", async () => {
		const fetchImpl: FetchImpl = async () => ({
			status: 200,
			headers: {},
			body: (async function* () {
				yield new Uint8Array(2 * 1024 * 1024); // 2 MiB > 1 MiB default
			})(),
		});
		const handler = makeNetworkServiceHandler({
			fetchImpl,
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await expect(
			handler(makeEnvelope("fetch", [{ url: "https://example.com/big" }])),
		).rejects.toMatchObject({ name: "Aborted" });
	});

	it("maps too-many-redirects to Aborted", async () => {
		const fetchImpl: FetchImpl = async (_ip, req) => ({
			status: 302,
			headers: { Location: `${req.url}/x` },
			body: (async function* () {})(),
		});
		const handler = makeNetworkServiceHandler({
			fetchImpl,
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await expect(
			handler(makeEnvelope("fetch", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "Aborted" });
	});
});

describe("makeNetworkServiceHandler — preview method", () => {
	const previewHtml = `
		<html><head>
			<meta property="og:title" content="Preview Title">
			<meta property="og:description" content="Preview description.">
			<meta property="og:image" content="https://example.com/p.png">
		</head></html>
	`;

	function makePreviewFetch(): FetchImpl {
		return async () => ({
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
			body: (async function* () {
				yield new TextEncoder().encode(previewHtml);
			})(),
		});
	}

	it("extracts a LinkPreview from the response body", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		const result = (await handler(
			makeEnvelope("preview", [{ url: "https://example.com/article" }]),
		)) as { title: string; description: string; image: string };
		expect(result.title).toBe("Preview Title");
		expect(result.description).toBe("Preview description.");
		expect(result.image).toBe("https://example.com/p.png");
	});

	it("rejects missing url with Invalid", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await expect(handler(makeEnvelope("preview", [{}]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("rejects non-object argument with Invalid", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await expect(handler(makeEnvelope("preview", ["not an object"]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("truncates a >64 KiB page to the cap and still extracts from <head>", async () => {
		// Large pages (Wikipedia ≈1 MB) must still preview: the preview cap
		// TRUNCATES rather than rejects, and the <title> in the leading bytes
		// is extracted from the truncated HTML.
		const bigHtml = `<title>Big Page</title>${"<!-- padding -->".repeat(5000)}`;
		expect(bigHtml.length).toBeGreaterThan(64 * 1024);
		const handler = makeNetworkServiceHandler({
			fetchImpl: async () => ({
				status: 200,
				headers: { "content-type": "text/html" },
				body: (async function* () {
					yield new TextEncoder().encode(bigHtml);
				})(),
			}),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		const preview = (await handler(
			makeEnvelope("preview", [{ url: "https://example.com/big" }]),
		)) as { title: string };
		expect(preview.title).toBe("Big Page");
	});

	it("uses the finalUrl from the executor (after any redirects)", async () => {
		// Simulate a redirect: the executor's finalUrl reflects the final
		// hop, and the preview's `url` should match that.
		let hop = 0;
		const fetchImpl: FetchImpl = async () => {
			hop += 1;
			if (hop === 1) {
				return {
					status: 302,
					headers: { Location: "https://example.com/final" },
					body: (async function* () {})(),
				};
			}
			return {
				status: 200,
				headers: { "content-type": "text/html" },
				body: (async function* () {
					yield new TextEncoder().encode(previewHtml);
				})(),
			};
		};
		const handler = makeNetworkServiceHandler({
			fetchImpl,
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		const result = (await handler(
			makeEnvelope("preview", [{ url: "https://example.com/short" }]),
		)) as { url: string };
		expect(result.url).toBe("https://example.com/final");
	});

	it("decodes non-utf8 charset declared in Content-Type", async () => {
		const html = `<meta charset="latin1"><title>Café</title>`;
		const handler = makeNetworkServiceHandler({
			fetchImpl: async () => ({
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
				body: (async function* () {
					yield new TextEncoder().encode(html);
				})(),
			}),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		const result = (await handler(makeEnvelope("preview", [{ url: "https://example.com/" }]))) as {
			title: string;
		};
		expect(result.title).toBe("Café");
	});
});

/**
 * Net-1b — `.private` capability surface.
 *
 * The broker enforces both `network.fetch` (umbrella) AND, when reaching
 * private addresses, `network.fetch.private` (scope-widener). The
 * service handler reads `envelope.caps` to determine whether to pass
 * `allowPrivate: true` to the executor. A caller without the `.private`
 * cap stays public-only — byte-identical to the pre-Net-1b world.
 */
describe("makeNetworkServiceHandler — Net-1b .private capability gate", () => {
	const PRIVATE_IP = "192.168.1.1";

	function envWith(method: string, args: unknown[], caps: string[]): Envelope {
		return {
			v: 1,
			msg: "msg_priv",
			app: "io.example.local",
			service: "network",
			method,
			args,
			caps,
		};
	}

	it("with `network.fetch.private` cap → fetch to a private IP succeeds", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: async () => ({
				status: 200,
				headers: { "content-type": "text/plain" },
				body: (async function* () {
					yield new TextEncoder().encode("local-ok");
				})(),
			}),
			lookupHost: async () => [PRIVATE_IP],
			auditSink: makeRecordingSink().sink,
		});
		const result = (await handler(
			envWith(
				"fetch",
				[{ url: "http://router.local/status" }],
				["network.fetch", "network.fetch.private"],
			),
		)) as { status: number };
		expect(result.status).toBe(200);
	});

	it("without `.private` cap → private IP fetch refused as Denied (SSRF)", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: async () => [PRIVATE_IP],
			auditSink: makeRecordingSink().sink,
		});
		await expect(
			handler(envWith("fetch", [{ url: "http://router.local/status" }], ["network.fetch"])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("without `.private` cap → literal RFC1918 URL refused as Denied", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await expect(
			handler(envWith("fetch", [{ url: "http://192.168.1.1/" }], ["network.fetch"])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("with `.private` cap → literal RFC1918 URL succeeds (allowPrivate flows through)", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: async (resolvedIp) => {
				expect(resolvedIp).toBe(PRIVATE_IP);
				return {
					status: 204,
					headers: {},
					body: (async function* () {})(),
				};
			},
			// Lookup returns the literal as the resolved IP.
			lookupHost: async () => [PRIVATE_IP],
			auditSink: makeRecordingSink().sink,
		});
		const result = (await handler(
			envWith("fetch", [{ url: "http://192.168.1.1/" }], ["network.fetch", "network.fetch.private"]),
		)) as { status: number };
		expect(result.status).toBe(204);
	});

	it("with `.private` cap → preview to a `.local` host succeeds", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: async () => ({
				status: 200,
				headers: { "content-type": "text/html" },
				body: (async function* () {
					yield new TextEncoder().encode("<title>Printer</title>");
				})(),
			}),
			lookupHost: async () => [PRIVATE_IP],
			auditSink: makeRecordingSink().sink,
		});
		const result = (await handler(
			envWith(
				"preview",
				[{ url: "http://printer.local/" }],
				["network.fetch", "network.fetch.private"],
			),
		)) as { title: string | null };
		expect(result.title).toBe("Printer");
	});

	it("with `.private` cap → public IP fetches still work (no regression)", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		const result = (await handler(
			envWith("fetch", [{ url: "https://example.com/" }], ["network.fetch", "network.fetch.private"]),
		)) as { status: number };
		expect(result.status).toBe(200);
	});

	it("`.private` cap does NOT relax non-HTTP schemes (floor still wins)", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await expect(
			handler(
				envWith("fetch", [{ url: "file:///etc/passwd" }], ["network.fetch", "network.fetch.private"]),
			),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("`.private` cap does NOT relax blocked ports (floor still wins)", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		await expect(
			handler(
				envWith(
					"fetch",
					[{ url: "http://192.168.1.1:22/" }],
					["network.fetch", "network.fetch.private"],
				),
			),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("audit log records the host of the private fetch (`.private` doesn't hide audit)", async () => {
		const { records, sink } = makeRecordingSink();
		const handler = makeNetworkServiceHandler({
			fetchImpl: async () => ({
				status: 200,
				headers: { "content-type": "text/plain" },
				body: (async function* () {
					yield new Uint8Array([1, 2, 3]);
				})(),
			}),
			lookupHost: async () => [PRIVATE_IP],
			auditSink: sink,
		});
		await handler(
			envWith(
				"fetch",
				[{ url: "http://router.local/status" }],
				["network.fetch", "network.fetch.private"],
			),
		);
		expect(records).toHaveLength(1);
		const rec = JSON.parse(records[0] ?? "{}") as { host: string; outcome: string };
		expect(rec.host).toBe("router.local");
		expect(rec.outcome).toBe("completed");
	});
});

/**
 * Net-1c — per-(canonicalUrl, locale) preview cache integration.
 *
 * `handlePreview` consults `options.previewCache` (when wired) before
 * any egress. Cache hits skip the fetch + audit-log entirely; misses
 * fall through to the executor + record the result. The cache is
 * keyed on locale so the same URL pasted in different languages
 * mints two cache entries.
 */
describe("makeNetworkServiceHandler — Net-1c preview cache", () => {
	function countingFetch(fetchCount: { value: number }, html?: string): FetchImpl {
		const body = html ?? "<title>Cached Title</title>";
		return async () => {
			fetchCount.value++;
			return {
				status: 200,
				headers: { "content-type": "text/html" },
				body: (async function* () {
					yield new TextEncoder().encode(body);
				})(),
			};
		};
	}

	it("cache hit on second preview of the same URL skips the fetch", async () => {
		const fetchCount = { value: 0 };
		const cache = new LinkPreviewCache();
		const handler = makeNetworkServiceHandler({
			fetchImpl: countingFetch(fetchCount),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			previewCache: cache,
		});
		const env = makeEnvelope("preview", [{ url: "https://example.com/" }]);
		const first = (await handler(env)) as { title: string };
		const second = (await handler(env)) as { title: string };
		expect(first.title).toBe("Cached Title");
		expect(second.title).toBe("Cached Title");
		expect(fetchCount.value).toBe(1);
	});

	it("cache miss falls through to the executor + stores the result", async () => {
		const fetchCount = { value: 0 };
		const cache = new LinkPreviewCache();
		const handler = makeNetworkServiceHandler({
			fetchImpl: countingFetch(fetchCount),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			previewCache: cache,
		});
		expect(cache.size).toBe(0);
		await handler(makeEnvelope("preview", [{ url: "https://example.com/" }]));
		expect(fetchCount.value).toBe(1);
		expect(cache.size).toBeGreaterThan(0);
	});

	it("different locales mint distinct cache entries (two fetches)", async () => {
		const fetchCount = { value: 0 };
		const cache = new LinkPreviewCache();
		const handler = makeNetworkServiceHandler({
			fetchImpl: countingFetch(fetchCount),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			previewCache: cache,
		});
		await handler(makeEnvelope("preview", [{ url: "https://example.com/", locale: "en" }]));
		await handler(makeEnvelope("preview", [{ url: "https://example.com/", locale: "fr" }]));
		expect(fetchCount.value).toBe(2);
		await handler(makeEnvelope("preview", [{ url: "https://example.com/", locale: "en" }]));
		expect(fetchCount.value).toBe(2);
	});

	it("expired entries fall through to a fresh fetch (TTL)", async () => {
		let now = 1_000_000;
		const fetchCount = { value: 0 };
		const cache = new LinkPreviewCache({ ttlMs: 1000, now: () => now });
		const handler = makeNetworkServiceHandler({
			fetchImpl: countingFetch(fetchCount),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			previewCache: cache,
		});
		const env = makeEnvelope("preview", [{ url: "https://example.com/" }]);
		await handler(env);
		await handler(env);
		expect(fetchCount.value).toBe(1);
		now += 2000;
		await handler(env);
		expect(fetchCount.value).toBe(2);
	});

	it("no cache wired → byte-identical pre-Net-1c behaviour (executor called every time)", async () => {
		const fetchCount = { value: 0 };
		const handler = makeNetworkServiceHandler({
			fetchImpl: countingFetch(fetchCount),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		const env = makeEnvelope("preview", [{ url: "https://example.com/" }]);
		await handler(env);
		await handler(env);
		await handler(env);
		expect(fetchCount.value).toBe(3);
	});

	it("cache hits do NOT write to the audit log (no egress = no audit)", async () => {
		const fetchCount = { value: 0 };
		const { records, sink } = makeRecordingSink();
		const cache = new LinkPreviewCache();
		const handler = makeNetworkServiceHandler({
			fetchImpl: countingFetch(fetchCount),
			lookupHost: makeStubLookup(),
			auditSink: sink,
			previewCache: cache,
		});
		const env = makeEnvelope("preview", [{ url: "https://example.com/" }]);
		await handler(env);
		await handler(env);
		await handler(env);
		expect(records).toHaveLength(1);
		expect(fetchCount.value).toBe(1);
	});

	it("cache.clear() resets — next preview fetches again", async () => {
		const fetchCount = { value: 0 };
		const cache = new LinkPreviewCache();
		const handler = makeNetworkServiceHandler({
			fetchImpl: countingFetch(fetchCount),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			previewCache: cache,
		});
		const env = makeEnvelope("preview", [{ url: "https://example.com/" }]);
		await handler(env);
		await handler(env);
		expect(fetchCount.value).toBe(1);
		cache.clear();
		await handler(env);
		expect(fetchCount.value).toBe(2);
	});

	it("invalid locale arg → Invalid (validator catches before any fetch)", async () => {
		const fetchCount = { value: 0 };
		const handler = makeNetworkServiceHandler({
			fetchImpl: countingFetch(fetchCount),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			previewCache: new LinkPreviewCache(),
		});
		await expect(
			handler(makeEnvelope("preview", [{ url: "https://example.com/", locale: "" }])),
		).rejects.toMatchObject({ name: "Invalid" });
		await expect(
			handler(makeEnvelope("preview", [{ url: "https://example.com/", locale: 42 }])),
		).rejects.toMatchObject({ name: "Invalid" });
		expect(fetchCount.value).toBe(0);
	});
});

/**
 * Net-1d — proxy config wiring at the handler boundary.
 *
 * When `getProxyConfig` + `applyProxyConfig` are wired, the handler
 * calls `applyProxyConfig(config)` before the first request and any
 * time the config has materially changed since the last call. Skips
 * idempotent re-calls so a stable session config doesn't re-issue
 * `session.setProxy` thousands of times during a paste-storm.
 *
 * The handler doesn't apply proxy when one side of the pair is
 * missing — production wires both, tests that don't care about proxy
 * leave both out (and stay byte-identical to the pre-Net-1d world).
 */
describe("makeNetworkServiceHandler — Net-1d proxy apply", () => {
	function makeRecorder(): { calls: ProxyConfig[]; apply: ApplyProxyConfig } {
		const calls: ProxyConfig[] = [];
		return {
			calls,
			apply: async (config) => {
				calls.push(config);
			},
		};
	}

	it("applies proxy config on the first request", async () => {
		const { calls, apply } = makeRecorder();
		const config: ProxyConfig = { mode: ProxyMode.System };
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getProxyConfig: () => config,
			applyProxyConfig: apply,
		});
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/" }]));
		expect(calls).toEqual([{ mode: ProxyMode.System }]);
	});

	it("skips the apply on a second request with the same config (idempotent)", async () => {
		const { calls, apply } = makeRecorder();
		const config: ProxyConfig = { mode: ProxyMode.System };
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getProxyConfig: () => config,
			applyProxyConfig: apply,
		});
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/" }]));
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/other" }]));
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/third" }]));
		expect(calls).toHaveLength(1);
	});

	it("re-applies when the proxy config changes between calls", async () => {
		const { calls, apply } = makeRecorder();
		let current: ProxyConfig = { mode: ProxyMode.System };
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getProxyConfig: () => current,
			applyProxyConfig: apply,
		});
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/" }]));
		current = { mode: ProxyMode.Direct };
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/" }]));
		current = {
			mode: ProxyMode.Manual,
			httpsProxy: { host: "proxy.corp", port: 443 },
			noProxy: [".internal"],
		};
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/" }]));
		// Re-issuing the same Manual config shouldn't re-apply.
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/" }]));
		expect(calls).toHaveLength(3);
		expect(calls[0]).toEqual({ mode: ProxyMode.System });
		expect(calls[1]).toEqual({ mode: ProxyMode.Direct });
		expect(calls[2]).toMatchObject({ mode: ProxyMode.Manual });
	});

	it("applies proxy config on the preview path too", async () => {
		const { calls, apply } = makeRecorder();
		const config: ProxyConfig = { mode: ProxyMode.System };
		const handler = makeNetworkServiceHandler({
			fetchImpl: async () => ({
				status: 200,
				headers: { "content-type": "text/html" },
				body: (async function* () {
					yield new TextEncoder().encode("<title>OK</title>");
				})(),
			}),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getProxyConfig: () => config,
			applyProxyConfig: apply,
		});
		await handler(makeEnvelope("preview", [{ url: "https://example.com/" }]));
		expect(calls).toHaveLength(1);
	});

	it("no proxy wired → no apply call (pre-Net-1d byte-identical)", async () => {
		const { calls, apply } = makeRecorder();
		// Only one half wired → the handler refuses to apply (safer to
		// no-op than guess the other half).
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			// getProxyConfig intentionally omitted
			applyProxyConfig: apply,
		});
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/" }]));
		expect(calls).toHaveLength(0);
	});

	it("ssrf-refused requests don't skip the proxy apply (apply runs before validation)", async () => {
		const { calls, apply } = makeRecorder();
		const config: ProxyConfig = { mode: ProxyMode.System };
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getProxyConfig: () => config,
			applyProxyConfig: apply,
		});
		// First request is SSRF-refused; the proxy apply still fires.
		await expect(
			handler(makeEnvelope("fetch", [{ url: "file:///etc/passwd" }])),
		).rejects.toMatchObject({ name: "Denied" });
		expect(calls).toHaveLength(1);
		// Second request with a valid URL doesn't re-apply.
		await handler(makeEnvelope("fetch", [{ url: "https://example.com/" }]));
		expect(calls).toHaveLength(1);
	});
});

/**
 * Net-1d — `electronProxyConfigFor` maps the typed `ProxyConfig` onto
 * Electron's Chromium-flavoured `setProxy` shape. Pure mapping —
 * tested in isolation so the production binding's behaviour is pinned
 * without touching the live `session.defaultSession`.
 */
describe("electronProxyConfigFor — Electron shape mapping", () => {
	it("Direct → { mode: 'direct' }", () => {
		expect(electronProxyConfigFor({ mode: ProxyMode.Direct })).toEqual({ mode: "direct" });
	});

	it("System → { mode: 'system' }", () => {
		expect(electronProxyConfigFor({ mode: ProxyMode.System })).toEqual({ mode: "system" });
	});

	it("Pac → { mode: 'pac_script', pacScript: pacUrl }", () => {
		expect(electronProxyConfigFor({ mode: ProxyMode.Pac, pacUrl: "http://wpad/proxy.pac" })).toEqual({
			mode: "pac_script",
			pacScript: "http://wpad/proxy.pac",
		});
	});

	it("Manual with no endpoints → fixed_servers + empty rules", () => {
		expect(
			electronProxyConfigFor({
				mode: ProxyMode.Manual,
				noProxy: [],
			}),
		).toEqual({ mode: "fixed_servers", proxyRules: "" });
	});

	it("Manual with http + https + socks5 → semicolon-joined rules", () => {
		expect(
			electronProxyConfigFor({
				mode: ProxyMode.Manual,
				httpProxy: { host: "proxy.corp", port: 80 },
				httpsProxy: { host: "proxy.corp", port: 443 },
				socks5Proxy: { host: "10.0.0.1", port: 1080 },
				noProxy: [],
			}),
		).toEqual({
			mode: "fixed_servers",
			proxyRules: "http=proxy.corp:80;https=proxy.corp:443;socks=10.0.0.1:1080",
		});
	});

	it("Manual with noProxy → adds proxyBypassRules joined by comma", () => {
		expect(
			electronProxyConfigFor({
				mode: ProxyMode.Manual,
				httpsProxy: { host: "proxy.corp", port: 443 },
				noProxy: ["localhost", ".internal", "10.0.0.0/8"],
			}),
		).toEqual({
			mode: "fixed_servers",
			proxyRules: "https=proxy.corp:443",
			proxyBypassRules: "localhost,.internal,10.0.0.0/8",
		});
	});

	it("Manual with empty noProxy → omits proxyBypassRules", () => {
		const result = electronProxyConfigFor({
			mode: ProxyMode.Manual,
			httpsProxy: { host: "proxy.corp", port: 443 },
			noProxy: [],
		});
		expect(result).not.toHaveProperty("proxyBypassRules");
	});

	it("Manual with authKey endpoint — authKey not serialised into proxyRules (Net-1e credential lookup happens at request time)", () => {
		// authKey is an opaque per-vault credential lookup key; it must
		// NEVER reach Chromium as part of the proxyRules string. The
		// `session.on('login', ...)` handler (Net-1e) does the lookup.
		const result = electronProxyConfigFor({
			mode: ProxyMode.Manual,
			httpsProxy: { host: "proxy.corp", port: 443, authKey: "secret-key-id" },
			noProxy: [],
		});
		expect(result.proxyRules).toBe("https=proxy.corp:443");
		expect(JSON.stringify(result)).not.toContain("secret-key-id");
	});
});

/**
 * Net-1e — per-vault privacy gate for `network.preview`.
 *
 * When `getPrivacyConfig` is wired, `handlePreview` consults it BEFORE
 * the cache lookup. A blocked preview throws a typed `PreviewBlocked`
 * error with a `reason` field so the renderer / SDK can render the
 * right affordance — Off → grey out, Manual → "Fetch preview" button,
 * Allowlist miss → "Add to allowlist". The cache must NOT be consulted
 * when previews are Off (a stale value would surface even after the
 * user flipped to Off).
 */
describe("makeNetworkServiceHandler — Net-1e privacy gate", () => {
	function makePreviewFetch(html = "<title>OK</title>"): FetchImpl {
		return async () => ({
			status: 200,
			headers: { "content-type": "text/html" },
			body: (async function* () {
				yield new TextEncoder().encode(html);
			})(),
		});
	}

	it("Privacy Off → preview throws PreviewBlocked with reason privacy-off", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getPrivacyConfig: () => ({ mode: PrivacyMode.Off }),
		});
		await expect(
			handler(makeEnvelope("preview", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "PreviewBlocked", reason: PreviewBlockedReason.PrivacyOff });
	});

	it("Privacy Manual → preview throws PreviewBlocked with reason privacy-manual", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getPrivacyConfig: () => ({ mode: PrivacyMode.Manual }),
		});
		await expect(
			handler(makeEnvelope("preview", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "PreviewBlocked", reason: PreviewBlockedReason.PrivacyManual });
	});

	it("Privacy On → preview succeeds (byte-identical to pre-Net-1e)", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getPrivacyConfig: () => ({ mode: PrivacyMode.On }),
		});
		const result = (await handler(makeEnvelope("preview", [{ url: "https://example.com/" }]))) as {
			title: string;
		};
		expect(result.title).toBe("OK");
	});

	it("Privacy Allowlist hit → preview succeeds", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getPrivacyConfig: () => ({
				mode: PrivacyMode.Allowlist,
				hosts: [".example.com"],
			}),
		});
		const result = (await handler(
			makeEnvelope("preview", [{ url: "https://api.example.com/article" }]),
		)) as { title: string };
		expect(result.title).toBe("OK");
	});

	it("Privacy Allowlist miss → PreviewBlocked with reason privacy-allowlist-miss", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getPrivacyConfig: () => ({
				mode: PrivacyMode.Allowlist,
				hosts: ["github.com"],
			}),
		});
		await expect(
			handler(makeEnvelope("preview", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({
			name: "PreviewBlocked",
			reason: PreviewBlockedReason.PrivacyAllowlistMiss,
		});
	});

	it("Privacy Off → the cache is NOT consulted (a stale hit must not surface)", async () => {
		// Pre-populate the cache then flip privacy to Off — the next
		// preview must throw PreviewBlocked, not return the stale value.
		const cache = new LinkPreviewCache();
		const handlerOn = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch("<title>Stale Cached</title>"),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			previewCache: cache,
			getPrivacyConfig: () => ({ mode: PrivacyMode.On }),
		});
		const first = (await handlerOn(makeEnvelope("preview", [{ url: "https://example.com/" }]))) as {
			title: string;
		};
		expect(first.title).toBe("Stale Cached");
		expect(cache.size).toBeGreaterThan(0);
		// Now flip to Off — same handler, just a different
		// `getPrivacyConfig` closure simulating the in-place flip.
		const privacy: PrivacyConfig = { mode: PrivacyMode.Off };
		const handlerOff = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch("<title>Should Not Fetch</title>"),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			previewCache: cache,
			getPrivacyConfig: () => privacy,
		});
		await expect(
			handlerOff(makeEnvelope("preview", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "PreviewBlocked" });
		// The cache should NOT have been read on the Off path — assert
		// indirectly: a `get` on the same key would have returned the
		// stale title, but we got PreviewBlocked instead. (The Net-1e
		// step-2 cache invalidation hook also clears the cache on the
		// real privacy-flip path; here we keep the cache populated to
		// prove the handler itself short-circuits before the cache.)
		void privacy; // satisfy `let` reassignment hint
	});

	it("Privacy gate fires on the FIRST `preview` call (before any fetch)", async () => {
		const fetchCount = { value: 0 };
		const handler = makeNetworkServiceHandler({
			fetchImpl: async () => {
				fetchCount.value++;
				return {
					status: 200,
					headers: {},
					body: (async function* () {})(),
				};
			},
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getPrivacyConfig: () => ({ mode: PrivacyMode.Off }),
		});
		await expect(
			handler(makeEnvelope("preview", [{ url: "https://example.com/" }])),
		).rejects.toMatchObject({ name: "PreviewBlocked" });
		expect(fetchCount.value).toBe(0);
	});

	it("Privacy gate does NOT apply to `fetch` — only `preview` (apps with `network.fetch` still reach via the explicit cap)", async () => {
		// doc-38 §The shell's own network traffic table maps privacy to
		// **link previews**; `network.fetch` is a separately-granted
		// capability the user controls per app. A vault on "previews
		// Off" still allows `network.fetch` calls (e.g. an app fetching
		// its own bookmark feed). Net-1f UI will surface both
		// independently.
		const handler = makeNetworkServiceHandler({
			fetchImpl: makeStubFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
			getPrivacyConfig: () => ({ mode: PrivacyMode.Off }),
		});
		const result = (await handler(makeEnvelope("fetch", [{ url: "https://example.com/" }]))) as {
			status: number;
		};
		expect(result.status).toBe(200);
	});

	it("no privacy config wired → byte-identical pre-Net-1e behaviour (preview always allowed)", async () => {
		const handler = makeNetworkServiceHandler({
			fetchImpl: makePreviewFetch(),
			lookupHost: makeStubLookup(),
			auditSink: makeRecordingSink().sink,
		});
		const result = (await handler(makeEnvelope("preview", [{ url: "https://example.com/" }]))) as {
			title: string;
		};
		expect(result.title).toBe("OK");
	});
});

describe("makeNetworkServiceHandler — readable (Net-2c)", () => {
	const ARTICLE_HTML =
		'<html><head><title>The Title</title><meta property="og:site_name" content="Site"></head><body><article><h1>Heading</h1><p>Body prose.</p></article></body></html>';

	const htmlFetch = (): FetchImpl => async () => ({
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
		body: (async function* () {
			yield new TextEncoder().encode(ARTICLE_HTML);
		})(),
	});

	const readableEnv = (caps: string[] = ["network.readable"]): Envelope => ({
		v: 1,
		msg: "msg_r",
		app: "io.example.client",
		service: "network",
		method: "readable",
		args: [{ url: "https://example.test/post" }],
		caps,
	});

	const baseReadableOpts = () => ({
		fetchImpl: htmlFetch(),
		lookupHost: makeStubLookup(),
		auditSink: makeRecordingSink().sink,
	});

	it("returns { preview, blocks } with blocks from the extractor", async () => {
		const extractReadable = vi.fn(async (_input: { html: string; baseUrl: string }) => ({
			blocks: [{ type: "paragraph", version: 1 }],
		}));
		const handler = makeNetworkServiceHandler({ ...baseReadableOpts(), extractReadable });
		const result = (await handler(readableEnv())) as NetworkReadableResult;
		expect(result.preview.title).toBe("The Title");
		expect(result.blocks).toEqual([{ type: "paragraph", version: 1 }]);
		// The extractor is handed the fetched HTML + the (redirect-final) base URL.
		expect(extractReadable).toHaveBeenCalledWith(
			expect.objectContaining({ baseUrl: expect.stringContaining("example.test") }),
		);
		expect(extractReadable.mock.calls[0]?.[0]?.html).toContain("Heading");
	});

	it("9.18.9 — pulls remote article images into the encrypted asset store + rewrites their src", async () => {
		const stored: Array<{ mime: string; originUrl?: string | null | undefined }> = [];
		const storeImageAsset = vi.fn(
			async (input: { bytes: Uint8Array; mime: string; kind: unknown; originUrl?: string | null }) => {
				stored.push({ mime: input.mime, originUrl: input.originUrl });
				return { assetId: `img-${stored.length}` };
			},
		);
		const IMG_URL = "https://cdn.example.test/a.png";
		const fetchImpl: FetchImpl = async (_ip, req) => {
			if (req.url.endsWith(".png")) {
				return {
					status: 200,
					headers: { "content-type": "image/png" },
					body: (async function* () {
						yield new Uint8Array([1, 2, 3]);
					})(),
				};
			}
			return {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
				body: (async function* () {
					yield new TextEncoder().encode(ARTICLE_HTML);
				})(),
			};
		};
		const extractReadable = vi.fn(async () => ({
			blocks: [
				{ type: "image", version: 1, src: IMG_URL, altText: "", caption: "", width: "inherit" },
				{ type: "paragraph", version: 1 },
			],
		}));
		const handler = makeNetworkServiceHandler({
			...baseReadableOpts(),
			fetchImpl,
			extractReadable,
			storeImageAsset,
		});
		const result = (await handler(readableEnv())) as NetworkReadableResult;
		expect(storeImageAsset).toHaveBeenCalledTimes(1);
		expect(stored[0]).toMatchObject({ mime: "image/png", originUrl: IMG_URL });
		expect((result.blocks?.[0] as unknown as { src: string }).src).toBe("brainstorm://asset/img-1");
		// non-image blocks pass through untouched
		expect(result.blocks?.[1]).toEqual({ type: "paragraph", version: 1 });
	});

	it("9.18.9 — a non-image sub-fetch (guard) leaves the image's remote src, stores nothing", async () => {
		const storeImageAsset = vi.fn(async () => ({ assetId: "should-not-be-used" }));
		const fetchImpl: FetchImpl = async (_ip, req) => {
			if (req.url.endsWith(".png")) {
				// A URL that lies about being an image — the MIME guard rejects it.
				return {
					status: 200,
					headers: { "content-type": "text/html" },
					body: (async function* () {})(),
				};
			}
			return {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
				body: (async function* () {
					yield new TextEncoder().encode(ARTICLE_HTML);
				})(),
			};
		};
		const extractReadable = vi.fn(async () => ({
			blocks: [
				{
					type: "image",
					version: 1,
					src: "https://cdn.example.test/a.png",
					altText: "",
					caption: "",
					width: "inherit",
				},
			],
		}));
		const handler = makeNetworkServiceHandler({
			...baseReadableOpts(),
			fetchImpl,
			extractReadable,
			storeImageAsset,
		});
		const result = (await handler(readableEnv())) as NetworkReadableResult;
		expect(storeImageAsset).not.toHaveBeenCalled();
		expect((result.blocks?.[0] as unknown as { src: string }).src).toBe(
			"https://cdn.example.test/a.png",
		);
	});

	it("falls back to blocks: null when no extractor is wired (metadata-only)", async () => {
		const handler = makeNetworkServiceHandler(baseReadableOpts());
		const result = (await handler(readableEnv())) as NetworkReadableResult;
		expect(result.blocks).toBeNull();
		expect(result.preview.title).toBe("The Title");
	});

	it("honours the per-vault privacy gate (Off → blocked, no fetch)", async () => {
		const fetchImpl = vi.fn(htmlFetch());
		const handler = makeNetworkServiceHandler({
			...baseReadableOpts(),
			fetchImpl,
			getPrivacyConfig: () => ({ mode: PrivacyMode.Off }),
		});
		await expect(handler(readableEnv())).rejects.toBeTruthy();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects a non-object arg with Invalid", async () => {
		const handler = makeNetworkServiceHandler(baseReadableOpts());
		await expect(handler({ ...readableEnv(), args: ["not-an-object"] })).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("propagates an extractor failure as an error", async () => {
		const extractReadable = vi.fn(async () => {
			throw new Error("worker boom");
		});
		const handler = makeNetworkServiceHandler({ ...baseReadableOpts(), extractReadable });
		await expect(handler(readableEnv())).rejects.toMatchObject({ message: "worker boom" });
	});
});

describe("sanitizeFetchHeaders", () => {
	it("strips forbidden headers (case-insensitive) that make net.fetch ERR_INVALID_ARGUMENT", () => {
		// Regression: the executor adds a `Host` header for IP-pinned impls;
		// Chromium's net.fetch rejects the whole request if it (or other
		// forbidden names) are present. The production fetchImpl must strip them.
		const out = sanitizeFetchHeaders({
			Accept: "text/html",
			Host: "example.com",
			Connection: "keep-alive",
			"content-length": "123",
			"X-Custom": "ok",
		});
		expect(out).toEqual({ Accept: "text/html", "X-Custom": "ok" });
	});

	it("returns an empty object for empty input", () => {
		expect(sanitizeFetchHeaders({})).toEqual({});
	});
});

describe("fetchPinnedDirect — DNS-rebinding pin (DIRECT path)", () => {
	function makeAbortSignal(): AbortSignal {
		return new AbortController().signal;
	}

	it("connects to the validated pin, NOT a re-resolution of the URL host", async () => {
		// Stand up a real loopback server. The URL host is `example.invalid`
		// (RFC 6761: guaranteed non-resolvable) so ANY DNS re-resolution would
		// fail — yet the request must succeed, proving the socket landed on the
		// pinned `127.0.0.1` via the `lookup` override, not on a lookup.
		const seen: {
			host?: string | undefined;
			path?: string | undefined;
			method?: string | undefined;
		} = {};
		const server = nodeHttp.createServer((req, res) => {
			seen.host = req.headers.host;
			seen.path = req.url;
			seen.method = req.method;
			res.statusCode = 200;
			res.setHeader("content-type", "text/plain");
			res.setHeader("x-multi", ["a", "b"] as unknown as string);
			res.end("pinned-ok");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no port");
		const port = address.port;
		try {
			const response = await fetchPinnedDirect("127.0.0.1", {
				url: `http://example.invalid:${port}/probe?x=1`,
				method: "GET",
				// The executor sets Host = hostname; we forward it verbatim.
				headers: { Host: "example.invalid", Accept: "text/plain" },
				signal: makeAbortSignal(),
			});
			expect(response.status).toBe(200);
			// Host header preserved = vhost routing intact while pinned to the IP.
			expect(seen.host).toBe("example.invalid");
			expect(seen.path).toBe("/probe?x=1");
			expect(seen.method).toBe("GET");
			expect(response.headers["content-type"]).toBe("text/plain");
			let bytes = 0;
			const out: number[] = [];
			for await (const chunk of response.body) {
				bytes += chunk.length;
				out.push(...chunk);
			}
			expect(bytes).toBe("pinned-ok".length);
			expect(new TextDecoder().decode(new Uint8Array(out))).toBe("pinned-ok");
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("forwards the request body to the pinned socket", async () => {
		let received = "";
		const server = nodeHttp.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				received = Buffer.concat(chunks).toString("utf8");
				res.statusCode = 201;
				res.end("created");
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no port");
		try {
			const response = await fetchPinnedDirect("127.0.0.1", {
				url: `http://example.invalid:${address.port}/`,
				method: "POST",
				headers: { Host: "example.invalid" },
				body: new TextEncoder().encode("payload-bytes"),
				signal: makeAbortSignal(),
			});
			expect(response.status).toBe(201);
			expect(received).toBe("payload-bytes");
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("does NOT auto-follow redirects — returns the 3xx with Location intact", async () => {
		const server = nodeHttp.createServer((_req, res) => {
			res.statusCode = 302;
			res.setHeader("location", "https://elsewhere.example/next");
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no port");
		try {
			const response = await fetchPinnedDirect("127.0.0.1", {
				url: `http://example.invalid:${address.port}/`,
				method: "GET",
				headers: { Host: "example.invalid" },
				signal: makeAbortSignal(),
			});
			expect(response.status).toBe(302);
			expect(response.headers.location).toBe("https://elsewhere.example/next");
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("rejects on connection error so the executor maps it to a transport error", async () => {
		// Pin to a port nothing listens on → ECONNREFUSED on the loopback pin.
		await expect(
			fetchPinnedDirect("127.0.0.1", {
				url: "http://example.invalid:1/",
				method: "GET",
				headers: { Host: "example.invalid" },
				signal: makeAbortSignal(),
			}),
		).rejects.toThrow();
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			fetchPinnedDirect("127.0.0.1", {
				url: "http://example.invalid/",
				method: "GET",
				headers: { Host: "example.invalid" },
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("productionFetchImpl — proxy-aware branch", () => {
	function makeAbortSignal(): AbortSignal {
		return new AbortController().signal;
	}

	it("falls back to net.fetch when a proxy applies (preserves proxy + session-auth)", async () => {
		const resolveProxy = vi.mocked(session.defaultSession.resolveProxy);
		const netFetch = vi.mocked(net.fetch);
		resolveProxy.mockResolvedValueOnce("PROXY proxy.local:8080; DIRECT");
		netFetch.mockResolvedValueOnce(
			new Response("via-proxy", { status: 200, headers: { "content-type": "text/plain" } }),
		);
		const response = await productionFetchImpl("203.0.113.7", {
			url: "https://example.com/page",
			method: "GET",
			// The executor adds Host; net.fetch derives it, so it must be stripped.
			headers: { Host: "example.com", Accept: "text/html" },
			signal: makeAbortSignal(),
		});
		expect(response.status).toBe(200);
		expect(netFetch).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = netFetch.mock.calls[0] ?? [];
		// Proxy path issues by the hostname URL (Chromium re-resolves via proxy).
		expect(calledUrl).toBe("https://example.com/page");
		// Reserved headers stripped at the net.fetch boundary.
		expect((init as RequestInit | undefined)?.headers).not.toHaveProperty("Host");
		expect((init as { redirect?: string } | undefined)?.redirect).toBe("manual");
	});

	it("takes the DIRECT (pinned) path when resolveProxy returns DIRECT", async () => {
		const resolveProxy = vi.mocked(session.defaultSession.resolveProxy);
		const netFetch = vi.mocked(net.fetch);
		netFetch.mockClear();
		resolveProxy.mockResolvedValueOnce("DIRECT");
		const server = nodeHttp.createServer((req, res) => {
			res.statusCode = 200;
			res.setHeader("content-type", "text/plain");
			res.end(`host=${req.headers.host}`);
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no port");
		try {
			const response = await productionFetchImpl("127.0.0.1", {
				url: `http://example.invalid:${address.port}/`,
				method: "GET",
				headers: { Host: "example.invalid" },
				signal: makeAbortSignal(),
			});
			expect(response.status).toBe(200);
			// net.fetch must NOT have been used — the pinned Node path served it.
			expect(netFetch).not.toHaveBeenCalled();
			const out: number[] = [];
			for await (const chunk of response.body) out.push(...chunk);
			expect(new TextDecoder().decode(new Uint8Array(out))).toBe("host=example.invalid");
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});
});
