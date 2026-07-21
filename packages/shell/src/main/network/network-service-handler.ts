/**
 * Net-1a step 3 — broker service handler for `network.fetch`.
 *
 * Wires the step-2 pure-async `executeNetworkFetch` into the shell's
 * `Broker` so app-originated IPC envelopes reach it. This handler
 * enforces the per-method egress capability SERVER-SIDE (via the active
 * vault's `CapabilityLedger`, not the envelope's app-controlled `caps`
 * — see `requireCapability` below), validates the envelope args,
 * dispatches to the executor, and maps the executor's typed
 * `NetworkFetchError`s to the broker's named error shapes (`Invalid` /
 * `Unavailable` / `Denied` / the new `NetworkRefused` / `Aborted` /
 * `Timeout` family).
 *
 * SECURITY: the broker's generic capability check only verifies the caps
 * the *envelope declares*, and the calling app controls that array — an
 * app can omit a cap it lacks and the broker's `declaredCaps.every([])`
 * passes vacuously. The network egress caps (`network.fetch` /
 * `network.preview` / `network.readable`) are scarce — NOT in the
 * default-minimum grant set — so omitting them would otherwise grant an
 * unsanctioned public-internet egress / SSRF-floor channel to any app.
 * We therefore re-check the umbrella cap against the ledger here, the
 * same posture the `entities` service takes for `entities.read:<type>`.
 *
 * Production binds the `fetchImpl` to Electron's `net.fetch` and the
 * `lookupHost` to `dns.promises.lookup`. Tests construct the handler
 * with deterministic stubs (the same ones the step-2 executor tests
 * already use).
 *
 * Methods:
 *   - `fetch({url, method?, headers?, body?, sizeCapBytes?, timeoutMs?})`
 *     → `{status, headers, body, finalUrl}`
 *   - `preview({url})` → `LinkPreview`
 *
 * Capability gates (broker-enforced, declared by the SDK proxy):
 *   - `network.fetch` — public-internet HTTP fetch. Required for ANY
 *     broker'd request. SSRF floor + private-IP rejection apply.
 *   - `network.fetch.private` (Net-1b) — RELAXES the SSRF private-IP +
 *     local-hostname rejections so the caller can reach RFC1918 /
 *     loopback / link-local addresses. Holders must ALSO hold
 *     `network.fetch` (the umbrella check) — `.private` is the scope-
 *     widener, never a standalone permit. Per doc-38 §Private network
 *     access: defaults off, user grants it loudly.
 */

import { promises as dnsPromises } from "node:dns";
import * as nodeHttp from "node:http";
import * as nodeHttps from "node:https";
import type { NetworkReadableResult, SerializedBlock } from "@brainstorm-os/sdk-types";
import { net, session } from "electron";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { AssetKind } from "../assets/asset-types";
import { type CapabilityLedger, LedgerUnavailableError } from "../capabilities/ledger";
import type { NetworkAuditSink } from "./audit-log";
import {
	type FetchImpl,
	type FetchImplResponse,
	type LookupHost,
	NetworkFetchError,
	NetworkFetchErrorKind,
	type NetworkFetchRequest,
	executeNetworkFetch,
} from "./network-service";
import { type LinkPreview, extractLinkPreview } from "./preview";
import { DEFAULT_LOCALE, type LinkPreviewCache } from "./preview-cache";
import { type PreviewBlockedReason, type PrivacyConfig, isPreviewAllowed } from "./privacy-config";
import {
	type ManualProxyConfig,
	type PacProxyConfig,
	type ProxyConfig,
	ProxyMode,
} from "./proxy-config";
import { collectRemoteImageSrcs, rewriteImageSrcs } from "./readable/enrich-blocks";

/** Shape of the Electron session proxy-apply callback. Production
 *  passes a thin wrapper around `session.defaultSession.setProxy` (see
 *  `productionApplyProxyConfig`); tests inject a recorder so the
 *  handler's idempotence + per-mode shape can be asserted without
 *  reaching Electron. */
export type ApplyProxyConfig = (config: ProxyConfig) => Promise<void>;

