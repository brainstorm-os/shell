/**
 * Block-frame postMessage transport — the secure pipe between the host
 * renderer and a sandboxed BP block iframe produced by 9.5.1's
 * `createBlockFrame`. This layer enforces the three invariants pinned in
 * `BLOCK_FRAME_TRANSPORT_REQUIREMENTS_FOR_9_5_2`:
 *
 *   1. **Identity check** — every inbound `message` event is dropped unless
 *      `event.source === handle.iframe.contentWindow`. `event.origin` is
 *      NOT trusted: every opaque-origin sandbox in the same renderer
 *      reports `"null"` and any other block iframe could spoof.
 *   2. **Channel check** — a per-handle channel id is minted at construction
 *      and stamped on every envelope in both directions. An inbound envelope
 *      whose `channelId` does not match the live id is dropped silently.
 *   3. **Phase gate** — postMessage delivery (inbound AND outbound) is gated
 *      on `handle.getPhase() === Mounted`. A `Paused` frame is treated as
 *      not-yet-visible; the transport drops messages in both directions
 *      rather than queuing (queuing would couple lifetime to the host and
 *      open a DoS surface; the BP protocol's contract is delivery to a
 *      visible block).
 *
 * The transport is the SECURE PIPE — not the BP protocol semantics. It
 * carries an opaque `payload: T` typed-generically. Block Protocol message
 * dispatch + Hook handlers live in 9.3.3; capability ENFORCEMENT lives in
 * the broker. The transport carries the capability LIST to the inner side
 * so the block knows what it can ask for; it does not gate calls.
 *
 * Dropped envelopes are silent — no console log, no telemetry. Logging a
 * spoofing attempt would itself be a DoS vector (an attacker could flood
 * the console / telemetry pipe). 9.5.3 added two further bounded-cost gates
 * for runaway-block scenarios (a *legitimate* block that misbehaves, not a
 * cross-frame attacker — those are rejected by the three security gates
 * above before reaching these):
 *
 *   4. **Payload-size cap** (`maxPayloadBytes`, default 256 KiB) — outbound
 *      and inbound envelopes whose JSON-length × 2 (UTF-16 byte proxy)
 *      exceed the cap are dropped. The cap is a per-message bound; the
 *      session-rate bound is the rate-limit gate.
 *   5. **Inbound rate-limit** (`maxInboundPerSecond`, default 1000) —
 *      after the security gates, a sliding-window counter bounds the rate
 *      a single transport can deliver to `onMessage`. Excess is dropped
 *      silently. The gate exists to keep one block from pinning the host
 *      event loop, not to police healthy traffic.
 *
 * Per-reason drop counters are exposed via `transport.dropCounts()` so a
 * future host-side telemetry surface can read them without the transport
 * emitting per-event log noise.
 *
 * Inner-frame helper: shipped at `./inner-transport.ts` (`@brainstorm-os/
 * sdk/block-frame/inner` subpath). The same envelope shape exported below
 * is the wire spec both sides honour.
 */

import type { BlockFrameHandle } from "./block-frame";
import {
	BLOCK_FRAME_DEFAULT_MAX_INBOUND_PER_SECOND,
	BLOCK_FRAME_DEFAULT_MAX_PAYLOAD_BYTES,
	BlockFrameDropReason,
	BlockFramePhase,
} from "./block-frame-constants";

/**
 * Direction the envelope is travelling. Wire format = string enum value so
 * a future telemetry surface (Stage 12) can serialise without renaming.
 *
 * `HostToBlock` envelopes flow `host → iframe.contentWindow.postMessage(...)`
 * (transport → block). `BlockToHost` envelopes flow back via the host's
 * `window` message listener (block → transport). Direction is stamped by
 * the sender so the receiver can reject envelopes pointing the wrong way
 * (an inbound `HostToBlock` is an impersonation attempt).
 */
export enum BlockFrameMessageDirection {
	HostToBlock = "host-to-block",
	BlockToHost = "block-to-host",
}

