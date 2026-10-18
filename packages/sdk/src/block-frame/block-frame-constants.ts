/**
 * Constants frozen for the 9.5.1 block-frame primitive. Each value is a
 * security invariant — exported so security tests (and 9.5.3's adversarial
 * sweep) can assert against them by reference rather than by re-typing the
 * string and risking drift.
 *
 * The threat model the values below close — every entry maps to one or more
 * of these and the test suite pins each by name:
 *   (a) read host vault content              — sandbox: no allow-same-origin
 *                                              → opaque origin; cross-origin
 *                                              fetch / top.document blocked
 *   (b) write host vault content             — same; plus no `brainstorm`
 *                                              global ever reaches the inner
 *                                              window (the SDK lives on the
 *                                              host side only)
 *   (c) escape iframe to host renderer       — opaque origin (no
 *                                              allow-same-origin) blocks
 *                                              cross-document access
 *   (d) reach sibling block iframe           — opaque origin + each frame is
 *                                              its own browsing context with
 *                                              its own opaque origin
 *   (e) network requests                     — CSP default-src 'none'
 *                                              + connect-src 'none' +
 *                                              img-src 'none' etc.
 *   (f) top-level navigation                 — sandbox: no
 *                                              allow-top-navigation,
 *                                              allow-top-navigation-by-user-activation
 *   (g) Feature-Policy features              — allow="" empty
 *   (h) Permissions-Policy features          — allow="" empty (same attribute
 *                                              maps to both in modern
 *                                              Chromium)
 *   (i) modal-dialog the user                — sandbox: no allow-modals
 *   (j) phish via window.open                — sandbox: no allow-popups,
 *                                              allow-popups-to-escape-sandbox
 *   (k) storage access                       — opaque origin: localStorage
 *                                              throws SecurityError; cookies
 *                                              not sent / not readable;
 *                                              IndexedDB / cache API blocked
 *                                              by opaque origin
 */

/**
 * Sandbox tokens granted to the block frame. The set is deliberately the
 * narrowest that still lets the BP block run scripts at all:
 *
 *   • `allow-scripts` — required for BP blocks to do anything; opaque-origin
 *     scripts cannot reach the host.
 *
 * Every other sandbox token (`allow-same-origin`, `allow-forms`,
 * `allow-popups`, `allow-modals`, `allow-top-navigation`*, `allow-downloads`,
 * `allow-pointer-lock`, `allow-presentation`, `allow-orientation-lock`,
 * `allow-storage-access-by-user-activation`) is intentionally absent.
 * Adding any without a security review and a 9.5.3 pentest pass is a
 * regression.
 *
 * Stable string form — write the iframe attribute as
 * `iframe.setAttribute("sandbox", BLOCK_FRAME_SANDBOX)`.
 */
export const BLOCK_FRAME_SANDBOX_TOKENS: readonly string[] = Object.freeze(["allow-scripts"]);

/** Space-separated string form of {@link BLOCK_FRAME_SANDBOX_TOKENS}. */
export const BLOCK_FRAME_SANDBOX: string = BLOCK_FRAME_SANDBOX_TOKENS.join(" ");

/**
 * Permissions-Policy / Feature-Policy `allow` attribute. Empty string means
 * the iframe has been denied every named feature (camera, microphone,
 * geolocation, fullscreen, payment, autoplay, accelerometer, gyroscope,
 * magnetometer, USB, MIDI, serial, HID, idle-detection, screen-wake-lock,
 * picture-in-picture, encrypted-media, web-share, clipboard-read,
 * clipboard-write, …). The 9.5.3 pass enumerates and re-asserts.
 */
export const BLOCK_FRAME_ALLOW = "";

/**
 * `referrerpolicy` attribute. `no-referrer` ensures the iframe never sends
 * a Referer header — moot for `srcdoc` today (no network fetch) but a
 * defence-in-depth for any future `src` regression.
 */
