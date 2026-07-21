/**
 * Block-side mirror of the host's `createBlockFrameTransport` (9.5.2). This
 * is the primitive a Block Protocol block author runs *inside* the sandboxed
 * iframe to talk to its host. It is a separate subpath
 * (`@brainstorm-os/sdk/block-frame/inner`) so block authors can pull only the
 * inner-side surface without dragging the host-side `createBlockFrame` /
 * IntersectionObserver / DOM-construction code into their bundle.
 *
 * Symmetry with the host-side transport:
 *
 *   • **Identity gate** — only `event.source === window.parent` is
 *     accepted. The block has exactly one legitimate counterparty (its
 *     host); every other `message` event is a spoofing attempt or a
 *     legit-but-not-mine cross-frame chat that this transport has nothing
 *     to do with.
 *   • **Channel gate** — the block is told its `expectedChannelId` at
 *     creation (the host's transport mints it; the embedding seam at
 *     9.4.4 carries it into the inner frame via the first Startup
 *     envelope). Inbound envelopes whose `channelId` doesn't match are
 *     dropped.
 *   • **Entity gate** — the block is bound to one `expectedEntityId`;
 *     mismatches are dropped.
 *   • **Direction gate** — only `HostToBlock` is accepted inbound; a
 *     `BlockToHost` arriving on the inner side is the host's own send
 *     looping back through a sibling-frame attacker, or impersonation —
 *     drop either way.
 *   • **Payload-size gate** — same UTF-16-byte JSON-length proxy as the
 *     host-side, same default cap (256 KiB), same per-message bound.
 *
 * The block does NOT enforce a phase gate (the block has no
 * IntersectionObserver / visibility signal — that's the host's domain).
 * The block does NOT enforce a rate-limit on the inbound side (the host
 * is trusted; rate-limiting inbound from the host would protect the
 * block from the host, which is not the threat model). Rate-limiting
 * outbound *from* the block is the host's gate (`maxInboundPerSecond`),
 * not something the block protects itself with — a hostile block would
 * remove its own rate-limit.
 *
 * Outbound from block: `send(payload)` posts a `BlockToHost` / `Message`
 * envelope to `window.parent` with `targetOrigin === "*"`. The block has
 * no way to know its host's origin (the embedding renderer is opaque to
 * the iframe's script context); the host's identity gate
 * (`event.source === handle.iframe.contentWindow`) is what authenticates,
 * not the targetOrigin string. Setting a specific origin would self-block.
 *
 * Per-reason drop counters are exposed via `dropCounts()` mirroring the
 * host. The transport is silent (no per-event log).
 */

import {
	BLOCK_FRAME_DEFAULT_MAX_PAYLOAD_BYTES,
	BlockFrameDropReason,
} from "./block-frame-constants";

// Re-export the DOM-free routing constants a block bundle needs to read its
// host-injected bootstrap, so a block author pulling only the `/inner`
// subpath gets them without dragging the host-side `createBlockFrame` in.
export {
	BLOCK_FRAME_BOOTSTRAP_GLOBAL,
	type BlockFrameBootstrap,
	BLOCK_FRAME_ROOT_ID,
} from "./block-frame-constants";
import {
	type BlockFrameEnvelope,
	BlockFrameMessageDirection,
	BlockFrameMessageKind,
	type BlockFrameStartupPayload,
} from "./transport";

export interface CreateBlockFrameInnerTransportOptions<TIn = unknown, TOut = unknown> {
	/** Channel id the host minted. The block learns this via the first
	 *  Startup envelope from the host (the embedding seam at 9.4.4
	 *  forwards it). The block CANNOT mint its own — it must echo back
	 *  what the host gave it. */
	readonly expectedChannelId: string;
	/** Entity id this block is bound to. Stamped on every outbound; checked
	 *  on every inbound. */
	readonly expectedEntityId: string;
	/** Callback fired for every well-formed inbound `Message` envelope.
	 *  Startup envelopes (always host→block) are routed to `onStartup`
	 *  instead and NOT forwarded here. */
	readonly onMessage?: (payload: TIn) => void;
	/** Callback fired exactly once on the first well-formed Startup
	 *  envelope (the host sends it once on first Mounted). The block
	 *  reads its capability list from `payload.capabilities`. */
	readonly onStartup?: (payload: BlockFrameStartupPayload) => void;
	/** The window the block runs in. Tests inject a fake; production
	 *  leaves undefined to use `globalThis.window` (the iframe's own
	 *  window). */
	readonly self?: Pick<Window, "addEventListener" | "removeEventListener">;
	/** The host's window (block→host postMessage target). Tests inject a
	 *  fake; production leaves undefined to use `globalThis.window.parent`. */
	readonly parent?: Pick<Window, "postMessage">;
	/** Per-message payload-size cap (bytes, UTF-16 byte JSON-length proxy).
	 *  Defaults to {@link BLOCK_FRAME_DEFAULT_MAX_PAYLOAD_BYTES}. Outbound
	 *  payloads over the cap are dropped before `postMessage`; inbound
	 *  over the cap are dropped before `onMessage`. */
	readonly maxPayloadBytes?: number;
	/** Phantom type bindings so callers can use the generic parameters. */
	readonly __phantom?: { in?: TIn; out?: TOut };
}