/**
 * Envelope kinds the transport itself recognises. The first envelope sent
 * to a freshly-mounted block is always `Startup`, which delivers the
 * capability list the broker has granted this `entityId`'s session.
 * Everything after is `Message` (BP protocol traffic) — the transport is
 * opaque to its payload.
 */
export enum BlockFrameMessageKind {
	/** Sent once on first Mounted transition — payload carries the
	 *  capability list the block runs with. */
	Startup = "startup",
	/** Opaque BP protocol message. Payload type is the transport's
	 *  generic parameter. */
	Message = "message",
}

/**
 * Wire-format envelope. `channelId` + `entityId` + `direction` + `kind` are
 * the security-relevant header; `payload` is opaque.
 *
 * This shape is the contract 9.4.4's inner-frame helper consumes. Adding
 * fields is fine (older inner helpers ignore unknowns); renaming or
 * dropping fields is a breaking change requiring coordinated rollout.
 */
export interface BlockFrameEnvelope<T = unknown> {
	readonly channelId: string;
	readonly entityId: string;
	readonly direction: BlockFrameMessageDirection;
	readonly kind: BlockFrameMessageKind;
	readonly payload: T;
}

/**
 * Startup envelope payload. The capability list is the snapshot the broker
 * has granted this `entityId`'s session — the block should NOT assume the
 * list is monotonic; broker policy may revoke. The block re-checks via the
 * broker on every call (capabilities here are advisory hints, not the
 * authoritative gate).
 */
export interface BlockFrameStartupPayload {
	readonly capabilities: readonly string[];
}

export interface CreateBlockFrameTransportOptions<TIn = unknown, TOut = unknown> {
	/** The 9.5.1 handle the transport wraps. Lifetime is owned by the
	 *  caller; calling `handle.destroy()` does not close the transport
	 *  (and vice-versa). Callers should `close()` the transport before
	 *  destroying the handle to remove the host's window listener
	 *  promptly. */
	readonly handle: BlockFrameHandle;
	/** Entity id this transport is bound to. Stamped on every envelope so
	 *  the inner side can multiplex.
	 *
	 *  Multi-transport-same-handle: `createBlockFrameTransport` does NOT
	 *  reject a second transport on the same handle. Each transport mints
	 *  its own channel id, so cross-talk is prevented by the channel-id
	 *  gate (an inbound from one transport's iframe with the OTHER
	 *  transport's channel id is dropped). Use this when a single iframe
	 *  legitimately hosts multiple BP bindings under different entity
	 *  ids (rare; primarily a multiplexing forward-compat). Today most
	 *  callers (9.4.4) will create exactly one transport per
	 *  `BlockFrameHandle`. */
	readonly entityId: string;
	/** Capability strings granted to this transport's session (e.g.
	 *  `"entities.read:Note"`). Carried in the startup envelope. The
	 *  transport does NOT enforce — broker does. */
	readonly capabilities: readonly string[];
	/** Callback fired for every well-formed inbound `Message` envelope.
	 *  `Startup` envelopes (which only flow Host→Block) are NOT forwarded
	 *  to `onMessage`. */
	readonly onMessage?: (payload: TIn) => void;
	/** Injection point for the message-event window. Tests in jsdom can
	 *  supply a fake to control source/origin. Defaults to
	 *  `globalThis.window`. */
	readonly host?: Pick<Window, "addEventListener" | "removeEventListener">;
	/** Channel-id minter. Defaults to `crypto.randomUUID()`; falls back to
	 *  `crypto.getRandomValues` if `randomUUID` is missing; throws if no
	 *  Web Crypto is available at all. The channel id is a security
	 *  primitive (per 9.5.1 `BLOCK_FRAME_TRANSPORT_REQUIREMENTS_FOR_9_5_2`)
	 *  — a non-CSPRNG fallback would be a regression. **Test-only**:
	 *  callers may pin a deterministic id; production code MUST leave this
	 *  undefined. */
	readonly mintChannelId?: () => string;
	/** Per-message payload-size cap (bytes, measured as JSON length of the
	 *  full envelope). Defaults to {@link BLOCK_FRAME_DEFAULT_MAX_PAYLOAD_BYTES}.
	 *  Outbound payloads over the cap are dropped (no `postMessage` call);
	 *  inbound envelopes over the cap are dropped before reaching
	 *  `onMessage`. The drop is silent (per-event logging is a DoS
	 *  amplifier); the per-reason counter exposed by
	 *  {@link BlockFrameTransport.dropCounts} is the only observable signal.
	 *  Cap must be `> 0`; values `≤ 0` fall back to the default. */
	readonly maxPayloadBytes?: number;
	/** Sliding-window inbound rate-limit (envelopes per rolling 1000ms).
	 *  Defaults to {@link BLOCK_FRAME_DEFAULT_MAX_INBOUND_PER_SECOND}. Once
	 *  the window count reaches the limit, additional inbound envelopes are
	 *  dropped + counted under
	 *  {@link BlockFrameDropReason.InboundRateLimited} until the window
	 *  slides past stale timestamps. The rate-limit applies to envelopes
	 *  that have already cleared the identity / channel / phase gates (a
	 *  spoofed flood is rejected before this counter advances; the gate
	 *  exists so a *legitimate* but runaway block can't pin the host's
	 *  event loop). Values `≤ 0` fall back to the default. */
	readonly maxInboundPerSecond?: number;
	/** Injection point for the clock the rate-limit uses. Tests inject a
	 *  deterministic source; production leaves undefined to use
	 *  `performance.now()` (falls back to `Date.now()` if performance
	 *  isn't available — both monotonic enough for a 1s window). */
	readonly now?: () => number;
	/** Phantom type bindings — keep `TIn`/`TOut` referenced so callers
	 *  can use the generic parameters meaningfully. */
	readonly __phantom?: { in?: TIn; out?: TOut };
}

