import { describe, expect, it } from "vitest";
import { NetworkAuditOutcome, type NetworkAuditRecord } from "./audit-log";
import {
	type FetchImpl,
	type FetchImplResponse,
	type LookupHost,
	NetworkFetchError,
	NetworkFetchErrorKind,
	RedirectPolicy,
	executeNetworkFetch,
} from "./network-service";

const PUBLIC_IP = "93.184.216.34"; // example.com per IANA TEST-DOMAIN
const PRIVATE_IP = "10.0.0.5";

function makeBody(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	return (async function* () {
		yield bytes;
	})();
}

function makeChunkedBody(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
	return (async function* () {
		for (const chunk of chunks) yield chunk;
	})();
}

function makeStubFetch(response: FetchImplResponse): FetchImpl {
	return async () => response;
}

function makeRecordingSink(): { records: NetworkAuditRecord[]; sink: (line: string) => void } {
	const records: NetworkAuditRecord[] = [];
	return {
		records,
		sink: (line: string) => {
			records.push(JSON.parse(line) as NetworkAuditRecord);
		},
	};
}

describe("executeNetworkFetch — happy path", () => {
	it("fetches a public URL and returns body + filtered headers", async () => {
		const responseBody = new TextEncoder().encode("hello");
		const { records, sink } = makeRecordingSink();
		const result = await executeNetworkFetch(
			{
				appId: "app.test",
				url: "https://example.com/",
			},
			{
				fetchImpl: makeStubFetch({
					status: 200,
					headers: {
						"Content-Type": "text/plain",
						"Set-Cookie": "tracking=yes", // must be filtered out
						Server: "secret-server/1.0", // must be filtered out
					},
					body: makeBody(responseBody),
				}),
				lookupHost: async () => [PUBLIC_IP],
				auditSink: sink,
			},
		);
		expect(result.status).toBe(200);
		expect(result.body).toEqual(responseBody);
		expect(result.finalUrl).toBe("https://example.com/");
		expect(result.headers["content-type"]).toBe("text/plain");
		// Set-Cookie + Server are NOT forwarded
		expect(result.headers["set-cookie"]).toBeUndefined();
		expect(result.headers.server).toBeUndefined();
		expect(records).toHaveLength(1);
		expect(records[0]?.outcome).toBe(NetworkAuditOutcome.Completed);
		expect(records[0]?.bytes).toBe(5);
		expect(records[0]?.status).toBe(200);
	});

	it("forwards caller-supplied request headers and overrides Host", async () => {
		const seenHeaders: Record<string, string>[] = [];
		const fetchImpl: FetchImpl = async (_ip, req) => {
			seenHeaders.push({ ...req.headers });
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body: makeBody(new Uint8Array(0)),
			};
		};
		const { sink } = makeRecordingSink();
		await executeNetworkFetch(
			{
				appId: "app.test",
				url: "https://example.com/api",
				headers: {
					Accept: "application/json",
					Host: "evil.example.com", // attempt to override — must be ignored
					"Content-Length": "0", // reserved — must be dropped
				},
			},
			{
				fetchImpl,
				lookupHost: async () => [PUBLIC_IP],
				auditSink: sink,
			},
		);
		expect(seenHeaders[0]?.Accept).toBe("application/json");
		expect(seenHeaders[0]?.Host).toBe("example.com"); // broker-managed
		expect(seenHeaders[0]?.["Content-Length"]).toBeUndefined();
	});

	it("strips the URL query string from the audit log path", async () => {
		const { records, sink } = makeRecordingSink();
		await executeNetworkFetch(
			{
				appId: "app.test",
				url: "https://example.com/search?q=secret-token-xyz",
			},
			{
				fetchImpl: makeStubFetch({
					status: 200,
					headers: { "content-type": "text/plain" },
					body: makeBody(new Uint8Array(0)),
				}),
				lookupHost: async () => [PUBLIC_IP],
				auditSink: sink,
			},
		);
		expect(records[0]?.path).toBe("/search");
		expect(JSON.stringify(records[0])).not.toContain("secret-token-xyz");
	});
});

