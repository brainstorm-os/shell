/**
 * Net-1a step 2 — core network-broker `fetch` execution.
 *
 * Wires the step-0 SSRF guard, the response/time caps, the audit-log
 * writer, and the DNS-pinning machinery into one async function that
 * takes a request + a fetch-impl injection and returns a response or a
 * typed rejection. IPC envelope wiring + capability check happens in
 * step 3 (the dev-MCP service handler) — this module stays pure-logic +
 * injectable so unit tests can drive it with a fake fetch.
 *
 * Per ` §The network broker`:
 *
 *   1. Pre-DNS SSRF check on the URL (scheme, port, local-hostname).
 *   2. Resolve hostname → IPs via injected `lookupHost`. Reject the
 *      request if ANY resolved IP fails the post-DNS SSRF check (defeats
 *      mixed public/private DNS responses).
 *   3. Pin the request to the first validated IP. The Host header
 *      preserves the original hostname so the upstream server's vhost
 *      routing keeps working; the TLS SNI travels with the hostname too.
 *      DNS rebinding defeated: even if a later lookup returns a private
 *      IP, the broker connects to the IP it already validated.
 *   4. Issue the request via the injected `fetchImpl`. Production binds
 *      Electron's `net.fetch` here; tests bind a deterministic stub.
 *   5. Enforce response-size + total-time caps. Either trips a structured
 *      `Aborted` rejection rather than a partial response.
 *   6. Re-validate redirects: every Location header runs back through
 *      step 1+2 before the broker follows it. Hop count capped.
 *   7. Write the audit record, return the response.
 *
 * The broker NEVER echoes the user's IP, the TLS certificate chain, or
 * the raw response headers list to the caller — only the allowed-list
 * fields on `NetworkFetchResponse`. That contract is enforced here, not
 * at the IPC boundary, so future callers can't accidentally widen the
 * surface.
 */

import {
	NetworkAuditOutcome,
	type NetworkAuditRecord,
	type NetworkAuditSink,
	hostOf,
	pathOf,
	recordAudit,
} from "./audit-log";
import { type SsrfCheck, checkResolvedIp, checkUrl } from "./ssrf-guard";

/** Maximum HTTP redirect hops the broker will follow. Hardcoded — apps
 *  needing more are doing something the broker doesn't want to host. */
export const MAX_REDIRECTS = 5;

/** Defaults the IPC envelope's `opts` overrides on a per-call basis. */
export const DEFAULT_SIZE_CAP_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_TIMEOUT_MS = 5_000;

export type NetworkFetchRequest = {
	/** Calling app's id for audit log + capability check. */
	readonly appId: string;
	/** Request URL as the renderer supplied it. Validated immediately. */
	readonly url: string;
	/** HTTP method. Defaults to GET. The broker UPPER-cases this. */
	readonly method?: string;
	/** Request headers the broker will forward AS-IS. Some headers (Host,
	 *  Connection, Content-Length) are managed by the broker and override
	 *  any caller value; warning logged when the caller tried to set one. */
	readonly headers?: Readonly<Record<string, string>>;
	/** Request body bytes. Caller controls the encoding (Content-Type). */
	readonly body?: Uint8Array;
	/** Max response bytes the broker will accept. Default 1 MiB. */
	readonly sizeCapBytes?: number;
	/** When true, a response that exceeds `sizeCapBytes` is **truncated** to
	 *  the cap and returned, instead of rejected with `SizeCap`. Used by the
	 *  preview path: a page's `<head>` (OG/JSON-LD) lives in the first bytes,
	 *  so a 1 MB Wikipedia page still previews from its first 64 KiB. Default
	 *  false (reject) keeps `fetch` / `readable` byte-exact. */
	readonly truncateOnSizeCap?: boolean;
	/** Total time budget (broker entry → final response). Default 5 s. */
	readonly timeoutMs?: number;
	/** Net-1b — when true, the caller holds the `network.fetch.private`
	 *  capability and the broker accepts private / loopback / link-local
	 *  IP destinations that the default `network.fetch` cap rejects.
	 *  The SSRF guard's *floor* (malformed URL, non-HTTP scheme, blocked
	 *  port, local-hostname pattern) still applies — `.private` only
	 *  relaxes the `PrivateIp` classification, never the floor. Default
	 *  false (public internet only) keeps every existing caller working
	 *  with zero regression. */
	readonly allowPrivate?: boolean;
	/** How a 3xx is treated. Default {@link RedirectPolicy.Follow}. */
	readonly redirectPolicy?: RedirectPolicy;
};