export type NetworkServiceOptions = {
	readonly fetchImpl: FetchImpl;
	readonly lookupHost: LookupHost;
	readonly auditSink: NetworkAuditSink;
	/** SECURITY (Net-1a) — the active vault's capability ledger, used to
	 *  enforce the per-method egress umbrella cap server-side rather than
	 *  trusting the envelope's app-controlled `caps`. Production wires it to
	 *  the live session ledger; absent → the cap gate is skipped (unit tests
	 *  that exercise executor mechanics, where the caller is presumed
	 *  authorized). See the `requireCapability` rationale above. */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
	/** Net-1c — optional per-(canonicalUrl, locale) cache. When wired,
	 *  `handlePreview` consults it before fetching; a cache hit returns
	 *  the stored `LinkPreview` without leaving the broker (no SSRF, no
	 *  DNS, no audit-log record — by design; audit only records actual
	 *  egress events). Cache miss falls through to the executor and
	 *  stores the resulting preview. Omit in unit tests that want to
	 *  exercise the executor end-to-end; production wires the singleton. */
	readonly previewCache?: LinkPreviewCache;
	/** Net-1d — optional proxy-config reader. When wired, the handler
	 *  applies the returned config to the Electron session BEFORE the
	 *  first `net.fetch`, and skips the apply when the config hasn't
	 *  changed since last call (idempotent via a stable serialised key).
	 *  Absent → the handler stays byte-identical to the pre-Net-1d world
	 *  (the OS / Electron picks up whatever default the session has, which
	 *  is `mode: "system"`). */
	readonly getProxyConfig?: () => ProxyConfig;
	/** Net-1d — session.setProxy bridge. Production wires
	 *  `productionApplyProxyConfig`; tests inject a recorder. */
	readonly applyProxyConfig?: ApplyProxyConfig;
	/** Net-1e — optional per-vault privacy-config reader. When wired,
	 *  `handlePreview` consults it BEFORE the cache lookup (a stale
	 *  cached value must NOT surface when the user has flipped the vault
	 *  to Off — privacy-gone-cold should not leak). Returns a typed
	 *  `PreviewBlocked` error with a `reason` field the Net-1f UI uses
	 *  to pick the right affordance (Off → grey out; Manual → "Fetch
	 *  preview" button; Allowlist miss → "Add to allowlist"). Absent
	 *  → previews unconditionally allowed (byte-identical to the
	 *  pre-Net-1e world). */
	readonly getPrivacyConfig?: () => PrivacyConfig;
	/** Net-2c — readable-content extractor (the extraction utility worker's
	 *  queue handle). When absent, `network.readable` returns the preview with
	 *  `blocks: null` (graceful — no worker, metadata-only). */
	readonly extractReadable?: (input: {
		html: string;
		baseUrl: string;
	}) => Promise<{ blocks: SerializedBlock[] | null }>;
	/** Asset subsystem — store a downloaded favicon/cover into the vault's
	 *  encrypted asset store and return its id. When wired, `handlePreview`
	 *  sub-fetches the page's favicon + OG cover (through the same SSRF /
	 *  privacy / size guards), stores them, and returns
	 *  `brainstorm://asset/<id>` URLs on the preview — so consumers paint a
	 *  local, offline, encrypted copy instead of the remote URL. Absent →
	 *  the preview carries only the remote `favicon`/`image` URLs (no asset
	 *  storage; byte-identical to the pre-asset world). */
	readonly storeImageAsset?: (input: {
		bytes: Uint8Array;
		mime: string;
		kind: AssetKind;
		originUrl: string;
	}) => Promise<{ assetId: string }>;
};

/** Preview-method response size cap. 64 KiB is enough to capture
 *  `<head>` on every well-behaved site (most are < 16 KiB) without
 *  pulling the whole body — pages that need more for OG/JSON-LD are
 *  doing something wrong. */
const PREVIEW_SIZE_CAP_BYTES = 64 * 1024;
/** Preview total time budget. 5 s matches the doc-38 default; the broker
 *  abandons slow pages rather than block the user's paste. */
const PREVIEW_TIMEOUT_MS = 5_000;

/** Net-2 — the readable service fetches the article body, not just `<head>`, so
 *  it gets the larger doc-58 budgets: 3 MB size, 8 s fetch. Over-cap pages fall
 *  back to a preview with `blocks: null`. */
const READABLE_SIZE_CAP_BYTES = 3 * 1024 * 1024;
const READABLE_TIMEOUT_MS = 8_000;

/** Favicon / cover sub-fetch budgets for the asset-storage path. Favicons are
 *  tiny; covers can be a few hundred KB. Over-cap images are skipped (the
 *  preview keeps its remote URL but stores no asset). */
const FAVICON_SIZE_CAP_BYTES = 512 * 1024;
const COVER_SIZE_CAP_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 8_000;
// 9.18.9 — article-body images are ATTACKER-CONTROLLED URLs (the page lists
// them). Cap the per-image size, the total count fetched, and the fetch
// concurrency so a hostile page can't drive thousands of large sub-fetches.
const ARTICLE_IMG_SIZE_CAP_BYTES = 5 * 1024 * 1024;
const MAX_ARTICLE_IMAGES = 40;
const ARTICLE_IMG_CONCURRENCY = 4;

/** Net-1b — capability id the SDK declares when a caller wants private-
 *  network reach. The broker checks `envelope.caps` for this id and the
 *  service handler relays its presence to `executeNetworkFetch` via
 *  `allowPrivate`. A caller without it gets the public-only behaviour
 *  (byte-identical to the pre-Net-1b world). The capability ledger
 *  enforces user-granted-only: first-party apps don't get it by default. */
export const NETWORK_FETCH_PRIVATE_CAP = "network.fetch.private";

/** Net-1a — the per-method egress umbrella caps, enforced server-side by
 *  `requireCapability`. None are default-minimum grants (the user grants
 *  them loudly), so they MUST be re-checked against the ledger rather than
 *  inferred from the app-supplied `envelope.caps`. */
export const NETWORK_FETCH_CAP = "network.fetch";
export const NETWORK_PREVIEW_CAP = "network.preview";

/** Re-check the per-method umbrella egress capability against the active
 *  vault's ledger. The broker's declared-caps check is necessary-but-not-
 *  sufficient (the app controls `envelope.caps`); this is the authoritative
 *  gate. Fails closed: a ledger error or no-vault becomes `Unavailable`, a
 *  held-by-no-one cap becomes `Denied`. No-op when `getLedger` is unwired. */