describe("executeNetworkFetch — SSRF gate", () => {
	it("refuses non-http schemes before any DNS lookup", async () => {
		const lookups: string[] = [];
		const lookupHost: LookupHost = async (host) => {
			lookups.push(host);
			return [PUBLIC_IP];
		};
		const { records, sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "file:///etc/passwd" },
				{
					fetchImpl: makeStubFetch({
						status: 200,
						headers: {},
						body: makeBody(new Uint8Array(0)),
					}),
					lookupHost,
					auditSink: sink,
				},
			),
		).rejects.toThrow(/non-http-scheme/);
		expect(lookups).toHaveLength(0);
		expect(records[0]?.outcome).toBe(NetworkAuditOutcome.Refused);
		expect(records[0]?.reason).toBe("non-http-scheme");
	});

	it("refuses localhost without DNS", async () => {
		const lookups: string[] = [];
		const { sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "http://localhost/admin" },
				{
					fetchImpl: makeStubFetch({
						status: 200,
						headers: {},
						body: makeBody(new Uint8Array(0)),
					}),
					lookupHost: async (host) => {
						lookups.push(host);
						return [PUBLIC_IP];
					},
					auditSink: sink,
				},
			),
		).rejects.toThrow(/local-hostname/);
		expect(lookups).toHaveLength(0);
	});

	it("refuses when DNS returns a private IP", async () => {
		let fetchCalled = false;
		const { records, sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "https://attacker.example/" },
				{
					fetchImpl: async () => {
						fetchCalled = true;
						return {
							status: 200,
							headers: {},
							body: makeBody(new Uint8Array(0)),
						};
					},
					lookupHost: async () => [PRIVATE_IP], // mixed-DNS attack
					auditSink: sink,
				},
			),
		).rejects.toMatchObject({ kind: NetworkFetchErrorKind.SsrfRefused });
		expect(fetchCalled).toBe(false);
		expect(records[0]?.outcome).toBe(NetworkAuditOutcome.Refused);
		expect(records[0]?.reason).toBe("private-ip");
	});

	it("refuses when ANY resolved IP is private (split DNS)", async () => {
		const { sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "https://attacker.example/" },
				{
					fetchImpl: makeStubFetch({
						status: 200,
						headers: {},
						body: makeBody(new Uint8Array(0)),
					}),
					lookupHost: async () => [PUBLIC_IP, PRIVATE_IP, "8.8.8.8"],
					auditSink: sink,
				},
			),
		).rejects.toThrow(/private-ip/);
	});

	it("re-validates redirect Location through the full SSRF gate", async () => {
		const seenUrls: string[] = [];
		const fetchImpl: FetchImpl = async (_ip, req) => {
			seenUrls.push(req.url);
			if (seenUrls.length === 1) {
				return {
					status: 302,
					headers: { Location: "http://10.0.0.1/internal" },
					body: makeBody(new Uint8Array(0)),
				};
			}
			return {
				status: 200,
				headers: {},
				body: makeBody(new Uint8Array(0)),
			};
		};
		const { records, sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "https://example.com/" },
				{
					fetchImpl,
					lookupHost: async () => [PUBLIC_IP],
					auditSink: sink,
				},
			),
		).rejects.toThrow(/ssrf-refused/);
		expect(seenUrls).toHaveLength(1); // never followed the bad redirect
		expect(records.find((r) => r.reason === "private-ip")).toBeDefined();
	});

	it("refuses blocked ports (SSH:22) even on public IP", async () => {
		const { sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "https://example.com:22/" },
				{
					fetchImpl: makeStubFetch({
						status: 200,
						headers: {},
						body: makeBody(new Uint8Array(0)),
					}),
					lookupHost: async () => [PUBLIC_IP],
					auditSink: sink,
				},
			),
		).rejects.toThrow(/blocked-port/);
	});
});