export interface BlockFrameTransport<TOut = unknown> {
	/** The minted channel id for this transport. Exposed for the test
	 *  suite and for the inner-frame helper at 9.4.4 to mirror back. */
	readonly channelId: string;
	/** Send a BP protocol message to the block. No-op if the transport is
	 *  closed OR the handle's phase is not `Mounted`. The startup envelope
	 *  is flushed first if not yet sent. */
	send(payload: TOut): void;
	/** Whether the startup envelope (carrying the capability list) has
	 *  been sent to the block yet. */
	hasSentStartup(): boolean;
	/** Idempotent attempt to flush the startup envelope. Called
	 *  automatically by `send()` and at construction; the embedding seam
	 *  (9.4.4) calls this from the handle's `onPhase` callback when the
	 *  IntersectionObserver flips to `Mounted` so the block learns its
	 *  capability list as soon as it is visible (rather than waiting for
	 *  the first host→block message). Pass `force` to RE-send after the
	 *  first send — the embedding seam does this on the iframe's `load`
	 *  event so an async-loaded (`bsblock://`) block that wasn't listening
	 *  at the Mounted edge still receives Startup (the inner transport
	 *  ignores the duplicate). */
	flushStartup(force?: boolean): void;
	/** Whether `close()` has been called. */
	isClosed(): boolean;
	/** Snapshot of per-reason drop counters since transport construction.
	 *  Returns a fresh object each call (caller cannot mutate transport
	 *  state). Every reason maps to a non-negative integer; missing reasons
	 *  are zero. The transport itself never logs per-event (DoS amplifier);
	 *  a future telemetry surface reads counters via this method. */
	dropCounts(): Readonly<Record<BlockFrameDropReason, number>>;
	/** Tear down: remove the host's window listener, mark the transport
	 *  dead, drop subsequent send()s. Idempotent. Does NOT destroy the
	 *  underlying `handle`. */
	close(): void;
}