async function requireCapability(
	envelope: Envelope,
	options: NetworkServiceOptions,
	capability: string,
): Promise<void> {
	if (!options.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "network: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "network: no active vault session");
	let held: boolean;
	try {
		held = ledger.has(envelope.app, capability);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "network: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw makeError("Denied", `network.${envelope.method}: ${envelope.app} lacks ${capability}`);
	}
}

/** Test whether the broker envelope's declared cap set includes the
 *  `.private` widener. Centralised so adding new variants (e.g.
 *  `network.fetch.private:10.0.0.0/8` scope-narrowing) lands in one
 *  spot rather than every handler that consults it. */
function hasPrivateCap(envelope: Envelope): boolean {
	return envelope.caps.includes(NETWORK_FETCH_PRIVATE_CAP);
}

/** Net-2c — the readable service's caps, parallel to fetch's. The broker
 *  enforces the `network.readable` umbrella; `.private` is the scope-widener
 *  the handler relays to `executeNetworkFetch` as `allowPrivate`. */
export const NETWORK_READABLE_CAP = "network.readable";
export const NETWORK_READABLE_PRIVATE_CAP = "network.readable.private";

function hasReadablePrivateCap(envelope: Envelope): boolean {
	return envelope.caps.includes(NETWORK_READABLE_PRIVATE_CAP);
}

export function makeNetworkServiceHandler(options: NetworkServiceOptions): ServiceHandler {
	const proxyState: ProxyApplyState = { lastAppliedKey: null };
	return async (envelope: Envelope): Promise<unknown> => {
		await ensureProxyApplied(options, proxyState);
		switch (envelope.method) {
			case "fetch":
				return await handleFetch(envelope, options);
			case "preview":
				return await handlePreview(envelope, options);
			case "readable":
				return await handleReadable(envelope, options);
			default:
				throw makeError("Invalid", `unknown network method: ${envelope.method}`);
		}
	};
}

/** Per-handler idempotence state for the proxy-apply path. Lives in the
 *  closure returned by `makeNetworkServiceHandler` so the apply runs
 *  once per distinct config; calling the handler 10 000 times with the
 *  same config triggers `applyProxyConfig` once. */
type ProxyApplyState = { lastAppliedKey: string | null };

/** Net-1d — call `applyProxyConfig` before the first request and on
 *  every config change. Skips on idempotent re-calls (same serialised
 *  config). Absent `getProxyConfig` / `applyProxyConfig` → no-op (the
 *  handler stays byte-identical to the pre-Net-1d world). */
async function ensureProxyApplied(
	options: NetworkServiceOptions,
	state: ProxyApplyState,
): Promise<void> {
	if (!options.getProxyConfig || !options.applyProxyConfig) return;
	const config = options.getProxyConfig();
	const key = proxyConfigKey(config);
	if (state.lastAppliedKey === key) return;
	await options.applyProxyConfig(config);
	state.lastAppliedKey = key;
}

/** Stable serialised form for idempotence comparison. JSON.stringify
 *  walks the same fields in declaration order for our value-shaped
 *  config (no Maps / Sets / functions); two configs that compute the
 *  same key are identical for `session.setProxy` purposes. */
function proxyConfigKey(config: ProxyConfig): string {
	return JSON.stringify(config);
}

async function handleFetch(envelope: Envelope, options: NetworkServiceOptions): Promise<unknown> {
	await requireCapability(envelope, options, NETWORK_FETCH_CAP);
	const args = validateFetchArgs(envelope.args);
	const allowPrivate = hasPrivateCap(envelope);
	const request: NetworkFetchRequest = {
		appId: envelope.app,
		url: args.url,
		...(args.method !== undefined ? { method: args.method } : {}),
		...(args.headers !== undefined ? { headers: args.headers } : {}),
		...(args.body !== undefined ? { body: args.body } : {}),
		...(args.sizeCapBytes !== undefined ? { sizeCapBytes: args.sizeCapBytes } : {}),
		...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
		...(allowPrivate ? { allowPrivate: true } : {}),
	};
	try {
		return await executeNetworkFetch(request, options);
	} catch (error) {
		if (error instanceof NetworkFetchError) {
			// Map to broker error names. The full executor message (which
			// includes the kind + detail) lands as the error message;
			// IPC consumers can pattern-match on `err.name`.
			throw makeError(brokerErrorName(error.kind), error.message);
		}
		throw error;
	}
}

async function handlePreview(
	envelope: Envelope,
	options: NetworkServiceOptions,
): Promise<LinkPreview> {
	await requireCapability(envelope, options, NETWORK_PREVIEW_CAP);
	const args = validatePreviewArgs(envelope.args);
	const allowPrivate = hasPrivateCap(envelope);
	const locale = args.locale ?? DEFAULT_LOCALE;
	// Net-1e — consult the per-vault privacy config BEFORE the cache
	// lookup. The cache must NOT be consulted when previews are Off /
	// Manual / Allowlist-miss — returning a stale cached value would be
	// a privacy regression for a user who explicitly flipped the vault
	// to Off (cf. doc-38 §User control). A typed `PreviewBlocked` error
	// with a `reason` field lets the Net-1f UI pick the right
	// affordance without parsing a message string.
	if (options.getPrivacyConfig) {
		const privacy = options.getPrivacyConfig();
		const decision = isPreviewAllowed(privacy, args.url);
		if (!decision.allowed) {
			throw makePreviewBlockedError(decision.reason, args.url);
		}
	}
	// Net-1c — consult the cache before any egress. The cache is keyed
	// on the SSRF-validated canonical URL we have AFTER the executor
	// runs (see set() below); we can still try a hit on the raw input
	// URL because the WHATWG URL parser normalises it identically on
	// both ends. A cold cache + miss is byte-identical to pre-Net-1c.
	if (options.previewCache) {
		const cached = options.previewCache.get(args.url, locale);
		if (cached) return cached;
	}
	let response: { body: Uint8Array; finalUrl: string; headers: Readonly<Record<string, string>> };
	try {
		response = await executeNetworkFetch(
			{
				appId: envelope.app,
				url: args.url,
				method: "GET",
				headers: { Accept: "text/html,application/xhtml+xml" },
				sizeCapBytes: PREVIEW_SIZE_CAP_BYTES,
				// A page's <head> (OG/JSON-LD) is in the first bytes — truncate at
				// the cap rather than reject, so large pages (Wikipedia, news) still
				// preview. The readable path keeps the reject behaviour (byte-exact).
				truncateOnSizeCap: true,
				timeoutMs: PREVIEW_TIMEOUT_MS,
				...(allowPrivate ? { allowPrivate: true } : {}),
			},
			options,
		);
	} catch (error) {
		if (error instanceof NetworkFetchError) {
			// Preview-specific note: SizeCap means the page's `<head>` was
			// larger than 64 KiB; we still keep the bytes we read and
			// extract from those. Other errors map to broker names.
			if (error.kind === NetworkFetchErrorKind.SizeCap) {
				// SizeCap rejected the body entirely; without bytes we have
				// nothing to extract, so fall through to the broker mapping.
			}
			throw makeError(brokerErrorName(error.kind), error.message);
		}
		throw error;
	}
	// The body is the (possibly truncated) HTML. Decode best-effort UTF-8.
	const contentType = response.headers["content-type"] ?? "";
	const charset = charsetFromContentType(contentType);
	const html = new TextDecoder(charset, { fatal: false }).decode(response.body);
	const extracted = extractLinkPreview({ url: response.finalUrl, html });
	// Asset subsystem — download + encrypt the favicon + cover so the consumer
	// paints an offline, encrypted local copy instead of a remote URL. Done
	// before the cache set so a cache hit also yields the local asset URLs.
	const preview = await enrichPreviewWithAssets(extracted, options, allowPrivate);
	// Net-1c — cache against the SSRF-validated canonical URL (the
	// `preview.canonicalUrl` after extractor normalisation) AND, for
	// hit-symmetry, the originally-requested URL. The next paste of
	// either form is a cache hit. The 24h TTL window starts now.
	if (options.previewCache) {
		options.previewCache.set(preview.canonicalUrl, locale, preview);
		if (args.url !== preview.canonicalUrl) {
			options.previewCache.set(args.url, locale, preview);
		}
	}
	return preview;
}

/** Download + store the page's favicon + OG cover as encrypted vault assets,
 *  returning the preview with `faviconAssetUrl` / `coverAssetUrl` set. A no-op
 *  pass-through when no asset store is wired. Each image is independent — one
 *  failing (privacy-blocked / non-image / over-cap / fetch error) leaves the
 *  other intact and the preview keeps its remote URLs. */
async function enrichPreviewWithAssets(
	preview: LinkPreview,
	options: NetworkServiceOptions,
	allowPrivate: boolean,
): Promise<LinkPreview> {
	if (!options.storeImageAsset) return preview;
	const [faviconAssetUrl, coverAssetUrl] = await Promise.all([
		preview.favicon
			? fetchAndStoreImage(
					preview.favicon,
					AssetKind.Favicon,
					FAVICON_SIZE_CAP_BYTES,
					options,
					allowPrivate,
				)
			: Promise.resolve(undefined),
		preview.image
			? fetchAndStoreImage(preview.image, AssetKind.Cover, COVER_SIZE_CAP_BYTES, options, allowPrivate)
			: Promise.resolve(undefined),
	]);
	return {
		...preview,
		...(faviconAssetUrl ? { faviconAssetUrl } : {}),
		...(coverAssetUrl ? { coverAssetUrl } : {}),
	};
}

/** Sub-fetch one image URL (through the same SSRF / privacy / size guards as
 *  the page fetch), store it encrypted, and return its
 *  `brainstorm://asset/<id>` URL. Returns undefined — never throws — on any
 *  failure so a bad favicon never breaks the whole preview. */
async function fetchAndStoreImage(
	imageUrl: string,
	kind: AssetKind,
	sizeCapBytes: number,
	options: NetworkServiceOptions,
	allowPrivate: boolean,
): Promise<string | undefined> {
	const store = options.storeImageAsset;
	if (!store) return undefined;
	// Re-check privacy for the image host — it may differ from the page host
	// (a CDN), and an Allowlist-mode vault must not egress to a non-listed
	// image host just because the page host was allowed.
	if (options.getPrivacyConfig) {
		const decision = isPreviewAllowed(options.getPrivacyConfig(), imageUrl);
		if (!decision.allowed) return undefined;
	}
	try {
		const response = await executeNetworkFetch(
			{
				appId: "shell.asset-fetch",
				url: imageUrl,
				method: "GET",
				headers: { Accept: "image/*" },
				sizeCapBytes,
				timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
				...(allowPrivate ? { allowPrivate: true } : {}),
			},
			options,
		);
		const mime = (response.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
		if (!mime.startsWith("image/")) return undefined;
		const { assetId } = await store({ bytes: response.body, mime, kind, originUrl: imageUrl });
		return `brainstorm://asset/${assetId}`;
	} catch {
		return undefined;
	}
}

/**
 * 9.18.9 — rewrite a captured article's remote image blocks to locally-stored
 * encrypted assets. Collects up to `MAX_ARTICLE_IMAGES` distinct remote image
 * URLs from the block tree, sub-fetches each through the SAME guard chain as
 * favicon/cover (`fetchAndStoreImage` → SSRF/privacy/size/MIME), and rewrites
 * the `src` to `brainstorm://asset/<id>`. Fetches run in bounded batches. An
 * image that fails any guard keeps its remote `src` (dropped at render). No-op
 * unless the asset store is wired (`storeImageAsset`). Never throws — a bad
 * image never breaks the capture.
 */
async function enrichBlocksWithAssets(
	blocks: SerializedBlock[],
	options: NetworkServiceOptions,
	allowPrivate: boolean,
): Promise<SerializedBlock[]> {
	if (!options.storeImageAsset) return blocks;
	const srcs = collectRemoteImageSrcs(blocks, MAX_ARTICLE_IMAGES);
	if (srcs.length === 0) return blocks;
	const rewrites = new Map<string, string>();
	for (let i = 0; i < srcs.length; i += ARTICLE_IMG_CONCURRENCY) {
		const batch = srcs.slice(i, i + ARTICLE_IMG_CONCURRENCY);
		const results = await Promise.all(
			batch.map(async (src) => {
				const url = await fetchAndStoreImage(
					src,
					AssetKind.Upload,
					ARTICLE_IMG_SIZE_CAP_BYTES,
					options,
					allowPrivate,
				);
				return [src, url] as const;
			}),
		);
		for (const [src, url] of results) {
			if (url) rewrites.set(src, url);
		}
	}
	return rewriteImageSrcs(blocks, rewrites);
}

/** Net-2c — `network.readable`: a superset of `preview` that also returns the
 *  cleaned page body as Lexical blocks. Reuses every Net-1 invariant by going
 *  through `executeNetworkFetch` (SSRF / size / time / audit), then forwards the
 *  fetched HTML to the extraction worker. Same privacy gate as previews. */
async function handleReadable(
	envelope: Envelope,
	options: NetworkServiceOptions,
): Promise<NetworkReadableResult> {
	await requireCapability(envelope, options, NETWORK_READABLE_CAP);
	const args = validatePreviewArgs(envelope.args);
	const allowPrivate = hasReadablePrivateCap(envelope);
	if (options.getPrivacyConfig) {
		const decision = isPreviewAllowed(options.getPrivacyConfig(), args.url);
		if (!decision.allowed) {
			throw makePreviewBlockedError(decision.reason, args.url);
		}
	}
	let response: { body: Uint8Array; finalUrl: string; headers: Readonly<Record<string, string>> };
	try {
		response = await executeNetworkFetch(
			{
				appId: envelope.app,
				url: args.url,
				method: "GET",
				headers: { Accept: "text/html,application/xhtml+xml" },
				sizeCapBytes: READABLE_SIZE_CAP_BYTES,
				timeoutMs: READABLE_TIMEOUT_MS,
				...(allowPrivate ? { allowPrivate: true } : {}),
			},
			options,
		);
	} catch (error) {
		if (error instanceof NetworkFetchError) {
			throw makeError(brokerErrorName(error.kind), error.message);
		}
		throw error;
	}
	const charset = charsetFromContentType(response.headers["content-type"] ?? "");
	const html = new TextDecoder(charset, { fatal: false }).decode(response.body);
	const preview = extractLinkPreview({ url: response.finalUrl, html });
	// The blocks come from the extraction worker (CPU-heavy, off the broker
	// loop). No worker wired → metadata-only (graceful).
	let blocks: SerializedBlock[] | null = null;
	if (options.extractReadable) {
		const extracted = await options.extractReadable({ html, baseUrl: response.finalUrl });
		// 9.18.9 — pull the article's remote images into the encrypted asset store
		// so they render (CSP blocks remote http images) + work offline. Same
		// privacy scope as the page fetch.
		blocks = extracted.blocks
			? await enrichBlocksWithAssets(extracted.blocks, options, allowPrivate)
			: extracted.blocks;
	}
	return { preview, blocks };
}

function charsetFromContentType(contentType: string): string {
	const m = contentType.match(/charset\s*=\s*"?([^";]+)"?/i);
	if (!m || m[1] === undefined) return "utf-8";
	const charset = m[1].trim().toLowerCase();
	// TextDecoder tolerates a wide set of labels; default to utf-8 on
	// anything that looks suspicious.
	if (charset.length === 0 || charset.includes(" ")) return "utf-8";
	return charset;
}

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

/** Net-1e — typed error for a preview refused because the per-vault
 *  privacy config blocked it (Off / Manual / Allowlist miss). Carries
 *  the typed `reason` so the renderer picks the right affordance — see
 *  `PreviewBlockedReason` in `privacy-config.ts`. Name is the broker
 *  error name; consumers pattern-match on `err.name === "PreviewBlocked"`
 *  + read `err.reason`. */
export class PreviewBlockedError extends Error {
	override readonly name = "PreviewBlocked";
	readonly reason: PreviewBlockedReason;
	readonly url: string;
	constructor(reason: PreviewBlockedReason, url: string) {
		super(`preview blocked by privacy policy (${reason})`);
		this.reason = reason;
		this.url = url;
	}
}

function makePreviewBlockedError(reason: PreviewBlockedReason, url: string): PreviewBlockedError {
	return new PreviewBlockedError(reason, url);
}

function brokerErrorName(kind: NetworkFetchErrorKind): string {
	switch (kind) {
		case NetworkFetchErrorKind.SsrfRefused:
			return "Denied"; // SSRF refusal is policy enforcement, same as cap-denied
		case NetworkFetchErrorKind.DnsFailure:
			return "Unavailable";
		case NetworkFetchErrorKind.SizeCap:
		case NetworkFetchErrorKind.Timeout:
		case NetworkFetchErrorKind.TooManyRedirects:
			return "Aborted";
		case NetworkFetchErrorKind.TransportError:
			return "Unavailable";
		default:
			return "Invalid";
	}
}

type ValidatedFetchArgs = {
	readonly url: string;
	readonly method?: string;
	readonly headers?: Record<string, string>;
	readonly body?: Uint8Array;
	readonly sizeCapBytes?: number;
	readonly timeoutMs?: number;
};

function validatePreviewArgs(args: readonly unknown[]): { url: string; locale?: string } {
	const [arg] = args as [unknown];
	if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
		throw makeError("Invalid", "network.preview: argument must be an object");
	}
	const a = arg as Record<string, unknown>;
	if (typeof a.url !== "string" || a.url.length === 0) {
		throw makeError("Invalid", "network.preview: { url } must be a non-empty string");
	}
	// Net-1c — optional locale for the cache key. Defaults to "en" when
	// omitted (the broker's default `Accept-Language`).
	const out: { url: string; locale?: string } = { url: a.url };
	if (a.locale !== undefined) {
		if (typeof a.locale !== "string" || a.locale.length === 0) {
			throw makeError("Invalid", "network.preview: { locale } must be a non-empty string");
		}
		out.locale = a.locale;
	}
	return out;
}

