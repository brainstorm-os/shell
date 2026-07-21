/**
 * `@brainstorm-os/sdk/block-frame` — 9.5.1 block-frame iframe primitive +
 * 9.5.2 postMessage transport.
 *
 * Standalone factory + constants the embedding apps consume to mount a
 * BP block in a sandboxed cross-origin opaque-origin iframe; the
 * transport layer carries the BP wire envelope over the host's `window`
 * message channel with identity + channel-id + phase gates. See
 * {@link ./block-frame.ts} / {@link ./transport.ts} for the security
 * posture; the rungs in (9.5.1 / 9.5.2)
 * for the why-now, and
 * for the design.
 */

export {
	BLOCK_FRAME_ALLOW,
	BLOCK_FRAME_BOOTSTRAP_GLOBAL,
	type BlockFrameBootstrap,
	BLOCK_FRAME_CSP,
	BLOCK_FRAME_CSP_DIRECTIVES,
	BLOCK_FRAME_DEFAULT_CLASS,
	BLOCK_FRAME_DEFAULT_MAX_INBOUND_PER_SECOND,
	BLOCK_FRAME_DEFAULT_MAX_PAYLOAD_BYTES,
	BLOCK_FRAME_LOADING,
	BLOCK_FRAME_REFERRER_POLICY,
	BLOCK_FRAME_ROOT_ID,
	BLOCK_FRAME_SANDBOX,
	BLOCK_FRAME_SCHEME,
	BLOCK_FRAME_SANDBOX_TOKENS,
	BLOCK_FRAME_SRCDOC,
	BLOCK_FRAME_TRANSPORT_REQUIREMENTS_FOR_9_5_2,
	BlockFrameDropReason,
	BlockFramePhase,
	buildBlockSrcdoc,
	makeBlockFrameUrl,
} from "./block-frame-constants";
export {
	type BlockFrameHandle,
	type BlockFrameSize,
	type CreateBlockFrameOptions,
	createBlockFrame,
} from "./block-frame";
export {
	type BlockFrameInnerTransport,
	createBlockFrameInnerTransport,
	type CreateBlockFrameInnerTransportOptions,
} from "./inner-transport";
export {
	type BlockFrameEnvelope,
	BlockFrameMessageDirection,
	BlockFrameMessageKind,
	type BlockFrameStartupPayload,
	type BlockFrameTransport,
	createBlockFrameTransport,
	type CreateBlockFrameTransportOptions,
	defaultMintChannelId,
} from "./transport";