export enum RedirectPolicy {
	/** Follow up to {@link MAX_REDIRECTS} hops, each through the SSRF gate. */
	Follow = "follow",
	/** For credential- or transcript-bearing calls. A hop is refused when it
	 *  would re-send a request body, downgrade https → http, or land on a
	 *  private address the ORIGINAL origin was not granted — `allowPrivate` is
	 *  the user trusting one LAN endpoint, not every host it bounces to. */
	Strict = "strict",
}

export type NetworkFetchResponse = {
	/** Final HTTP status code. */
	readonly status: number;
	/** Response headers — minimally-filtered allowlist (Content-Type,
	 *  Content-Length, Cache-Control, ETag, Last-Modified, Link). Caller
	 *  never sees Set-Cookie / Set-Cookie2 / Server / X-* etc. */
	readonly headers: Readonly<Record<string, string>>;
	/** Response body bytes. Empty Uint8Array on bodyless responses. */
	readonly body: Uint8Array;
	/** Final URL after redirects (or the original URL if no redirect). */
	readonly finalUrl: string;
};

export enum NetworkFetchErrorKind {
	/** URL or resolved IP failed the SSRF guard. */
	SsrfRefused = "ssrf-refused",
	/** Hostname couldn't be resolved at all. */
	DnsFailure = "dns-failure",
	/** Response exceeded the configured size cap. */
	SizeCap = "size-cap",
	/** Request didn't complete inside `timeoutMs`. */
	Timeout = "timeout",
	/** Too many Location redirects. */
	TooManyRedirects = "too-many-redirects",
	/** A redirect {@link RedirectPolicy.Strict} does not allow. */
	RedirectRefused = "redirect-refused",
	/** Underlying fetch threw (TLS / connect / read). */
	TransportError = "transport-error",
}

export class NetworkFetchError extends Error {
	override readonly name = "NetworkFetchError";
	readonly kind: NetworkFetchErrorKind;
	readonly detail: string;
	constructor(kind: NetworkFetchErrorKind, detail: string) {
		super(`${kind}: ${detail}`);
		this.kind = kind;
		this.detail = detail;
	}
}

function strictRedirectRefusal(
	method: string,
	body: Uint8Array | undefined,
	fromUrl: string,
	toUrl: string,
): string | null {
	if ((body !== undefined && body.length > 0) || (method !== "GET" && method !== "HEAD")) {
		return "redirect-would-resend-body";
	}
	try {
		if (new URL(fromUrl).protocol === "https:" && new URL(toUrl).protocol !== "https:") {
			return "redirect-downgrades-tls";
		}
	} catch {
		return "redirect-malformed";
	}
	return null;
}

/** Headers the broker manages itself — overriding any caller-supplied value. */
const RESERVED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"proxy-authorization",
	"proxy-connection",
	"upgrade",
]);

/** Credential-bearing headers stripped on a cross-origin redirect so a token
 *  never follows a Location to a different origin (browser/fetch semantics).
 *  Covers the standard auth headers plus custom API-key headers that callers
 *  use to authenticate (e.g. the AI broker's Anthropic `x-api-key`, 11.6) —
 *  any of these following a redirect off the intended host would leak the
 *  credential to a third party. Compared case-insensitively. */
const CROSS_ORIGIN_STRIPPED_HEADERS: ReadonlySet<string> = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
	"x-api-key",
	"api-key",
]);

/** Origin (scheme://host:port) of a URL, or "" if unparseable — an unparseable
 *  URL compares unequal to every real origin, so it fails closed (headers
 *  stripped). */
function safeOrigin(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}

/** Response headers the broker forwards to the caller. Anything else is
 *  dropped (Set-Cookie, Server, X-Powered-By, ETag-too-revealing,...).
 *  Keep this list narrow; widen only with explicit review. */
const ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
	"content-type",
	"content-length",
	"content-language",
	"content-disposition",
	"cache-control",
	"etag",
	"last-modified",
	"expires",
	"link",
]);

/** Signature for the injected fetch primitive. Production binds
 *  Electron's `net.fetch`; tests bind a deterministic stub. The broker
 *  passes an AbortController whose signal it owns + the resolved IP so
 *  the impl can pin to it.
 *
 *  The impl MUST follow zero redirects on its own — the broker handles
 *  redirect re-validation manually so SSRF check fires per-hop. */
export type FetchImpl = (
	resolvedIp: string,
	request: {
		readonly url: string;
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body?: Uint8Array;
		readonly signal: AbortSignal;
	},
) => Promise<FetchImplResponse>;

export type FetchImplResponse = {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	/** Body iterator. The broker drains it under the size cap so a malicious
	 *  server can't fill memory by promising a small Content-Length and
	 *  streaming gigabytes. */
	readonly body: AsyncIterable<Uint8Array>;
};

/** Signature for the DNS lookup primitive. Returns ALL resolved IPs so
 *  the broker can reject if any one is private (split-horizon DNS attack).
 *  Production binds `dns.promises.lookup(host, {all: true, verbatim: true})`. */
export type LookupHost = (host: string) => Promise<readonly string[]>;

export type ExecuteOptions = {
	readonly fetchImpl: FetchImpl;
	readonly lookupHost: LookupHost;
	readonly auditSink: NetworkAuditSink;
	readonly now?: () => number;
};

/**
 * Execute one brokered network fetch. Pure-async — every IO dependency
 * is injected so the unit suite can drive it with a deterministic stub.
 */