function validateFetchArgs(args: readonly unknown[]): ValidatedFetchArgs {
	const [arg] = args as [unknown];
	if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
		throw makeError("Invalid", "network.fetch: argument must be an object");
	}
	const a = arg as Record<string, unknown>;
	if (typeof a.url !== "string" || a.url.length === 0) {
		throw makeError("Invalid", "network.fetch: { url } must be a non-empty string");
	}
	const out: {
		url: string;
		method?: string;
		headers?: Record<string, string>;
		body?: Uint8Array;
		sizeCapBytes?: number;
		timeoutMs?: number;
	} = { url: a.url };
	if (a.method !== undefined) {
		if (typeof a.method !== "string" || a.method.length === 0) {
			throw makeError("Invalid", "network.fetch: { method } must be a non-empty string");
		}
		out.method = a.method;
	}
	if (a.headers !== undefined) {
		if (!a.headers || typeof a.headers !== "object" || Array.isArray(a.headers)) {
			throw makeError("Invalid", "network.fetch: { headers } must be a plain object");
		}
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(a.headers as Record<string, unknown>)) {
			if (typeof k !== "string" || k.length === 0) {
				throw makeError("Invalid", "network.fetch: header keys must be non-empty strings");
			}
			if (typeof v !== "string") {
				throw makeError("Invalid", `network.fetch: header ${k} value must be a string`);
			}
			headers[k] = v;
		}
		out.headers = headers;
	}
	if (a.body !== undefined) {
		if (a.body instanceof Uint8Array) {
			out.body = a.body;
		} else if (Array.isArray(a.body) && (a.body as unknown[]).every((n) => typeof n === "number")) {
			out.body = new Uint8Array(a.body as number[]);
		} else {
			throw makeError(
				"Invalid",
				"network.fetch: { body } must be a Uint8Array or number[] (IPC-friendly transcoding)",
			);
		}
	}
	if (a.sizeCapBytes !== undefined) {
		if (
			typeof a.sizeCapBytes !== "number" ||
			!Number.isFinite(a.sizeCapBytes) ||
			a.sizeCapBytes < 0
		) {
			throw makeError(
				"Invalid",
				"network.fetch: { sizeCapBytes } must be a non-negative finite number",
			);
		}
		out.sizeCapBytes = a.sizeCapBytes;
	}
	if (a.timeoutMs !== undefined) {
		if (typeof a.timeoutMs !== "number" || !Number.isFinite(a.timeoutMs) || a.timeoutMs <= 0) {
			throw makeError("Invalid", "network.fetch: { timeoutMs } must be a positive finite number");
		}
		out.timeoutMs = a.timeoutMs;
	}
	return out;
}

