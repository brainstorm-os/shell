/**
 * In-iframe block runtime — the harness a first-party BP block bundle boots
 * with. It runs INSIDE the sandboxed opaque-origin frame (no ambient
 * authority, no `window.brainstorm`), so its only channel to the vault is the
 * inner postMessage transport (`@brainstorm-os/sdk/block-frame/inner`).
 *
 * Responsibilities, all the per-block plumbing factored out of the renderers:
 *   1. Read the routing identity the host injected into `window.__BS_BLOCK__`
 *      (channel id + entity id — the inner transport gates inbound on them).
 *   2. Open the inner transport; resolve `Startup` (the capability snapshot)
 *      and host→block `Message`s (graph responses, refresh pings).
 *   3. Expose a promise-based `graph(messageName, data)` that frames a BP 0.3
 *      Graph request, correlates the `*Response` by `requestId`, and rejects
 *      on a BP error envelope.
 *   4. Expose `navigate()` + `reportHeight()` — non-BP host messages the
 *      embedding app intercepts (open-an-entity, autosize the iframe).
 *   5. Run the block's `load` callback on first Startup (transport ready) and
 *      again on every host `refresh` ping (the entity changed underneath).
 *
 * The harness is deliberately framework-agnostic — it hands the block a
 * `root` element and the context; the block renders however it likes (the
 * first-party blocks use React, bundled into the same IIFE).
 */

import {
	BLOCK_FRAME_BOOTSTRAP_GLOBAL,
	BLOCK_FRAME_ROOT_ID,
	type BlockFrameBootstrap,
	type BlockFrameInnerTransport,
	createBlockFrameInnerTransport,
} from "@brainstorm-os/sdk/block-frame/inner";

/** Host→block control messages that are NOT BP protocol traffic (they carry
 *  no `requestId`/`module`). The embedding app sends `refresh`/`theme`; the
 *  block sends `navigate`/`height`/`theme-request`. Wire format = string enum
 *  value. */
export enum BlockControlKind {
	Refresh = "refresh",
	Navigate = "navigate",
	Height = "height",
	/** Host→block: the active theme's resolved CSS custom properties (a
	 *  `--token → value` map read from the host document's `:root`) plus the
	 *  `color-scheme`. The runtime mirrors them onto the frame's own `:root`
	 *  so the block's `var(--color-…)` styles paint in the live theme — the
	 *  opaque-origin frame can't read the embedder's `:root`, so the host
	 *  hands the values across the transport instead. */
	Theme = "theme",
	/** Block→host: sent once the runtime is ready, asking the host to push the
	 *  current {@link Theme} payload (the block can't read the embedder's
	 *  theme, and the host doesn't otherwise know when the frame is listening). */
	ThemeRequest = "theme-request",
}

/** Only well-formed `--token-name` custom-property keys are mirrored onto the
 *  frame's `:root` — defence-in-depth against a host (or a tampered transport)
 *  injecting an arbitrary style declaration through the value map. */
const THEME_VAR_KEY_RE = /^--[a-zA-Z0-9_-]+$/;

function applyThemeVars(
	win: Window,
	vars: Record<string, string> | undefined,
	colorScheme: string | undefined,
): void {
	const root = win.document.documentElement;
	if (!root) return;
	if (vars) {
		for (const [key, value] of Object.entries(vars)) {
			if (typeof value === "string" && THEME_VAR_KEY_RE.test(key)) {
				root.style.setProperty(key, value);
			}
		}
	}
	if (colorScheme === "dark" || colorScheme === "light") {
		root.style.setProperty("color-scheme", colorScheme);
	}
}

/** A BP 0.3 message envelope as it travels over the inner transport payload.
 *  The transport wraps it again in its own security envelope; this is the
 *  `payload`. */
interface BpWireMessage {
	requestId: string;
	messageName: string;
	module: string;
	source: string;
	timestamp: string;
	data?: unknown;
	errors?: ReadonlyArray<{ code: string; message: string }>;
}

/** The context a block's boot callback receives. */
export interface BlockRuntimeContext {
	/** The embedding entity id (the entity this block was dropped onto). */
	readonly entityId: string;
	/** Capability snapshot from the host Startup envelope. Advisory — the
	 *  broker re-checks every call; empty until Startup arrives. */
	capabilities(): readonly string[];
	/** The mount element the block renders into. */
	readonly root: HTMLElement;
	/** Issue a BP Graph request and resolve its `data` (or reject with the
	 *  first BP error). Correlated by `requestId`. */
	graph<T = unknown>(messageName: string, data: unknown): Promise<T>;
	/** Ask the host to open an entity (navigation is an app concern, not a
	 *  BP graph op). */
	navigate(entityId: string, entityType: string): void;
	/** Tell the host the block's current content height so it can autosize
	 *  the iframe. Call after every render. */
	reportHeight(px: number): void;
	/** Register the data-load callback. Runs once the transport is ready
	 *  (Startup) and again on every host `refresh` ping. */
	onLoad(run: () => void | Promise<void>): void;
}

/** Block boot callback — set up UI + register `onLoad`. */
export type BlockBoot = (ctx: BlockRuntimeContext) => void;

/** Test-only injection points. Production callers pass nothing — the harness
 *  uses the iframe's own `window` + `window.parent`. */