export interface BlockFrameInnerTransport<TOut = unknown> {
	/** Send a BP protocol message to the host. No-op if the transport is
	 *  closed or the payload exceeds the size cap. */
	send(payload: TOut): void;
	/** Whether `close()` has been called. */
	isClosed(): boolean;
	/** Whether the first valid Startup envelope has been observed (and
	 *  `onStartup` fired). */
	hasReceivedStartup(): boolean;
	/** Snapshot of per-reason drop counters since transport construction. */
	dropCounts(): Readonly<Record<BlockFrameDropReason, number>>;
	/** Tear down: remove the window listener, mark the transport dead,
	 *  drop subsequent send()s. Idempotent. */
	close(): void;
}

function estimateEnvelopeBytes(env: BlockFrameEnvelope<unknown>): number {
	try {
		const s = JSON.stringify(env);
		if (typeof s !== "string") return Number.POSITIVE_INFINITY;
		return s.length * 2;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

// Exhaustive-by-construction; see the host-side `makeEmptyDropCounts`
// rationale in `transport.ts`.
function makeEmptyDropCounts(): Record<BlockFrameDropReason, number> {
	const counts = {} as Record<BlockFrameDropReason, number>;
	for (const reason of Object.values(BlockFrameDropReason)) counts[reason] = 0;
	return counts;
}

/**
 * Build the block-side counterpart to a host transport. See file doc for
 * the gates and the rationale for each.
 */
export function createBlockFrameInnerTransport<TIn = unknown, TOut = unknown>(
	opts: CreateBlockFrameInnerTransportOptions<TIn, TOut>,
): BlockFrameInnerTransport<TOut> {
	const { expectedChannelId, expectedEntityId, onMessage, onStartup } = opts;
	const self = opts.self ?? globalThis.window;
	const parent = opts.parent ?? globalThis.window?.parent;
	const maxPayloadBytes =
		opts.maxPayloadBytes && opts.maxPayloadBytes > 0
			? opts.maxPayloadBytes
			: BLOCK_FRAME_DEFAULT_MAX_PAYLOAD_BYTES;

	let closed = false;
	let startupSeen = false;
	const dropCounts = makeEmptyDropCounts();

	const inboundHandler = (event: MessageEvent): void => {
		if (closed) return;
		// Identity gate — only the host (window.parent) is the legitimate
		// counterparty. A sibling iframe in the same renderer reports
		// `event.origin === "null"` too (opaque-origin sandbox); the only
		// reliable discriminator is the `source` Window reference.
		if (event.source !== parent) {
			dropCounts[BlockFrameDropReason.InboundIdentity]++;
			return;
		}
		const data = event.data as Partial<BlockFrameEnvelope<unknown>> | null | undefined;
		if (!data || typeof data !== "object") {
			dropCounts[BlockFrameDropReason.InboundMalformed]++;
			return;
		}
		if (data.channelId !== expectedChannelId) {
			dropCounts[BlockFrameDropReason.InboundChannel]++;
			return;
		}
		if (data.entityId !== expectedEntityId) {
			dropCounts[BlockFrameDropReason.InboundEntityId]++;
			return;
		}
		// Inner side accepts only HostToBlock. A BlockToHost arriving here
		// is either our own send looping back through a sibling-frame
		// attacker, or an attacker impersonating the host — drop either.
		if (data.direction !== BlockFrameMessageDirection.HostToBlock) {
			dropCounts[BlockFrameDropReason.InboundDirection]++;
			return;
		}
		// Startup is host-minted and bounded by construction (only carries
		// the capability list). Mirror the host transport's exemption from
		// the payload-size gate so a tighter inner cap can't accidentally
		// drop the legitimate Startup envelope and leave the block forever
		// without its capability snapshot.
		if (data.kind === BlockFrameMessageKind.Startup) {
			if (startupSeen) return;
			startupSeen = true;
			try {
				onStartup?.(data.payload as BlockFrameStartupPayload);
			} catch {
				/* host-supplied callback throws — keep listener live. */
			}
			return;
		}
		if (data.kind !== BlockFrameMessageKind.Message) {
			dropCounts[BlockFrameDropReason.InboundKind]++;
			return;
		}
		// Payload-size gate runs only for block-bound Message envelopes
		// (Startup is exempted above). Last gate so a spoofed flood of
		// small malformed envelopes doesn't trigger the stringify cost.
		const bytes = estimateEnvelopeBytes(data as BlockFrameEnvelope<unknown>);
		if (bytes > maxPayloadBytes) {
			dropCounts[BlockFrameDropReason.InboundPayloadTooLarge]++;
			return;
		}
		try {
			onMessage?.(data.payload as TIn);
		} catch {
			/* same rationale as the host-side transport. */
		}
	};

	self.addEventListener("message", inboundHandler as EventListener);

	return {
		send(payload: TOut): void {
			if (closed) {
				dropCounts[BlockFrameDropReason.OutboundClosed]++;
				return;
			}
			if (!parent || typeof parent.postMessage !== "function") {
				dropCounts[BlockFrameDropReason.OutboundClosed]++;
				return;
			}
			const env: BlockFrameEnvelope<TOut> = {
				channelId: expectedChannelId,
				entityId: expectedEntityId,
				direction: BlockFrameMessageDirection.BlockToHost,
				kind: BlockFrameMessageKind.Message,
				payload,
			};
			const bytes = estimateEnvelopeBytes(env);
			if (bytes > maxPayloadBytes) {
				dropCounts[BlockFrameDropReason.OutboundPayloadTooLarge]++;
				return;
			}
			parent.postMessage(env, "*");
		},
		isClosed: () => closed,
		hasReceivedStartup: () => startupSeen,
		dropCounts: () => Object.freeze({ ...dropCounts }),
		close(): void {
			if (closed) return;
			closed = true;
			self.removeEventListener("message", inboundHandler as EventListener);
		},
	};
}