/** Request-header names the Fetch spec forbids a caller from setting; Chromium
 *  (`net.fetch`) rejects the whole request with `ERR_INVALID_ARGUMENT` if any
 *  are present. The executor adds `Host` for IP-pinned fetchImpls, but
 *  `net.fetch` connects by the hostname URL and derives these itself — so we
 *  strip them at the `net.fetch` boundary. Lower-cased for case-insensitive
 *  comparison. */
const FORBIDDEN_FETCH_HEADERS: ReadonlySet<string> = new Set([
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"keep-alive",
	"upgrade",
	"proxy-connection",
]);

/** Drop forbidden request headers (case-insensitive) before handing them to
 *  `net.fetch`. Pure + exported so the forbidden-header strip is unit-tested
 *  without driving Electron. */
export function sanitizeFetchHeaders(
	headers: Readonly<Record<string, string>>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (!FORBIDDEN_FETCH_HEADERS.has(key.toLowerCase())) out[key] = value;
	}
	return out;
}

/**
 * Production-bind for the executor's `fetchImpl`.
 *
 * SECURITY (DNS rebinding): the executor resolved the hostname, validated
 * EVERY resolved IP against the private-range blocklist, and PINNED the
 * first valid one (passed here as `resolvedIp`). The contract
 * (`network-service.ts` step 3) is that we connect to THAT IP — never
 * re-resolve the hostname — so a short-TTL attacker who passed validation
 * with a public answer can't flip to `169.254.169.254` / loopback / RFC1918
 * at connect time. `net.fetch` re-resolves DNS itself, so it CANNOT honour
 * the pin; we only use it when a proxy applies (the proxy owns DNS then).
 *
 * Branch on whether a proxy applies to this exact URL:
 *
 *   - **proxy applies** (`resolveProxy` ≠ `DIRECT`): issue via `net.fetch`
 *     so the session proxy (Net-1d) + session-auth login handler (Net-1e)
 *     keep working. The proxy resolves DNS, so our local pin is N/A; Chromium
 *     derives `Host`/`Connection`/etc. itself, so strip the reserved request
 *     headers (`sanitizeFetchHeaders`) — leaving them is `ERR_INVALID_ARGUMENT`.
 *
 *   - **DIRECT**: connect to the pinned IP with Node's `https`/`http`. The
 *     `lookup` socket-override sends the TCP connection to `resolvedIp` while
 *     the URL host stays the hostname, so TLS SNI + certificate hostname
 *     validation both stay correct, and the executor's `Host: hostname` header
 *     is forwarded verbatim. DNS rebinding is impossible — no second lookup.
 *
 * Both paths pass `redirect: "manual"` / never auto-follow so the executor's
 * per-hop SSRF re-validation fires.
 *
 * NOTE (Net-1e): the session `login` credential-injection handler only fires
 * on the `net.fetch` (proxy) path. HTTP-auth challenges on the DIRECT Node
 * path are NOT auto-answered from the credential store — header-based auth
 * placed in `forwardHeaders` (e.g. the connector broker's `Bearer`) is
 * preserved on both paths regardless.
 */