export interface StartBlockOptions {
	/** The window the block runs in (its document hosts the root + receives
	 *  inbound messages). Defaults to `globalThis.window`. */
	readonly win?: Window;
	/** The host window outbound messages post to. Defaults to
	 *  `globalThis.window.parent`. */
	readonly parent?: Pick<Window, "postMessage">;
}

function readBootstrap(win: Window): BlockFrameBootstrap | null {
	const raw = (win as unknown as Record<string, unknown>)[BLOCK_FRAME_BOOTSTRAP_GLOBAL];
	if (!raw || typeof raw !== "object") return null;
	const { channelId, entityId } = raw as Partial<BlockFrameBootstrap>;
	if (typeof channelId !== "string" || typeof entityId !== "string") return null;
	return { channelId, entityId };
}

let requestSeq = 0;
function nextRequestId(): string {
	requestSeq += 1;
	// Local correlation id only (host echoes it back); uniqueness within this
	// frame's lifetime is all that's required, so a counter suffices — no
	// CSPRNG needed (and `Math.random` is fine here, but a counter avoids it).
	return `req-${requestSeq}`;
}

/**
 * Boot a first-party BP block. Resolves the host bootstrap, opens the inner
 * transport, and invokes `boot` with the live context. Returns a teardown
 * function (removes the transport listener) — bundlers call it on unload; in
 * practice the frame is destroyed wholesale by the host.
 */
export function startBlock(boot: BlockBoot, opts: StartBlockOptions = {}): () => void {
	const win = opts.win ?? globalThis.window;
	const bootstrap = readBootstrap(win);
	const root =
		win.document.getElementById(BLOCK_FRAME_ROOT_ID) ??
		(() => {
			const el = win.document.createElement("div");
			el.id = BLOCK_FRAME_ROOT_ID;
			win.document.body.appendChild(el);
			return el;
		})();

	if (!bootstrap) {
		// No routing identity → we can't open a gated transport. Render
		// nothing rather than throw; the host shows its fallback card.
		return () => {};
	}

	let caps: readonly string[] = [];
	let loader: (() => void | Promise<void>) | null = null;
	const pending = new Map<
		string,
		{ resolve: (data: unknown) => void; reject: (err: Error) => void }
	>();

	let transport: BlockFrameInnerTransport<BpWireMessage | Record<string, unknown>> | null = null;

	const runLoader = (): void => {
		if (!loader) return;
		try {
			void Promise.resolve(loader()).catch(() => {
				/* block-supplied loader rejected; its own render shows the
				 * error — the harness stays alive for the next refresh. */
			});
		} catch {
			/* synchronous throw in loader — same rationale. */
		}
	};

	transport = createBlockFrameInnerTransport<BpWireMessage | Record<string, unknown>, unknown>({
		expectedChannelId: bootstrap.channelId,
		expectedEntityId: bootstrap.entityId,
		self: win,
		...(opts.parent ? { parent: opts.parent } : {}),
		onStartup: (payload) => {
			caps = payload.capabilities;
			// The frame can't read the embedder's `:root`, and the host doesn't
			// know when our inner transport started listening — so pull the theme
			// now that Startup proves the channel is live. The host answers with a
			// `Theme` message; later switches are pushed unprompted.
			transport?.send({ kind: BlockControlKind.ThemeRequest });
			runLoader();
		},
		onMessage: (payload) => {
			if (!payload || typeof payload !== "object") return;
			const msg = payload as Partial<BpWireMessage> & {
				kind?: string;
				vars?: Record<string, string>;
				colorScheme?: string;
			};
			if (msg.kind === BlockControlKind.Refresh) {
				runLoader();
				return;
			}
			if (msg.kind === BlockControlKind.Theme) {
				applyThemeVars(win, msg.vars, msg.colorScheme);
				return;
			}
			// BP graph response — correlate by requestId.
			if (typeof msg.requestId === "string" && pending.has(msg.requestId)) {
				const waiter = pending.get(msg.requestId);
				pending.delete(msg.requestId);
				if (!waiter) return;
				if (msg.errors && msg.errors.length > 0) {
					waiter.reject(new Error(msg.errors[0]?.code ?? "BP_ERROR"));
				} else {
					waiter.resolve((msg as BpWireMessage).data);
				}
			}
		},
	});

	const ctx: BlockRuntimeContext = {
		entityId: bootstrap.entityId,
		capabilities: () => caps,
		root,
		graph<T = unknown>(messageName: string, data: unknown): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				const requestId = nextRequestId();
				pending.set(requestId, {
					resolve: (d) => resolve(d as T),
					reject,
				});
				transport?.send({
					requestId,
					messageName,
					module: "graph",
					source: "block",
					timestamp: new Date().toISOString(),
					data,
				});
			});
		},
		navigate(entityId: string, entityType: string): void {
			transport?.send({ kind: BlockControlKind.Navigate, entityId, entityType });
		},
		reportHeight(px: number): void {
			transport?.send({ kind: BlockControlKind.Height, px: Math.ceil(px) });
		},
		onLoad(run: () => void | Promise<void>): void {
			loader = run;
		},
	};

	boot(ctx);

	return () => {
		transport?.close();
		pending.clear();
	};
}