describe("executeNetworkFetch — redirects", () => {
	it("follows a public-to-public redirect to a 200", async () => {
		let hop = 0;
		const fetchImpl: FetchImpl = async (_ip, req) => {
			hop += 1;
			if (hop === 1) {
				expect(req.url).toBe("https://example.com/");
				return {
					status: 301,
					headers: { Location: "https://example.com/final" },
					body: makeBody(new Uint8Array(0)),
				};
			}
			expect(req.url).toBe("https://example.com/final");
			return {
				status: 200,
				headers: { "content-type": "text/plain" },
				body: makeBody(new TextEncoder().encode("done")),
			};
		};
		const { records, sink } = makeRecordingSink();
		const result = await executeNetworkFetch(
			{ appId: "app.test", url: "https://example.com/" },
			{
				fetchImpl,
				lookupHost: async () => [PUBLIC_IP],
				auditSink: sink,
			},
		);
		expect(result.status).toBe(200);
		expect(result.finalUrl).toBe("https://example.com/final");
		expect(records).toHaveLength(1); // only the final 200 is audited as completed
	});

	it("strips Authorization/Cookie on a cross-origin redirect but keeps them same-origin", async () => {
		const seen: Array<{ url: string; auth: string | undefined; cookie: string | undefined }> = [];
		const fetchImpl: FetchImpl = async (_ip, req) => {
			seen.push({ url: req.url, auth: req.headers?.authorization, cookie: req.headers?.cookie });
			if (req.url === "https://example.com/") {
				return {
					status: 302,
					headers: { Location: "https://example.com/same" },
					body: makeBody(new Uint8Array(0)),
				};
			}
			if (req.url === "https://example.com/same") {
				return {
					status: 302,
					headers: { Location: "https://evil.test/steal" },
					body: makeBody(new Uint8Array(0)),
				};
			}
			return {
				status: 200,
				headers: { "content-type": "text/plain" },
				body: makeBody(new TextEncoder().encode("ok")),
			};
		};
		const { sink } = makeRecordingSink();
		await executeNetworkFetch(
			{
				appId: "app.test",
				url: "https://example.com/",
				headers: { authorization: "Bearer SECRET", cookie: "sid=1" },
			},
			{ fetchImpl, lookupHost: async () => [PUBLIC_IP], auditSink: sink },
		);
		// same-origin hop keeps the credentials; the cross-origin hop to evil.test must not.
		expect(seen[0]).toMatchObject({ auth: "Bearer SECRET", cookie: "sid=1" });
		expect(seen[1]).toMatchObject({ auth: "Bearer SECRET", cookie: "sid=1" });
		expect(seen[2]?.url).toBe("https://evil.test/steal");
		expect(seen[2]?.auth).toBeUndefined();
		expect(seen[2]?.cookie).toBeUndefined();
	});

	it("strips the x-api-key custom credential header on a cross-origin redirect (11.6)", async () => {
		// The AI broker's Anthropic provider authenticates with `x-api-key`; a
		// redirect off the intended host must not carry the key to a third party.
		const seenKeys: Array<string | undefined> = [];
		const fetchImpl: FetchImpl = async (_ip, req) => {
			seenKeys.push(req.headers?.["x-api-key"]);
			if (req.url === "https://api.anthropic.com/v1/messages") {
				return {
					status: 302,
					headers: { Location: "https://evil.test/steal" },
					body: makeBody(new Uint8Array(0)),
				};
			}
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body: makeBody(new TextEncoder().encode("{}")),
			};
		};
		const { sink } = makeRecordingSink();
		await executeNetworkFetch(
			{
				appId: "_shell.ai",
				url: "https://api.anthropic.com/v1/messages",
				method: "POST",
				headers: { "x-api-key": "sk-ant-SECRET", "anthropic-version": "2023-06-01" },
			},
			{ fetchImpl, lookupHost: async () => [PUBLIC_IP], auditSink: sink },
		);
		expect(seenKeys[0]).toBe("sk-ant-SECRET"); // intended host gets it
		expect(seenKeys[1]).toBeUndefined(); // cross-origin redirect target must not
	});

	it("aborts after MAX_REDIRECTS hops", async () => {
		const fetchImpl: FetchImpl = async (_ip, req) => {
			const u = new URL(req.url);
			const next = `${u.origin}${u.pathname}/x`;
			return {
				status: 302,
				headers: { Location: next },
				body: makeBody(new Uint8Array(0)),
			};
		};
		const { records, sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "https://example.com/" },
				{
					fetchImpl,
					lookupHost: async () => [PUBLIC_IP],
					auditSink: sink,
				},
			),
		).rejects.toThrow(/too-many-redirects/);
		expect(records.some((r) => r.reason === "too-many-redirects")).toBe(true);
	});

	it("resolves relative Location headers", async () => {
		let hop = 0;
		const seenUrls: string[] = [];
		const fetchImpl: FetchImpl = async (_ip, req) => {
			hop += 1;
			seenUrls.push(req.url);
			if (hop === 1) {
				return {
					status: 302,
					headers: { Location: "/elsewhere" },
					body: makeBody(new Uint8Array(0)),
				};
			}
			return {
				status: 200,
				headers: { "content-type": "text/plain" },
				body: makeBody(new Uint8Array(0)),
			};
		};
		const { sink } = makeRecordingSink();
		const result = await executeNetworkFetch(
			{ appId: "app.test", url: "https://example.com/path" },
			{
				fetchImpl,
				lookupHost: async () => [PUBLIC_IP],
				auditSink: sink,
			},
		);
		expect(seenUrls).toEqual(["https://example.com/path", "https://example.com/elsewhere"]);
		expect(result.finalUrl).toBe("https://example.com/elsewhere");
	});
});