export const productionFetchImpl: FetchImpl = async (resolvedIp, request) => {
	const proxy = await session.defaultSession.resolveProxy(request.url);
	if (!isDirectProxy(proxy)) {
		return fetchViaNet(request);
	}
	return fetchPinnedDirect(resolvedIp, request);
};

/** Electron `resolveProxy` returns a PAC-style string: `"DIRECT"` when no
 *  proxy applies, otherwise a space-separated rule list like
 *  `"PROXY host:port; DIRECT"`. We treat anything whose first rule isn't an
 *  exact `DIRECT` as "a proxy applies", and fall back to `net.fetch` so the
 *  proxy resolves DNS (our local pin doesn't apply through a proxy). */
function isDirectProxy(proxy: string): boolean {
	const first = proxy.split(";")[0]?.trim().toUpperCase() ?? "";
	return first === "DIRECT";
}

/** Proxy path — issue via Electron `net.fetch` (bound to `session.defaultSession`
 *  so proxy + login auth apply). DNS is the proxy's job here. */
async function fetchViaNet(request: FetchImplRequest): Promise<FetchImplResponse> {
	// `net.fetch`'s BodyInit type (lib.dom RequestInit) accepts Blob but
	// not raw Uint8Array under exactOptionalPropertyTypes — wrap in a
	// Blob to satisfy both `body: BodyInit` and the no-body branch.
	const body = request.body !== undefined ? new Blob([request.body as BlobPart]) : undefined;
	const response = await net.fetch(request.url, {
		method: request.method,
		headers: sanitizeFetchHeaders(request.headers ?? {}),
		...(body !== undefined ? { body } : {}),
		signal: request.signal,
		redirect: "manual",
	});
	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key.toLowerCase()] = value;
	});
	return {
		status: response.status,
		headers: responseHeaders,
		body: streamToAsyncIterable(response.body),
	} satisfies FetchImplResponse;
}

