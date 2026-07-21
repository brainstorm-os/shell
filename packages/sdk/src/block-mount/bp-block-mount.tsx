/**
 * `<BpBlockMount>` — the shared inline mount seam (Stage 9.4.4) every
 * consuming BP block plugs into.
 *
 * Lifecycle wiring on top of the 9.5 trio:
 *
 *   1. On mount, build a container `<div>` and call `createBlockFrame`
 *      ({@link @brainstorm-os/sdk/block-frame}) to spawn the sandboxed
 *      opaque-origin iframe inside it.
 *   2. Open a `createBlockFrameTransport` over the handle, bound to the
 *      embedding `entityId` + capability snapshot. The transport mints
 *      a per-mount channel id; cross-talk between sibling embeds is
 *      prevented by the channel-id gate.
 *   3. When the IntersectionObserver flips the handle to `Mounted`, the
 *      transport flushes its `Startup` envelope (the capability list
 *      the block runs with). Subsequent host-to-block messages call
 *      `transport.send(payload)` via the imperative ref the seam
 *      exposes; block-to-host messages fire through `onMessage`.
 *   4. On unmount the seam closes the transport (removes the window
 *      message listener) THEN destroys the handle (unmounts the iframe,
 *      disconnects IntersectionObserver + ResizeObserver). The host
 *      DOM only sees the wrapper element come and go.
 *
 * v1 scope: the seam mounts the **stub srcdoc** the 9.5.1 primitive
 * ships (a near-empty `<html>` with the security CSP headers and no
 * BP-block code). That's enough to prove the wire-up — frame attaches,
 * transport flushes Startup, host can `send()`, block can postMessage
 * back — without an app-contributed BP block source loader (forward
 * scope: 9.5.x install-flow ships the block bundle; 9.11 wires
 * BlockEmbedView to swap from the fallback subtitle to this seam).
 *
 * Pure React; no Lexical, no Notes-specific assumptions. Any app that
 * embeds a BP block (Notes, Tasks, Calendar, Bookmarks, Database,
 * Graph) imports this seam directly — that's the "shared" half of
 * "shared mount seam".
 */

import type { BpMessage, BpService } from "@brainstorm-os/sdk-types";
import {
	type BlockFrameHandle,
	BlockFramePhase,
	type BlockFrameTransport,
	createBlockFrame,
	createBlockFrameTransport,
	defaultMintChannelId,
} from "@brainstorm-os/sdk/block-frame";
import {
	type CSSProperties,
	type JSX,
	type Ref,
	type RefObject,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
} from "react";

/** Per-mount control surface exposed via `ref`. Hosts call `send()` to
 *  dispatch a BP-protocol message to the block; `getPhase()` /
 *  `hasSentStartup()` / `dropCounts()` mirror the transport+handle
 *  observables for tests and dashboards. The seam keeps the underlying
 *  transport/handle private so a consumer can't accidentally call
 *  `destroy()` out of order. */
export interface BpBlockMountHandle<TOut = unknown> {
	send(payload: TOut): void;
	getPhase(): BlockFramePhase;
	hasSentStartup(): boolean;
	dropCounts(): ReturnType<BlockFrameTransport["dropCounts"]>;
}