export const BLOCK_FRAME_REFERRER_POLICY = "no-referrer";

/**
 * `loading` attribute. `lazy` defers iframe load (and its script execution)
 * until it enters the viewport — the IntersectionObserver pause/resume
 * contract on the SDK side is the supported, observable surface; the
 * browser-level `loading="lazy"` is a perf belt-and-braces.
 */
export const BLOCK_FRAME_LOADING = "lazy";

/**
 * Content-Security-Policy meta the srcdoc HTML ships with.
 *
 *   • `default-src 'none'` — no resource loads of any kind unless an
 *     explicit directive overrides.
 *   • `script-src 'unsafe-inline'` — BP block code is inlined into the
 *     srcdoc by 9.5.2; the sandbox + opaque origin contains the blast
 *     radius, so 'unsafe-inline' is bounded. NO `'self'`, NO host
 *     allowlist — the block ships its script inline or doesn't run.
 *   • `style-src 'unsafe-inline'` — same rationale; BP blocks style
 *     themselves inline.
 *   • `connect-src 'none'` — no fetch / XHR / WebSocket / EventSource /
 *     beacon. Blocks cannot exfiltrate.
 *   • `img-src data:` — only inline data-URI images. No remote pixels.
 *   • `font-src 'none'`, `media-src 'none'`, `object-src 'none'`,
 *     `child-src 'none'`, `frame-src 'none'`, `worker-src 'none'`,
 *     `manifest-src 'none'`, `prefetch-src 'none'` — closed by default.
 *   • `form-action 'none'` — no form submission targets (sandbox already
 *     blocks via no allow-forms; defence-in-depth at the doc level).
 *
 * `frame-ancestors` is **deliberately absent** from this list. Two reasons,
 * both load-bearing for 9.5.2: (1) the directive cannot be enforced via
 * `<meta http-equiv>` per the CSP3 spec — browsers ignore it from a meta
 * tag (only the HTTP response header form takes effect). (2) Even if it
 * could, an opaque-origin srcdoc cannot match its embedder by origin —
 * `'self'` would not satisfy (the srcdoc's own origin is the opaque
 * `"null"`), `'none'` would self-block. The only meaningful frame-ancestors
 * enforcement here would come via the Chromium-only `<iframe csp=...>`
 * attribute or by serving the doc with a real HTTP CSP header; both
 * deferred. The sandbox attribute (no allow-top-navigation*, no
 * allow-popups-to-escape-sandbox) already prevents the abuse this directive
 * targets.
 *   • `base-uri 'none'` — `<base href>` in the inner doc cannot change
 *     relative URL resolution.
 *   • `navigate-to 'none'` — blocks document-level navigation requests
 *     (the directive was removed from the CSP3 draft and is not shipped by
 *     any current browser; kept as an aspirational hardening that costs
 *     nothing today and may become real later).
 *
 * Both the outer array AND every inner tuple are deep-frozen so a consumer
 * (e.g. 9.5.3's pentest iterating the directive list) cannot mutate any
 * entry at runtime to widen the policy. `'unsafe-inline'` for script/style
 * is the only widened directive; the opaque-origin sandbox + the explicit
 * `connect-src 'none'` together bound its blast radius (no exfil path, no
 * cross-origin read).
 */
export const BLOCK_FRAME_CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = Object.freeze(
	[
		["default-src", "'none'"],
		["script-src", "'unsafe-inline'"],
		["style-src", "'unsafe-inline'"],
		["connect-src", "'none'"],
		["img-src", "data:"],
		["font-src", "'none'"],
		["media-src", "'none'"],
		["object-src", "'none'"],
		["child-src", "'none'"],
		["frame-src", "'none'"],
		["worker-src", "'none'"],
		["manifest-src", "'none'"],
		["prefetch-src", "'none'"],
		["form-action", "'none'"],
		["base-uri", "'none'"],
		["navigate-to", "'none'"],
	].map((pair) => Object.freeze(pair) as readonly [string, string]),
);