export async function executeNetworkFetch(
	request: NetworkFetchRequest,
	opts: ExecuteOptions,
): Promise<NetworkFetchResponse> {
	const now = opts.now ?? Date.now;
	const startMs = now();
	const sizeCapBytes = request.sizeCapBytes ?? DEFAULT_SIZE_CAP_BYTES;
	const truncateOnSizeCap = request.truncateOnSizeCap ?? false;
	const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const method = (request.method ?? "GET").toUpperCase();

	let currentUrl = request.url;
	let redirectCount = 0;
	const requestOrigin = safeOrigin(request.url);

	const writeAudit = async (
		urlForRecord: string,
		status: number,
		bytes: number,
		outcome: NetworkAuditOutcome,
		reason: string,
	): Promise<void> => {
		const rec: NetworkAuditRecord = {
			ts: now(),
			appId: request.appId,
			method,
			host: hostOf(urlForRecord),
			path: pathOf(urlForRecord),
			status,
			bytes,
			durationMs: now() - startMs,
			outcome,
			reason,
		};
		await recordAudit(opts.auditSink, rec);
	};

	// Per-call AbortController owns the overall time budget. Per-hop fetches
	// share the signal so a deadline mid-redirect aborts the active impl.
	const controller = new AbortController();
	const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

	try {
		while (true) {
			// 1. Pre-DNS SSRF check. Net-1b: `.private` caller relaxes the
			// `PrivateIp` (when the URL is a literal private IP) and the
			// `LocalHostname` pattern rejections; the rest of the floor
			// (non-HTTP scheme, malformed URL, blocked port, IDN decode)
			// still wins — `.private` only trades local network for the cap.
			const strict = request.redirectPolicy === RedirectPolicy.Strict;
			const allowPrivate =
				(request.allowPrivate ?? false) &&
				(!strict || redirectCount === 0 || safeOrigin(currentUrl) === requestOrigin);
			const preCheck = checkUrl(currentUrl, { allowPrivate });
			if (!preCheck.ok) {
				await writeAudit(currentUrl, 0, 0, NetworkAuditOutcome.Refused, preCheck.reason);
				throw new NetworkFetchError(
					NetworkFetchErrorKind.SsrfRefused,
					`${preCheck.reason}: ${preCheck.detail}`,
				);
			}

			// 2. DNS resolve + post-resolution SSRF check on every returned IP.
			let resolvedIps: readonly string[];
			try {
				resolvedIps = await opts.lookupHost(preCheck.hostname);
			} catch (error) {
				await writeAudit(currentUrl, 0, 0, NetworkAuditOutcome.Errored, "dns-lookup-failed");
				throw new NetworkFetchError(
					NetworkFetchErrorKind.DnsFailure,
					`could not resolve ${preCheck.hostname}: ${(error as Error).message}`,
				);
			}
			if (resolvedIps.length === 0) {
				await writeAudit(currentUrl, 0, 0, NetworkAuditOutcome.Errored, "dns-empty");
				throw new NetworkFetchError(
					NetworkFetchErrorKind.DnsFailure,
					`no IPs resolved for ${preCheck.hostname}`,
				);
			}
			let pinnedIp: string | null = null;
			let lastRejection: SsrfCheck | null = null;
			for (const ip of resolvedIps) {
				const ipCheck = checkResolvedIp(ip, { allowPrivate });
				if (ipCheck.ok) {
					// Pin to the first valid IP. We could try the others — but
					// the contract says "every resolved IP must pass", so the
					// fail-fast on ANY rejection is the safer default.
					pinnedIp = ip;
				} else {
					lastRejection = ipCheck;
					break;
				}
			}
			if (lastRejection !== null) {
				const detail = lastRejection.ok ? "unreachable" : lastRejection.detail;
				const reason = lastRejection.ok ? "" : lastRejection.reason;
				await writeAudit(currentUrl, 0, 0, NetworkAuditOutcome.Refused, reason);
				throw new NetworkFetchError(
					NetworkFetchErrorKind.SsrfRefused,
					reason.length > 0 ? `${reason}: ${detail}` : detail,
				);
			}
			if (pinnedIp === null) {
				await writeAudit(currentUrl, 0, 0, NetworkAuditOutcome.Refused, "no-valid-ip");
				throw new NetworkFetchError(
					NetworkFetchErrorKind.SsrfRefused,
					`no valid IP resolved for ${preCheck.hostname}`,
				);
			}

			// 3. Forward request headers minus reserved ones. Credential-bearing
			//    headers (Authorization/Cookie — e.g. the connector broker's
			//    injected `Bearer`) are dropped the moment a redirect crosses to a
			//    different origin, the same rule browsers/fetch enforce: an
			//    in-scope host that 302s elsewhere must never carry the token to a
			//    third party. The per-hop SSRF gate only blocks private IPs, not
			//    cross-origin egress, so this strip is the token's only guard here.
			const crossOrigin = safeOrigin(currentUrl) !== requestOrigin;
			const forwardHeaders: Record<string, string> = {};
			for (const [k, v] of Object.entries(request.headers ?? {})) {
				const key = k.toLowerCase();
				if (RESERVED_REQUEST_HEADERS.has(key)) continue;
				if (crossOrigin && CROSS_ORIGIN_STRIPPED_HEADERS.has(key)) continue;
				forwardHeaders[k] = v;
			}
			// Manage Host header ourselves so the upstream vhost routing works
			// even when the request is pinned to an IP.
			forwardHeaders.Host = preCheck.hostname;

			// 4. Issue the request.
			let impl: FetchImplResponse;
			try {
				impl = await opts.fetchImpl(pinnedIp, {
					url: preCheck.canonicalUrl,
					method,
					headers: forwardHeaders,
					...(request.body !== undefined ? { body: request.body } : {}),
					signal: controller.signal,
				});
			} catch (error) {
				const e = error as Error;
				if (controller.signal.aborted) {
					await writeAudit(currentUrl, 0, 0, NetworkAuditOutcome.Aborted, "timeout");
					throw new NetworkFetchError(NetworkFetchErrorKind.Timeout, `exceeded ${timeoutMs}ms`);
				}
				await writeAudit(currentUrl, 0, 0, NetworkAuditOutcome.Errored, "transport");
				throw new NetworkFetchError(NetworkFetchErrorKind.TransportError, e.message);
			}

			// 5. Redirect handling — re-validate the Location URL through the
			//    full SSRF gate before following.
			if (impl.status >= 300 && impl.status < 400) {
				const location = impl.headers.location ?? impl.headers.Location;
				if (location !== undefined && typeof location === "string") {
					// Drain the redirect's body so the impl can release the
					// socket. We don't store the bytes — caller never sees a
					// redirect body anyway.
					for await (const _chunk of impl.body) {
						// no-op
					}
					redirectCount += 1;
					if (redirectCount > MAX_REDIRECTS) {
						await writeAudit(
							currentUrl,
							impl.status,
							0,
							NetworkAuditOutcome.Aborted,
							"too-many-redirects",
						);
						throw new NetworkFetchError(
							NetworkFetchErrorKind.TooManyRedirects,
							`exceeded ${MAX_REDIRECTS}`,
						);
					}
					const nextUrl = resolveRelativeUrl(currentUrl, location);
					if (strict) {
						const refusal = strictRedirectRefusal(method, request.body, currentUrl, nextUrl);
						if (refusal) {
							await writeAudit(currentUrl, impl.status, 0, NetworkAuditOutcome.Refused, refusal);
							throw new NetworkFetchError(NetworkFetchErrorKind.RedirectRefused, refusal);
						}
					}
					currentUrl = nextUrl;
					continue;
				}
			}

			// 6. Drain body under the size cap.
			const chunks: Uint8Array[] = [];
			let totalBytes = 0;
			try {
				for await (const chunk of impl.body) {
					if (totalBytes + chunk.length > sizeCapBytes) {
						if (truncateOnSizeCap) {
							// Keep exactly up to the cap, then stop the transfer. The
							// preview path only needs the leading bytes (`<head>`), so a
							// 1 MB page still yields a usable preview from its first 64 KiB.
							const remaining = sizeCapBytes - totalBytes;
							if (remaining > 0) {
								chunks.push(chunk.subarray(0, remaining));
								totalBytes += remaining;
							}
							controller.abort();
							break;
						}
						controller.abort();
						await writeAudit(
							currentUrl,
							impl.status,
							totalBytes + chunk.length,
							NetworkAuditOutcome.Aborted,
							"size-cap",
						);
						throw new NetworkFetchError(
							NetworkFetchErrorKind.SizeCap,
							`response exceeded ${sizeCapBytes} bytes`,
						);
					}
					totalBytes += chunk.length;
					chunks.push(chunk);
				}
			} catch (error) {
				if (error instanceof NetworkFetchError) throw error;
				if (controller.signal.aborted) {
					await writeAudit(currentUrl, impl.status, totalBytes, NetworkAuditOutcome.Aborted, "timeout");
					throw new NetworkFetchError(
						NetworkFetchErrorKind.Timeout,
						`exceeded ${timeoutMs}ms during body read`,
					);
				}
				await writeAudit(currentUrl, impl.status, totalBytes, NetworkAuditOutcome.Errored, "body-read");
				throw new NetworkFetchError(NetworkFetchErrorKind.TransportError, (error as Error).message);
			}
			const body = concatChunks(chunks, totalBytes);

			// 7. Filter response headers to the allowlist.
			const filteredHeaders: Record<string, string> = {};
			for (const [k, v] of Object.entries(impl.headers)) {
				if (ALLOWED_RESPONSE_HEADERS.has(k.toLowerCase())) {
					filteredHeaders[k.toLowerCase()] = v;
				}
			}

			await writeAudit(currentUrl, impl.status, totalBytes, NetworkAuditOutcome.Completed, "");
			return {
				status: impl.status,
				headers: filteredHeaders,
				body,
				finalUrl: currentUrl,
			};
		}
	} finally {
		clearTimeout(timeoutHandle);
	}
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let off = 0;
	for (const chunk of chunks) {
		out.set(chunk, off);
		off += chunk.length;
	}
	return out;
}

/** Resolve a relative Location header against the current URL. Throws on
 *  parse failure so the SSRF check at the top of the next loop catches it. */
function resolveRelativeUrl(base: string, location: string): string {
	try {
		return new URL(location, base).toString();
	} catch {
		// Returning the raw location lets the next SSRF check reject it
		// with a structured MalformedUrl rather than crashing the loop.
		return location;
	}
}