export interface BpBlockMountProps<TIn = unknown, TOut = unknown> {
	/** The embedding entity's id — stamped on every envelope, scopes
	 *  capabilities, used as the BP `entityId` the block bootstraps
	 *  with. Changing this id remounts the seam (different scope =
	 *  different block instance). */
	readonly entityId: string;
	/** Capability list snapshotted into the Startup envelope. Static
	 *  for the life of one mount; if the broker revokes mid-session,
	 *  the seam does NOT re-flush — Block Protocol calls re-check via
	 *  the broker on every invocation (this list is advisory). */
	readonly capabilities: readonly string[];
	/** Inbound BP-protocol messages from the block. `Startup` envelopes
	 *  are NOT forwarded — they only flow host→block. */
	readonly onMessage?: (payload: TIn) => void;
	/** When set, the seam auto-forwards each inbound block message to the
	 *  host BP router via `bp.dispatch(entityId, message)` (9.4.5) and
	 *  sends the non-null response back over the transport — the full
	 *  block→host→block round-trip, so every embedding app gets it by
	 *  passing `bp={services.bp}` rather than re-wiring `onMessage`. The
	 *  `onMessage` prop still fires (observability) before the forward.
	 *  The shell validates the payload; a malformed message dispatches to
	 *  `null` and nothing is sent back. Dispatch errors (bridge failure)
	 *  are swallowed — the block falls back to its own rendering, matching
	 *  the transport's silent-drop contract. */
	readonly bp?: BpService;
	/** The BP block id to mount live. When present, the iframe loads the
	 *  providing app's bundle from its own `bsblock://` origin (shell-served)
	 *  instead of the inert stub. Changing it remounts the seam. Omit to keep
	 *  the stub. The embedding app sets this once it knows a bundle exists for
	 *  the block (via `services.blocks.source`). */
	readonly blockId?: string;
	/** Optional className for the wrapper element (the container the
	 *  iframe attaches to). The iframe itself gets the load-bearing
	 *  block-frame default class regardless. */
	readonly className?: string;
	/** Optional inline style for the wrapper element — the host uses this to
	 *  autosize the mount to the block's reported content height. Does not
	 *  touch the iframe's security-relevant attributes. */
	readonly style?: CSSProperties;
	/** Optional accessible label for the iframe. Hosts should pass a
	 *  pre-translated string (the SDK has no t() registry of its own). */
	readonly title?: string;
	/** Imperative ref exposing {@link BpBlockMountHandle}. */
	readonly handleRef?: Ref<BpBlockMountHandle<TOut>>;
	/** Injection points mirroring `createBlockFrame` — tests in jsdom
	 *  supply fakes; production callers leave undefined. */
	readonly IntersectionObserverImpl?: typeof IntersectionObserver;
	readonly ResizeObserverImpl?: typeof ResizeObserver;
	/** Injection point for the channel-id minter — tests pin a
	 *  deterministic id; production leaves undefined to use CSPRNG. */
	readonly mintChannelId?: () => string;
	/** Injection point for the host's window — tests supply a fake to
	 *  control inbound `message` events. Defaults to `globalThis.window`. */
	readonly host?: Pick<Window, "addEventListener" | "removeEventListener">;
}

/** Stable empty-array reference — used by the props comparator below so
 *  callers that omit `capabilities` don't trigger a remount on every
 *  parent render. */
const EMPTY_CAPS: readonly string[] = Object.freeze([]);

/**
 * The shared mount seam. Renders a wrapper element that hosts the
 * iframe; tears down the entire frame + transport stack on unmount.
 */