/** Pre-joined Content-Security-Policy header value string. */
export const BLOCK_FRAME_CSP: string = BLOCK_FRAME_CSP_DIRECTIVES.map(([k, v]) => `${k} ${v}`).join(
	"; ",
);

/**
 * The empty srcdoc body the iframe loads before 9.5.2 wires the BP
 * postMessage transport. The CSP meta is *first* in `<head>` so it takes
 * effect for every subsequent byte the parser sees. The `<base target>` is
 * pinned to `_self` so even with a future regression that grants
 * `allow-popups` no anchor click could escape to `_blank`.
 */
export const BLOCK_FRAME_SRCDOC: string = [
	"<!doctype html>",
	'<html lang="en">',
	"<head>",
	'<meta charset="utf-8">',
	`<meta http-equiv="Content-Security-Policy" content="${BLOCK_FRAME_CSP}">`,
	'<meta name="referrer" content="no-referrer">',
	'<base target="_self">',
	"<title>block</title>",
	"</head>",
	'<body data-block-frame="1"></body>',
	"</html>",
].join("");

/** DOM id of the mount point `buildBlockSrcdoc` places in the body — the
 *  block bundle renders into `document.getElementById(BLOCK_FRAME_ROOT_ID)`. */
export const BLOCK_FRAME_ROOT_ID = "bs-block-root";

/** Global the bootstrap `<script>` defines on the inner window before the
 *  block bundle runs. Carries the routing identity (`channelId`+`entityId`)
 *  the inner transport gates on — these CANNOT arrive via the Startup
 *  envelope (the inner transport rejects any inbound whose channel id it
 *  doesn't already know), so the host injects them into the frame's own
 *  srcdoc. Capabilities still flow over the Startup envelope (the authority
 *  channel), never the srcdoc. */
export const BLOCK_FRAME_BOOTSTRAP_GLOBAL = "__BS_BLOCK__";

/** The custom scheme the shell registers to serve a BP block's document
 *  (`main/blocks/block-frame-protocol.ts`). A real-bundle frame loads from
 *  this scheme rather than `srcdoc` so the block document has its OWN origin
 *  + CSP and does NOT inherit the embedding app's `script-src 'self'` (which
 *  a `srcdoc` would, blocking the bundle's inline script). The iframe sandbox
 *  still forces an opaque origin; the scheme just decouples the document's CSP
 *  from the embedder's. */
export const BLOCK_FRAME_SCHEME = "bsblock";

/** Routing identity injected into a real-bundle frame. */
export interface BlockFrameBootstrap {
	/** Channel id the host minted for this frame's transport. The block
	 *  echoes it on every outbound and gates every inbound against it. */
	readonly channelId: string;
	/** Embedding entity id this block is bound to. */
	readonly entityId: string;
}

/** Upper bound on a host entity id carried in the Startup payload. Vault ids
 *  are short opaque tokens; anything longer is not one. */
export const BLOCK_FRAME_MAX_HOST_ENTITY_ID_LENGTH = 256;

const HOST_ENTITY_ID_RE = /^[\x21-\x7e]+$/;

/** The validated host entity id (9.12.24), or `null`. Applied on BOTH sides of
 *  the Startup channel — the host never sends a malformed id and the block
 *  never trusts one — so a structured, bounded id is the only shape that
 *  crosses: printable ASCII, no whitespace, at most
 *  {@link BLOCK_FRAME_MAX_HOST_ENTITY_ID_LENGTH} chars. */
export function sanitizeHostEntityId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	if (value.length === 0 || value.length > BLOCK_FRAME_MAX_HOST_ENTITY_ID_LENGTH) return null;
	return HOST_ENTITY_ID_RE.test(value) ? value : null;
}