/** The request shape the executor hands `FetchImpl`. Named so the production
 *  branches share one type. */
type FetchImplRequest = {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body?: Uint8Array;
	readonly signal: AbortSignal;
};

/**
 * DIRECT path — connect to the executor-validated `resolvedIp` using Node's
 * `https`/`http`, pinning the socket via the `lookup` override so DNS is never
 * re-resolved. Keeping the URL host = hostname means Node derives `servername`
 * (TLS SNI) and validates the certificate against the hostname automatically;
 * the executor-set `Host: hostname` request header is forwarded verbatim.
 *
 * Exported for unit tests: the rebinding test drives this directly with a URL
 * whose host must NOT resolve (`example.invalid`) and `resolvedIp = 127.0.0.1`,
 * proving the socket lands on the pin rather than on a real lookup.
 */
export function fetchPinnedDirect(
	resolvedIp: string,
	request: FetchImplRequest,
): Promise<FetchImplResponse> {
	const url = new URL(request.url);
	const isHttps = url.protocol === "https:";
	const transport = isHttps ? nodeHttps : nodeHttp;
	const defaultPort = isHttps ? 443 : 80;
	const family = resolvedIp.includes(":") ? 6 : 4;
	return new Promise<FetchImplResponse>((resolve, reject) => {
		if (request.signal.aborted) {
			reject(makeAbortError());
			return;
		}
		const req = transport.request(
			{
				protocol: url.protocol,
				host: url.hostname,
				servername: isHttps ? url.hostname : undefined,
				port: url.port !== "" ? Number(url.port) : defaultPort,
				path: `${url.pathname}${url.search}`,
				method: request.method,
				headers: request.headers,
				signal: request.signal,
				// Pin the socket to the executor-validated IP. The hostname is
				// never looked up — `cb` returns the pin directly. SNI + cert
				// validation still key off `host` (the hostname) above. The
				// `all` option (set by the connecting socket) selects the
				// array-shaped callback; honour both so the pin works under
				// Node and Bun's net stack alike.
				lookup: (_hostname, opts, cb) => {
					if (opts && (opts as { all?: boolean }).all) {
						(cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
							{ address: resolvedIp, family },
						]);
						return;
					}
					cb(null, resolvedIp, family);
				},
			},
			(res) => {
				const responseHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(res.headers)) {
					if (value === undefined) continue;
					responseHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
				}
				resolve({
					status: res.statusCode ?? 0,
					headers: responseHeaders,
					body: incomingMessageToAsyncIterable(res),
				} satisfies FetchImplResponse);
			},
		);
		req.on("error", (error) => {
			reject(error);
		});
		if (request.body !== undefined) {
			req.write(request.body);
		}
		req.end();
	});
}