/**
 * Channel-id minter. Prefers `crypto.randomUUID()` (UUIDv4, 122 bits of
 * entropy from a CSPRNG); falls back to `crypto.getRandomValues()` for
 * environments that expose Web Crypto but not the `randomUUID` shortcut
 * (older browsers, certain test/sandbox shims). Throws if neither is
 * available — the channel id is load-bearing for the inbound-gate
 * security contract (per 9.5.1 `BLOCK_FRAME_TRANSPORT_REQUIREMENTS_FOR_
 * 9_5_2`), and a non-CSPRNG (e.g. `Math.random()`) would weaken the
 * primary defense against channel-id guessing. Production Electron
 * renderers always expose both APIs; the throw is a fail-loud signal
 * that the host runtime is wrong, not a path real callers will hit.
 */
export function defaultMintChannelId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	if (c && typeof c.getRandomValues === "function") {
		const bytes = new Uint8Array(16);
		c.getRandomValues(bytes);
		// RFC 4122 §4.4 — set version (4) + variant (10xx) bits so the
		// output is a well-formed UUIDv4 string indistinguishable from
		// `randomUUID`'s. The receiver doesn't care about the format —
		// the load-bearing property is the 122 bits of CSPRNG entropy.
		bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
		bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
		const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}
	throw new Error(
		"[block-frame/transport] no CSPRNG available — refusing to mint a non-cryptographic channel id (the channel id is the load-bearing inbound-gate defense; see BLOCK_FRAME_TRANSPORT_REQUIREMENTS_FOR_9_5_2)",
	);
}

/**
 * Estimate the byte size of an envelope. The transport uses `JSON.stringify`
 * as a conservative proxy for the structured-clone payload size — strings
 * stored as UTF-16 in V8 are reported here as their UTF-16 byte count
 * (2× the JS `.length`). The proxy is monotone: a payload over the cap
 * via JSON length cannot be under the cap via the postMessage walk. False
 * positives (objects unrepresentable as JSON like cyclic / Symbol /
 * function) are *intentionally* dropped — they are not valid BP payloads
 * either, so dropping them is a stricter form of the same gate. `try/catch`
 * around `stringify` catches the cyclic case (TypeError) and treats the
 * payload as oversize, dropping it.
 */