/** Neutralise the byte sequences a JSON string field could carry that would
 *  otherwise break out of the inline `<script>` (`</script>`, HTML comment
 *  openers) or terminate the script per the JS spec's line terminators
 *  (U+2028 / U+2029). `<` covers `</script>` and `<!--`. The value is also
 *  double-`JSON.stringify`'d (a JS string literal that is `JSON.parse`d at
 *  runtime), so this is defense-in-depth on already-escaped content. */
function escapeForInlineScript(literal: string): string {
	return literal
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/**
 * Build a srcdoc that runs a real BP block bundle inside the EXACT same
 * pinned security shell as {@link BLOCK_FRAME_SRCDOC} (same CSP meta, same
 * `<base target="_self">`, same charset/referrer). The app contributes ONLY
 * the `blockScript` body and the routing-identity `bootstrap`; the CSP,
 * sandbox, and document shell are fixed here and can never be softened by a
 * caller — the whole point of pinning `srcdoc`.
 *
 * Layout: CSP-first `<head>`, a single mount `<div id="bs-block-root">`, a
 * bootstrap `<script>` that freezes the routing identity onto
 * `window.__BS_BLOCK__`, then the block bundle `<script>`. The bootstrap is
 * embedded as a double-encoded JSON string parsed at runtime + escaped for
 * the inline-script context, so no `entityId` value can break out of the
 * `<script>` element.
 */
/** Build the `bsblock://` URL a real-bundle frame loads. Carries the block id
 *  (the shell handler fetches the bundle by it) + the routing identity the
 *  bootstrap injects. `URLSearchParams` encodes every value, so an `entityId`
 *  with reserved characters round-trips losslessly. */
export function makeBlockFrameUrl(blockId: string, bootstrap: BlockFrameBootstrap): string {
	const params = new URLSearchParams({
		b: blockId,
		c: bootstrap.channelId,
		e: bootstrap.entityId,
	});
	return `${BLOCK_FRAME_SCHEME}://frame/?${params.toString()}`;
}

export function buildBlockSrcdoc(blockScript: string, bootstrap: BlockFrameBootstrap): string {
	const json = JSON.stringify({ channelId: bootstrap.channelId, entityId: bootstrap.entityId });
	const safeLiteral = escapeForInlineScript(JSON.stringify(json));
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${BLOCK_FRAME_CSP}">`,
		'<meta name="referrer" content="no-referrer">',
		'<base target="_self">',
		"<title>block</title>",
		"</head>",
		'<body data-block-frame="1">',
		`<div id="${BLOCK_FRAME_ROOT_ID}"></div>`,
		`<script>window.${BLOCK_FRAME_BOOTSTRAP_GLOBAL}=Object.freeze(JSON.parse(${safeLiteral}));</script>`,
		`<script>${blockScript}</script>`,
		"</body>",
		"</html>",
	].join("");
}

/**
 * Lifecycle phases the host can observe. Wire format = string enum value so
 * a future telemetry surface (Stage 12) can serialise without renaming.
 */
export enum BlockFramePhase {
	/** Iframe is in the DOM and visible — scripts execute. */
	Mounted = "mounted",
	/** Iframe is in the DOM but offscreen — IntersectionObserver fired
	 *  `isIntersecting=false`; the host should treat the block as inert
	 *  (no postMessage delivery in 9.5.2). */
	Paused = "paused",
	/** Iframe was removed from the DOM (destroy()) — observers detached,
	 *  no further events. */
	Unloaded = "unloaded",
}

/**
 * Default CSS class applied to the iframe element. Apps can override via
 * `className`; this default lets the shared host stylesheet land basic
 * defensive rules (no border, block layout, width:100%) in one place.
 */
export const BLOCK_FRAME_DEFAULT_CLASS = "bs-block-frame";