function makeAbortError(): Error {
	const err = new Error("aborted");
	err.name = "AbortError";
	return err;
}

/** Adapt a Node `IncomingMessage` (an `AsyncIterable<Buffer>`) to the
 *  executor's `AsyncIterable<Uint8Array>` body shape. `Buffer` already extends
 *  `Uint8Array`, so chunks satisfy the size-cap drain's `.length` directly;
 *  this wrapper just narrows the static type without copying. */
function incomingMessageToAsyncIterable(
	message: nodeHttp.IncomingMessage,
): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			for await (const chunk of message) {
				yield chunk as Uint8Array;
			}
		},
	};
}

/** Production-bind for `lookupHost` using Node's DNS resolver. `verbatim: true`
 *  preserves the order the OS resolver returned so the executor's first-valid
 *  pinning matches `getaddrinfo` precedence. `all: true` returns every IP so
 *  the executor can fail-on-any-private (defeats mixed DNS responses). */
export const productionLookupHost: LookupHost = async (host) => {
	const results = await dnsPromises.lookup(host, { all: true, verbatim: true });
	return results.map((r) => r.address);
};

/**
 * Net-1d — production-bind for `applyProxyConfig`. Maps the typed
 * `ProxyConfig` union onto `session.defaultSession.setProxy(...)` per
 * Electron's Chromium-flavoured `ProxyConfig` shape:
 *
 *   - Direct → `{ mode: "direct" }`
 *   - System → `{ mode: "system" }`
 *   - Manual → `{ mode: "fixed_servers", proxyRules: "http=h:p;https=h:p;socks=h:p",
 *                 proxyBypassRules: noProxy.join(",") }`
 *   - Pac    → `{ mode: "pac_script", pacScript: pacUrl }`
 *
 * The shared session is shared with every other shell egress path (per
 * doc-38 §Decision "one proxy configuration"): the network broker, the
 * update path, the AI broker, sync transport, embed sandbox all see the
 * same config.
 *
 * Auth-key carrying endpoints don't leak credentials here — the authKey
 * is an opaque per-vault credential-store lookup key (doc-29); Net-1e
 * does the credential-resolution at request time via `session.on(
 * 'login', ...)`, this binding only carries the routing.
 */
export const productionApplyProxyConfig: ApplyProxyConfig = async (config) => {
	await session.defaultSession.setProxy(electronProxyConfigFor(config));
};

/** Map the typed `ProxyConfig` onto Electron's `Electron.ProxyConfig`
 *  shape. Pure — exported via the production binding above for tests
 *  that want to assert the shape without driving `session.setProxy`. */
export function electronProxyConfigFor(config: ProxyConfig): Electron.ProxyConfig {
	switch (config.mode) {
		case ProxyMode.Direct:
			return { mode: "direct" };
		case ProxyMode.System:
			return { mode: "system" };
		case ProxyMode.Manual:
			return manualToElectron(config);
		case ProxyMode.Pac:
			return pacToElectron(config);
	}
}

function manualToElectron(config: ManualProxyConfig): Electron.ProxyConfig {
	const rules: string[] = [];
	if (config.httpProxy) rules.push(`http=${endpointRule(config.httpProxy)}`);
	if (config.httpsProxy) rules.push(`https=${endpointRule(config.httpsProxy)}`);
	if (config.socks5Proxy) rules.push(`socks=${endpointRule(config.socks5Proxy)}`);
	const electronConfig: Electron.ProxyConfig = {
		mode: "fixed_servers",
		proxyRules: rules.join(";"),
	};
	if (config.noProxy.length > 0) {
		electronConfig.proxyBypassRules = config.noProxy.join(",");
	}
	return electronConfig;
}

function endpointRule(endpoint: { host: string; port: number }): string {
	return `${endpoint.host}:${endpoint.port}`;
}

function pacToElectron(config: PacProxyConfig): Electron.ProxyConfig {
	return { mode: "pac_script", pacScript: config.pacUrl };
}

/** Wrap a WHATWG `ReadableStream<Uint8Array>` as the `AsyncIterable<Uint8Array>`
 *  shape the executor consumes. Releases the reader lock on exit so the
 *  stream is cancellable from above. */
function streamToAsyncIterable(
	stream: ReadableStream<Uint8Array> | null,
): AsyncIterable<Uint8Array> {
	if (!stream) {
		return {
			async *[Symbol.asyncIterator]() {
				// no-op — empty body
			},
		};
	}
	return {
		async *[Symbol.asyncIterator]() {
			const reader = stream.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) return;
					if (value !== undefined) yield value;
				}
			} finally {
				reader.releaseLock();
			}
		},
	};
}