export function BpBlockMount<TIn = unknown, TOut = unknown>(
	props: BpBlockMountProps<TIn, TOut>,
): JSX.Element {
	const {
		entityId,
		capabilities,
		onMessage,
		bp,
		blockId,
		className,
		style,
		title,
		handleRef,
		IntersectionObserverImpl,
		ResizeObserverImpl,
		mintChannelId,
		host,
	} = props;

	const containerRef = useRef<HTMLDivElement | null>(null);
	const frameRef = useRef<BlockFrameHandle | null>(null);
	const transportRef = useRef<BlockFrameTransport<TOut> | null>(null);
	// Latest onMessage in a ref so we can swap the callback without
	// remounting the transport (which would re-flush Startup and re-mint
	// a channel id — neither legitimate behaviour for a callback change).
	const onMessageRef = useRef<typeof onMessage>(onMessage);
	onMessageRef.current = onMessage;
	// `bp` in a ref for the same reason as `onMessage`: swapping the
	// service must not churn the transport (remount → re-flush Startup +
	// re-mint channel id). Stable across the mount's life in practice.
	const bpRef = useRef<typeof bp>(bp);
	bpRef.current = bp;

	useImperativeHandle(
		handleRef as RefObject<BpBlockMountHandle<TOut> | null>,
		() => ({
			send: (payload: TOut) => transportRef.current?.send(payload),
			getPhase: () => frameRef.current?.getPhase() ?? BlockFramePhase.Unloaded,
			hasSentStartup: () => transportRef.current?.hasSentStartup() ?? false,
			dropCounts: () =>
				transportRef.current?.dropCounts() ?? ({} as ReturnType<BlockFrameTransport["dropCounts"]>),
		}),
		[],
	);

	// Effect deps: anything that changes the security-relevant identity
	// of this mount (entityId, capabilities) tears down and re-mounts.
	// The callbacks and class come in via refs / DOM attribute updates
	// so they don't churn the iframe.
	//
	// Capabilities arrive as a fresh array on every parent render even
	// when the contents haven't changed (`capabilities={[]}` is a new
	// literal each time). The capsKey serialisation is the stable-by-
	// content key the useMemo below is deliberately keyed on so the
	// snapshot identity only changes when the contents do. A `\n`
	// separator is unambiguous: capability strings never contain
	// newlines (they're reverse-DNS-ish `<svc>.<verb>:<scope>` per
	// ).
	const capsKey = (capabilities ?? EMPTY_CAPS).join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: capsKey-keyed by design — see comment above
	const capsSnapshot = useMemo(() => Object.freeze([...(capabilities ?? EMPTY_CAPS)]), [capsKey]);
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		// Mint ONE channel id up front and thread it through both halves:
		// the frame's srcdoc bootstrap (so the bundle's inner transport knows
		// the id it must gate inbound on — it can't arrive via Startup, which
		// is itself channel-gated) AND the transport (`mintChannelId` returns
		// this exact id). Without a real bundle the bootstrap is unused but
		// the transport still mints the same way.
		const channelId = (mintChannelId ?? defaultMintChannelId)();

		// 1. Mount the iframe. The createBlockFrame factory dictates
		//    every security attribute (sandbox tokens, allow=, CSP);
		//    nothing the seam passes can soften them. `source` only adds the
		//    script body + routing bootstrap inside the same pinned shell.
		const frame = createBlockFrame({
			container,
			...(title ? { title } : {}),
			...(blockId !== undefined ? { blockId, bootstrap: { channelId, entityId } } : {}),
			...(IntersectionObserverImpl ? { IntersectionObserverImpl } : {}),
			...(ResizeObserverImpl ? { ResizeObserverImpl } : {}),
			onPhase: (phase) => {
				if (phase === BlockFramePhase.Mounted) {
					// Visibility-edge flush: the block learns its capability
					// list the moment its iframe becomes intersected, not
					// when the host happens to send its first message.
					transportRef.current?.flushStartup();
				}
			},
		});
		frameRef.current = frame;

		// 2. Open the transport. The capability list is frozen by the
		//    transport on entry (deep-freeze inside startup payload
		//    handling), so a host mutation post-creation can't leak into
		//    the block's snapshot.
		const transport = createBlockFrameTransport<TIn, TOut>({
			handle: frame,
			entityId,
			capabilities: capsSnapshot,
			mintChannelId: () => channelId,
			onMessage: (payload) => {
				onMessageRef.current?.(payload);
				const bpService = bpRef.current;
				if (!bpService) return;
				// Forward to the host BP router and post the response back
				// into the frame. The shell re-validates the payload, so we
				// pass it through untyped (it arrived off the untrusted
				// frame); a malformed / non-dispatchable message resolves to
				// null and nothing is sent. Bridge failures are swallowed —
				// the block degrades to its own rendering.
				bpService
					.dispatch(entityId, payload as unknown as BpMessage)
					.then((response) => {
						if (response) transportRef.current?.send(response as unknown as TOut);
					})
					.catch(() => {});
			},
			...(host ? { host } : {}),
		});
		transportRef.current = transport;

		// 3. Eagerly try to flush Startup. If the IntersectionObserver
		//    delivers Mounted synchronously (production browsers don't
		//    promise this; test fakes typically do), we beat the
		//    onPhase callback to it. Idempotent so calling both paths
		//    is safe.
		transport.flushStartup();

		// 4. RE-flush Startup on the iframe `load`. A `bsblock://` bundle
		//    frame loads its document ASYNCHRONOUSLY, so the Mounted-edge
		//    flush above can fire before the block's inner transport is
		//    listening — that Startup is lost. `load` fires once the document
		//    (and its inner transport) is ready; the forced re-flush reaches
		//    it (the inner side ignores the duplicate Startup).
		const onFrameLoad = (): void => transportRef.current?.flushStartup(true);
		frame.iframe.addEventListener("load", onFrameLoad);

		return () => {
			// Close transport BEFORE destroying the handle so the window
			// listener is removed before the iframe goes away — avoids
			// any chance of an in-flight `message` event firing against
			// a half-torn-down handle.
			frame.iframe.removeEventListener("load", onFrameLoad);
			transport.close();
			frame.destroy();
			if (transportRef.current === transport) transportRef.current = null;
			if (frameRef.current === frame) frameRef.current = null;
		};
	}, [
		entityId,
		capsSnapshot,
		blockId,
		title,
		IntersectionObserverImpl,
		ResizeObserverImpl,
		host,
		mintChannelId,
	]);

	return (
		<div
			ref={containerRef}
			className={className}
			data-bp-block-mount-entity-id={entityId}
			{...(style ? { style } : {})}
		/>
	);
}