/**
 * 9.5.2 postMessage-transport requirements pinned here so the transport
 * builder cannot forget them. The constants don't enforce these (the
 * transport lands in a future iteration) but every consumer of the
 * BlockFrameHandle's `iframe` field that wires `window.addEventListener
 * ("message", …)` MUST honour them:
 *
 *   1. Identity-check inbound messages by `event.source === handle.iframe
 *      .contentWindow`. Do NOT trust `event.origin` — every other
 *      opaque-origin sandboxed iframe in the same renderer also reports
 *      `"null"` and can spoof.
 *   2. Mint a per-handle random channel id at `createBlockFrame` time and
 *      include it on every message in both directions; reject any inbound
 *      message whose channel id doesn't match the handle's expected id.
 *   3. Gate postMessage delivery on `handle.getPhase() === Mounted`. A
 *      Paused frame should not receive transport messages (the host can
 *      coalesce / drop them; the BP protocol contract is delivery to a
 *      visible block).
 */
export const BLOCK_FRAME_TRANSPORT_REQUIREMENTS_FOR_9_5_2 =
	"identity-check via event.source === iframe.contentWindow; per-handle channel id; gate on Mounted phase" as const;

/**
 * 9.5.3 default payload-size cap (bytes). Outbound payloads whose JSON
 * length exceeds this are dropped + counted; inbound payloads whose
 * JSON length exceeds this are dropped + counted (the JSON proxy is a
 * conservative pre-deserialize check that maps to the `structuredClone`
 * walk postMessage performs anyway). 256 KiB is well above any realistic
 * BP protocol message and well below the renderer's heap budget per
 * iframe; chosen as a single-message bound, not a session-rate bound.
 * A real DoS-shaped attacker would hit `maxInboundPerSecond` long before
 * single-message size. Callers override per-transport in `opts.maxPayloadBytes`.
 */
export const BLOCK_FRAME_DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * 9.5.3 default inbound rate-limit. The transport accepts up to this many
 * inbound `Message` envelopes per rolling second; excess is dropped +
 * counted (per-event silent — logging would be DoS-amplifying). 1000/s is
 * orders of magnitude above any legitimate BP traffic pattern (typing
 * yields ~30 events/s peak; cursor-track yields ~60); the threshold
 * exists to bound the cost of a runaway block, not to police healthy
 * traffic. Callers override per-transport in `opts.maxInboundPerSecond`.
 */
export const BLOCK_FRAME_DEFAULT_MAX_INBOUND_PER_SECOND = 1000;

/**
 * Reason a transport silently dropped a message. Exposed via
 * `transport.dropCounts()` so a host-side observability surface (a
 * future telemetry pass; not v1) can read counters without the transport
 * itself emitting per-event log noise (which would be a DoS amplifier).
 * Wire format = string enum value so a future telemetry pipeline can
 * serialise without renaming.
 *
 * `OutboundPayloadTooLarge` / `InboundPayloadTooLarge` — the JSON size
 * exceeded `maxPayloadBytes`.
 * `InboundRateLimited` — the inbound-per-second threshold was hit.
 * `OutboundClosed` / `OutboundNotMounted` — phase or close gate at send().
 * `InboundIdentity` / `InboundChannel` / `InboundEntityId` /
 * `InboundDirection` / `InboundKind` / `InboundMalformed` / `InboundPhase` —
 * one of the existing inbound gates rejected.
 */
export enum BlockFrameDropReason {
	OutboundPayloadTooLarge = "outbound-payload-too-large",
	OutboundClosed = "outbound-closed",
	OutboundNotMounted = "outbound-not-mounted",
	InboundPayloadTooLarge = "inbound-payload-too-large",
	InboundRateLimited = "inbound-rate-limited",
	InboundIdentity = "inbound-identity",
	InboundChannel = "inbound-channel",
	InboundEntityId = "inbound-entity-id",
	InboundDirection = "inbound-direction",
	InboundKind = "inbound-kind",
	InboundMalformed = "inbound-malformed",
	InboundPhase = "inbound-phase",
}