describe("executeNetworkFetch — caps", () => {
	it("aborts when response body exceeds size cap", async () => {
		const big = new Uint8Array(1024 * 1024 + 1); // 1 MiB + 1 byte
		const { records, sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "https://example.com/big" },
				{
					fetchImpl: makeStubFetch({
						status: 200,
						headers: { "content-type": "application/octet-stream" },
						body: makeBody(big),
					}),
					lookupHost: async () => [PUBLIC_IP],
					auditSink: sink,
				},
			),
		).rejects.toThrow(/size-cap/);
		expect(records[0]?.outcome).toBe(NetworkAuditOutcome.Aborted);
		expect(records[0]?.reason).toBe("size-cap");
	});

	it("aborts mid-stream when size cap exceeded by chunks", async () => {
		const chunks = [
			new Uint8Array(512 * 1024), // 512 KB
			new Uint8Array(512 * 1024), // 512 KB
			new Uint8Array(1), // overflow
		];
		const { sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "https://example.com/big" },
				{
					fetchImpl: makeStubFetch({
						status: 200,
						headers: {},
						body: makeChunkedBody(chunks),
					}),
					lookupHost: async () => [PUBLIC_IP],
					auditSink: sink,
				},
			),
		).rejects.toThrow(/size-cap/);
	});

	it("respects custom sizeCapBytes override", async () => {
		const { sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{
					appId: "app.test",
					url: "https://example.com/small",
					sizeCapBytes: 100,
				},
				{
					fetchImpl: makeStubFetch({
						status: 200,
						headers: {},
						body: makeBody(new Uint8Array(200)),
					}),
					lookupHost: async () => [PUBLIC_IP],
					auditSink: sink,
				},
			),
		).rejects.toThrow(/size-cap/);
	});

	it("accepts body exactly at the cap", async () => {
		const { sink } = makeRecordingSink();
		const result = await executeNetworkFetch(
			{
				appId: "app.test",
				url: "https://example.com/",
				sizeCapBytes: 100,
			},
			{
				fetchImpl: makeStubFetch({
					status: 200,
					headers: { "content-type": "text/plain" },
					body: makeBody(new Uint8Array(100)),
				}),
				lookupHost: async () => [PUBLIC_IP],
				auditSink: sink,
			},
		);
		expect(result.body.length).toBe(100);
	});

	it("truncates to the cap (no throw) when truncateOnSizeCap is set", async () => {
		// Regression: large pages (Wikipedia ≈1 MB) must still preview — the
		// <head> is in the first bytes. Multiple chunks overflow the cap; we
		// keep exactly `sizeCapBytes` and return normally.
		const { sink } = makeRecordingSink();
		const result = await executeNetworkFetch(
			{
				appId: "app.test",
				url: "https://example.com/large",
				sizeCapBytes: 100,
				truncateOnSizeCap: true,
			},
			{
				fetchImpl: makeStubFetch({
					status: 200,
					headers: { "content-type": "text/html" },
					body: makeChunkedBody([new Uint8Array(60), new Uint8Array(60), new Uint8Array(60)]),
				}),
				lookupHost: async () => [PUBLIC_IP],
				auditSink: sink,
			},
		);
		expect(result.body.length).toBe(100); // truncated exactly at the cap
		expect(result.status).toBe(200);
	});
});

describe("executeNetworkFetch — DNS + transport errors", () => {
	it("throws DnsFailure when lookupHost rejects", async () => {
		const { records, sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "https://example.com/" },
				{
					fetchImpl: makeStubFetch({
						status: 200,
						headers: {},
						body: makeBody(new Uint8Array(0)),
					}),
					lookupHost: async () => {
						throw new Error("ENOTFOUND");
					},
					auditSink: sink,
				},
			),
		).rejects.toMatchObject({ kind: NetworkFetchErrorKind.DnsFailure });
		expect(records[0]?.outcome).toBe(NetworkAuditOutcome.Errored);
	});

	it("throws DnsFailure when lookupHost returns empty", async () => {
		const { sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "https://example.com/" },
				{
					fetchImpl: makeStubFetch({
						status: 200,
						headers: {},
						body: makeBody(new Uint8Array(0)),
					}),
					lookupHost: async () => [],
					auditSink: sink,
				},
			),
		).rejects.toThrow(/no IPs resolved/);
	});

	it("throws TransportError when fetchImpl throws (non-abort)", async () => {
		const { records, sink } = makeRecordingSink();
		await expect(
			executeNetworkFetch(
				{ appId: "app.test", url: "https://example.com/" },
				{
					fetchImpl: async () => {
						throw new Error("TLS handshake failed");
					},
					lookupHost: async () => [PUBLIC_IP],
					auditSink: sink,
				},
			),
		).rejects.toMatchObject({ kind: NetworkFetchErrorKind.TransportError });
		expect(records[0]?.outcome).toBe(NetworkAuditOutcome.Errored);
	});
});