function estimateEnvelopeBytes(env: BlockFrameEnvelope<unknown>): number {
	try {
		const s = JSON.stringify(env);
		if (typeof s !== "string") return Number.POSITIVE_INFINITY;
		return s.length * 2;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function defaultNow(): number {
	const perf = globalThis.performance;
	if (perf && typeof perf.now === "function") return perf.now();
	return Date.now();
}

// Exhaustive-by-construction so a new BlockFrameDropReason added to the
// enum can never silently skip a counter (TS otherwise tolerates the
// missing key under the index signature). Build from Object.values
// rather than restating each variant — two files used to mirror this
// list and would silently drift.
function makeEmptyDropCounts(): Record<BlockFrameDropReason, number> {
	const counts = {} as Record<BlockFrameDropReason, number>;
	for (const reason of Object.values(BlockFrameDropReason)) counts[reason] = 0;
	return counts;
}

const RATE_LIMIT_WINDOW_MS = 1000;

/**
 * Build a postMessage transport over an existing block-frame handle. See
 * file doc for the threat model and the three security invariants.
 */
export function createBlockFrameTransport<TIn = unknown, TOut = unknown>(
	opts: CreateBlockFrameTransportOptions<TIn, TOut>,
): BlockFrameTransport<TOut> {
	const { handle, entityId, capabilities, onMessage } = opts;
	const host = opts.host ?? globalThis.window;
	const channelId = (opts.mintChannelId ?? defaultMintChannelId)();
	const frozenCapabilities = Object.freeze([...capabilities]) as readonly string[];
	const maxPayloadBytes =
		opts.maxPayloadBytes && opts.maxPayloadBytes > 0
			? opts.maxPayloadBytes
			: BLOCK_FRAME_DEFAULT_MAX_PAYLOAD_BYTES;
	const maxInboundPerSecond =
		opts.maxInboundPerSecond && opts.maxInboundPerSecond > 0
			? opts.maxInboundPerSecond
			: BLOCK_FRAME_DEFAULT_MAX_INBOUND_PER_SECOND;
	const now = opts.now ?? defaultNow;

	let closed = false;
	let startupSent = false;
	const dropCounts = makeEmptyDropCounts();
	// Sliding window of inbound timestamps. Stored as a ring-style buffer
	// pruned in-place on each accept attempt. Length is bounded by
	// `maxInboundPerSecond` because we never push after hitting the cap.
	const inboundWindow: number[] = [];

	const buildEnvelope = <T>(
		kind: BlockFrameMessageKind,
		direction: BlockFrameMessageDirection,
		payload: T,
	): BlockFrameEnvelope<T> => ({
		channelId,
		entityId,
		direction,
		kind,
		payload,
	});

	const postToBlock = (env: BlockFrameEnvelope<unknown>): void => {
		const target = handle.iframe.contentWindow;
		if (!target) return;
		// targetOrigin `"*"` is acceptable here: the inner doc is opaque-
		// origin sandboxed (`srcdoc` + sandbox-no-allow-same-origin), so
		// any opaque-origin frame in this renderer would also accept "*"
		// — the channel-id + identity gate on the inner side (9.4.4) is
		// the actual binding. Setting a specific origin would self-block
		// because opaque-origin's serialised origin is `"null"` and most
		// browsers reject `"null"` as a targetOrigin string.
		target.postMessage(env, "*");
	};

	const trySendStartup = (force = false): void => {
		// `force` re-sends even after the first send. A frame that loads its
		// document ASYNCHRONOUSLY (the `bsblock://` bundle path) may not have
		// attached its inner-transport listener yet when the Mounted edge first
		// flushes — that Startup is lost. The host re-flushes on the iframe's
		// `load` event with `force` so the now-listening block gets it; the
		// inner transport ignores the duplicate (Startup-once), so a double
		// send is harmless. The inline-`srcdoc` stub path is ready immediately
		// and never needs the re-flush.
		if (startupSent && !force) return;
		if (closed) return;
		if (handle.getPhase() !== BlockFramePhase.Mounted) return;
		const env = buildEnvelope<BlockFrameStartupPayload>(
			BlockFrameMessageKind.Startup,
			BlockFrameMessageDirection.HostToBlock,
			{ capabilities: frozenCapabilities },
		);
		// Startup envelopes carry only the capability list, which the
		// host minted — they are bounded by construction and not gated
		// against `maxPayloadBytes` (the gate exists for *block-supplied*
		// payloads). Skipping the check avoids a self-block in the rare
		// case a host configures a tiny cap for its own messages while
		// still wanting the block to receive its capability list.
		postToBlock(env);
		startupSent = true;
	};

	const acceptedByRateLimit = (): boolean => {
		const t = now();
		const cutoff = t - RATE_LIMIT_WINDOW_MS;
		// Prune stale timestamps from the front. The window is naturally
		// bounded by `maxInboundPerSecond`, so this walk is O(rate) per
		// inbound — cheap even at the cap.
		while (inboundWindow.length > 0 && (inboundWindow[0] ?? 0) <= cutoff) {
			inboundWindow.shift();
		}
		if (inboundWindow.length >= maxInboundPerSecond) return false;
		inboundWindow.push(t);
		return true;
	};

	const inboundHandler = (event: MessageEvent): void => {
		if (closed) return;
		// (1) Identity gate — only the bound iframe's contentWindow is
		// accepted. Sibling sandboxed iframes have distinct Window objects
		// even with identical opaque origins, so `event.source` is the
		// only reliable discriminator.
		if (event.source !== handle.iframe.contentWindow) {
			dropCounts[BlockFrameDropReason.InboundIdentity]++;
			return;
		}
		// (3) Phase gate (inbound) — a Paused frame should not be heard
		// from. The IntersectionObserver in 9.5.1 flips phase from the
		// browser's visibility signal; honouring it here keeps the block
		// inert when it is offscreen.
		if (handle.getPhase() !== BlockFramePhase.Mounted) {
			dropCounts[BlockFrameDropReason.InboundPhase]++;
			return;
		}
		const data = event.data as Partial<BlockFrameEnvelope<unknown>> | null | undefined;
		if (!data || typeof data !== "object") {
			dropCounts[BlockFrameDropReason.InboundMalformed]++;
			return;
		}
		// (2) Channel gate.
		if (data.channelId !== channelId) {
			dropCounts[BlockFrameDropReason.InboundChannel]++;
			return;
		}
		// Bound-entity gate — multiplexing is per-iframe today but the
		// envelope carries entityId for forward-compat; reject mismatch.
		if (data.entityId !== entityId) {
			dropCounts[BlockFrameDropReason.InboundEntityId]++;
			return;
		}
		// Direction gate — block→host envelopes only. A host→block
		// envelope arriving on this listener would be an impersonation
		// attempt (the host is the only sender of that direction).
		if (data.direction !== BlockFrameMessageDirection.BlockToHost) {
			dropCounts[BlockFrameDropReason.InboundDirection]++;
			return;
		}
		if (data.kind !== BlockFrameMessageKind.Message) {
			dropCounts[BlockFrameDropReason.InboundKind]++;
			return;
		}
		// Payload-size gate. Run *after* the cheap structural gates so a
		// spoofed flood of small malformed envelopes doesn't trigger the
		// stringify cost. JSON length × 2 is the UTF-16 byte proxy; cyclic
		// / non-serialisable values cap as infinity → drop. The size is
		// measured on the full envelope (not just `data.payload`) so the
		// header overhead is counted against the cap.
		const bytes = estimateEnvelopeBytes(data as BlockFrameEnvelope<unknown>);
		if (bytes > maxPayloadBytes) {
			dropCounts[BlockFrameDropReason.InboundPayloadTooLarge]++;
			return;
		}
		// Rate-limit gate — last because we only want to charge a *valid*
		// envelope against the runaway-block budget. A bursty attacker
		// flooding spoofed channel ids has already been rejected above.
		if (!acceptedByRateLimit()) {
			dropCounts[BlockFrameDropReason.InboundRateLimited]++;
			return;
		}
		try {
			onMessage?.(data.payload as TIn);
		} catch {
			// Host callbacks are observer-style; a throw must not break
			// the transport listener.
		}
	};

	host.addEventListener("message", inboundHandler as EventListener);

	// Try startup immediately in case the handle is already Mounted at
	// construction time. Otherwise the phase listener below catches the
	// transition.
	trySendStartup();

	// 9.5.1's `BlockFrameHandle` does not expose `onPhase` post-
	// construction (the phase callback is wired at `createBlockFrame`
	// time and not re-subscribable). The embedding seam at 9.4.4 owns
	// both the handle creation AND the transport creation; it forwards
	// the handle's `onPhase` Mounted edge into `transport.flushStartup()`.
	// We also flush opportunistically inside `send()` so any host that
	// forgets to wire the phase callback still emits startup before its
	// first message reaches the block.

	return {
		channelId,
		send(payload: TOut): void {
			if (closed) {
				dropCounts[BlockFrameDropReason.OutboundClosed]++;
				return;
			}
			if (handle.getPhase() !== BlockFramePhase.Mounted) {
				dropCounts[BlockFrameDropReason.OutboundNotMounted]++;
				return;
			}
			trySendStartup();
			const env = buildEnvelope<TOut>(
				BlockFrameMessageKind.Message,
				BlockFrameMessageDirection.HostToBlock,
				payload,
			);
			const bytes = estimateEnvelopeBytes(env);
			if (bytes > maxPayloadBytes) {
				dropCounts[BlockFrameDropReason.OutboundPayloadTooLarge]++;
				return;
			}
			postToBlock(env);
		},
		hasSentStartup: () => startupSent,
		flushStartup: (force?: boolean) => trySendStartup(force),
		isClosed: () => closed,
		dropCounts: () => Object.freeze({ ...dropCounts }),
		close(): void {
			if (closed) return;
			closed = true;
			host.removeEventListener("message", inboundHandler as EventListener);
		},
	};
}