describe("executeNetworkFetch — audit hygiene", () => {
	it("never logs request body or response body content", async () => {
		const { records, sink } = makeRecordingSink();
		await executeNetworkFetch(
			{
				appId: "app.test",
				url: "https://example.com/",
				body: new TextEncoder().encode("secret-request-body"),
			},
			{
				fetchImpl: makeStubFetch({
					status: 200,
					headers: { "content-type": "text/plain" },
					body: makeBody(new TextEncoder().encode("secret-response-body")),
				}),
				lookupHost: async () => [PUBLIC_IP],
				auditSink: sink,
			},
		);
		const serialized = JSON.stringify(records);
		expect(serialized).not.toContain("secret-request-body");
		expect(serialized).not.toContain("secret-response-body");
	});

	it("records appId, method, host, status, bytes, durationMs", async () => {
		const { records, sink } = makeRecordingSink();
		await executeNetworkFetch(
			{
				appId: "io.example.client",
				url: "https://api.example.com:8443/v1/widgets",
				method: "post",
			},
			{
				fetchImpl: makeStubFetch({
					status: 201,
					headers: { "content-type": "application/json" },
					body: makeBody(new Uint8Array(42)),
				}),
				lookupHost: async () => [PUBLIC_IP],
				auditSink: sink,
			},
		);
		const r = records[0];
		expect(r).toBeDefined();
		expect(r?.appId).toBe("io.example.client");
		expect(r?.method).toBe("POST");
		expect(r?.host).toBe("api.example.com:8443");
		expect(r?.status).toBe(201);
		expect(r?.bytes).toBe(42);
		expect(typeof r?.durationMs).toBe("number");
	});
});

describe("executeNetworkFetch — RedirectPolicy.Strict (Agent-14)", () => {
	const redirectTo = (location: string, status = 302): FetchImpl => {
		const seen: string[] = [];
		const impl: FetchImpl = async (_ip, req) => {
			seen.push(req.url);
			if (seen.length === 1) {
				return { status, headers: { Location: location }, body: makeBody(new Uint8Array(0)) };
			}
			return { status: 200, headers: {}, body: makeBody(new TextEncoder().encode("ok")) };
		};
		return Object.assign(impl, { seen });
	};
	const run = (
		fetchImpl: FetchImpl,
		over: Partial<Parameters<typeof executeNetworkFetch>[0]>,
		lookupHost: LookupHost = async () => [PUBLIC_IP],
	) =>
		executeNetworkFetch(
			{
				appId: "_shell.ai",
				url: "https://api.example.com/v1",
				redirectPolicy: RedirectPolicy.Strict,
				...over,
			},
			{ fetchImpl, lookupHost, auditSink: () => undefined },
		);

	it("refuses to re-POST the body on a redirect, even same-origin 307", async () => {
		const impl = redirectTo("https://api.example.com/v2", 307);
		await expect(
			run(impl, { method: "POST", body: new TextEncoder().encode("{}") }),
		).rejects.toMatchObject({ kind: NetworkFetchErrorKind.RedirectRefused });
		expect((impl as unknown as { seen: string[] }).seen).toHaveLength(1);
	});

	it("refuses an https → http downgrade", async () => {
		await expect(run(redirectTo("http://api.example.com/v1"), {})).rejects.toMatchObject({
			kind: NetworkFetchErrorKind.RedirectRefused,
		});
	});

	it("does not carry allowPrivate to a different host a LAN endpoint redirects to", async () => {
		const impl = redirectTo("http://169.254.169.254/latest");
		await expect(
			run(impl, { url: "http://10.0.0.5:8080/v1", allowPrivate: true }, async (h) =>
				h === "10.0.0.5" ? [PRIVATE_IP] : ["169.254.169.254"],
			),
		).rejects.toMatchObject({ kind: NetworkFetchErrorKind.SsrfRefused });
	});

	it("still follows a harmless same-origin GET redirect", async () => {
		const res = await run(redirectTo("https://api.example.com/v1/"), {});
		expect(res.status).toBe(200);
	});

	it("leaves the default policy unchanged", async () => {
		const res = await executeNetworkFetch(
			{ appId: "app.test", url: "https://example.com/", method: "POST", body: new Uint8Array([1]) },
			{ fetchImpl: redirectTo("https://example.com/x", 307), lookupHost: async () => [PUBLIC_IP] },
		);
		expect(res.status).toBe(200);
	});
});
