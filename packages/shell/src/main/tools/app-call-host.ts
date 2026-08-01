/**
 * AppCallHost — Tool-1, the reverse channel (doc 78 §The missing wire).
 *
 * Correlation-id request/response from the shell INTO an app renderer —
 * the wire every shell→app message lacked (all ~20 existing channels are
 * fire-and-forget `webContents.send`). Copies the shipped precedents
 * rather than inventing:
 *
 *   - `OpenWithPromptHost` — pending map, per-app cap, drain-on-detach,
 *     fail-closed defaults, pure (no Electron imports; the ipc wiring
 *     lives in `wire-app-call.ts`).
 *   - `WorkerBridge` — the settle asymmetry, preserved deliberately:
 *     TIMEOUT → reject (the caller mis-budgeted and must see it);
 *     detach/dispose → resolve `Unavailable` (the world changed under
 *     the caller; that is an answer, not a bug).
 *   - The block-frame transport's inbound gates — identity, size caps,
 *     silent drops with per-reason counters (logging a spoofing attempt
 *     would itself be a DoS vector).
 *
 * THE new invariant (doc 78 §Security): a reply is honored only when the
 * VERIFIED sender identity matches the app the call was sent to. The host
 * takes an already-verified `appId` — `wire-app-call.ts` resolves it via
 * `RendererIdentityRegistry` from `event.sender`; the host cross-checks it
 * against the pending entry and silently drops mismatches.
 */

import { ulid } from "ulid";
import { isReservedAppId } from "../apps/manifest";

export const TOOLS_CALL_CHANNEL = "tools:call" as const;
export const TOOLS_RESULT_CHANNEL = "tools:result" as const;

/** Shell-owned deadline per call (doc 78 §Performance budgets) — the app
 *  preload deliberately never settles after `pagehide`, so the SHELL owns
 *  the timeout. Mirrors `WorkerBridge`. */
export const APP_CALL_TIMEOUT_MS = 30_000;

/** Concurrent in-flight calls per provider app. Same ceiling family as
 *  `OpenWithPromptHost.MAX_PENDING`. Overflow answers `Busy` immediately
 *  so in-flight work the provider is actually doing survives. */
export const MAX_PENDING_PER_APP = 16;

/** Argument / result payload ceilings (JSON bytes). A provider's reply is
 *  untrusted renderer output; an unbounded value would sit in main-process
 *  memory on its way to the caller. */
export const APP_CALL_ARGS_BYTES_MAX = 256 * 1024;
export const APP_CALL_RESULT_BYTES_MAX = 1024 * 1024;

/** Clamp on the provider-supplied error string carried back to callers. */
export const APP_CALL_ERROR_CHARS_MAX = 500;

export enum AppCallFailure {
	/** No renderer attached for the app, or it went away mid-call. */
	Unavailable = "unavailable",
	/** The per-app pending cap is full. */
	Busy = "busy",
	/** Arguments or reply exceeded the payload ceiling (or didn't serialize). */
	TooLarge = "too-large",
	/** The provider answered with an error (message clamped). */
	Provider = "provider-error",
}

export type AppCallResult =
	| { ok: true; value: unknown }
	| { ok: false; reason: AppCallFailure; message?: string };

/** What rides the wire to the app renderer. */
export type AppCallRequest = { callId: string; tool: string; args: unknown };

/** What the app renderer posts back. Untrusted — validated field by field. */
export type AppCallReply = { callId?: unknown; ok?: unknown; value?: unknown; error?: unknown };

/** Minimal `WebContents` duck — mirrors `PromptSender`. */
export type AppCallSender = {
	send(channel: string, payload: AppCallRequest): void;
};

type Pending = {
	appId: string;
	resolve: (result: AppCallResult) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

/** Per-reason silent-drop counters — the block-frame pattern: observable
 *  in tests / diagnostics, never logged per event. */
export type AppCallDropCounters = {
	unknownCallId: number;
	wrongSender: number;
	malformedReply: number;
};

function payloadBytes(value: unknown): number | null {
	try {
		const json = JSON.stringify(value);
		return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
	} catch {
		return null;
	}
}

export class AppCallHost {
	/** Per app: the live renderer tabs, keyed by webContents id (insertion
	 *  order = attach order; calls target the most recently attached). An
	 *  app is only "gone" when its LAST tab detaches — parked containers
	 *  keep renderers alive, and one app id can have several tabs. */
	private readonly senders = new Map<string, Map<number, AppCallSender>>();
	private readonly pending = new Map<string, Pending>();
	private readonly pendingPerApp = new Map<string, number>();
	private readonly drops: AppCallDropCounters = {
		unknownCallId: 0,
		wrongSender: 0,
		malformedReply: 0,
	};

	/** Attach one live renderer tab for `appId`. Attaching drains nothing —
	 *  calls to an older tab settle by timeout, and a same-app reply from
	 *  any of the app's tabs still verifies (identity is per APP). */
	attachApp(appId: string, webContentsId: number, sender: AppCallSender): void {
		// Defence in depth: today the launcher registers identity (which already
		// refuses reserved ids) before attaching, but a future attach seam must
		// not be able to make a platform principal callable.
		if (isReservedAppId(appId)) return;
		let tabs = this.senders.get(appId);
		if (!tabs) {
			tabs = new Map();
			this.senders.set(appId, tabs);
		}
		// Re-attach moves the tab to most-recent position.
		tabs.delete(webContentsId);
		tabs.set(webContentsId, sender);
	}

	/** Detach one renderer tab. Pending calls drain to `Unavailable` (the
	 *  WorkerBridge dispose posture — an answer, not an error) only when the
	 *  app's LAST tab is gone; while any tab survives, in-flight calls may
	 *  still be answered by it. */
	detachApp(appId: string, webContentsId: number): void {
		const tabs = this.senders.get(appId);
		if (!tabs) return;
		tabs.delete(webContentsId);
		if (tabs.size > 0) return;
		this.senders.delete(appId);
		for (const [callId, p] of this.pending) {
			if (p.appId !== appId) continue;
			this.pending.delete(callId);
			this.bumpPending(appId, -1);
			this.settle(p, { ok: false, reason: AppCallFailure.Unavailable });
		}
	}

	/** Call `tool` in `appId`'s renderer. Resolves with the provider's reply
	 *  (or a structured failure); REJECTS only on timeout. */
	async call(appId: string, tool: string, args: unknown): Promise<AppCallResult> {
		const tabs = this.senders.get(appId);
		const sender = tabs ? Array.from(tabs.values()).at(-1) : undefined;
		if (!sender) return { ok: false, reason: AppCallFailure.Unavailable };
		const argBytes = payloadBytes(args);
		if (argBytes === null || argBytes > APP_CALL_ARGS_BYTES_MAX) {
			return { ok: false, reason: AppCallFailure.TooLarge };
		}
		if ((this.pendingPerApp.get(appId) ?? 0) >= MAX_PENDING_PER_APP) {
			return { ok: false, reason: AppCallFailure.Busy };
		}
		const callId = `apc_${ulid()}`;
		const promise = new Promise<AppCallResult>((resolve, reject) => {
			const entry: Pending = {
				appId,
				resolve,
				reject,
				timeout: setTimeout(() => {
					if (this.pending.get(callId) !== entry) return;
					this.pending.delete(callId);
					this.bumpPending(appId, -1);
					clearTimeout(entry.timeout);
					reject(new Error(`app call timed out after ${APP_CALL_TIMEOUT_MS}ms: ${appId}`));
				}, APP_CALL_TIMEOUT_MS),
			};
			this.pending.set(callId, entry);
			this.bumpPending(appId, 1);
		});
		try {
			sender.send(TOOLS_CALL_CHANNEL, { callId, tool, args });
		} catch {
			// A renderer destroyed between attach and send (teardown races the
			// call): settle the structured failure this class promises rather
			// than throwing a raw TypeError at the caller and holding the slot
			// for the full deadline.
			const entry = this.pending.get(callId);
			if (entry) {
				this.pending.delete(callId);
				this.bumpPending(appId, -1);
				this.settle(entry, { ok: false, reason: AppCallFailure.Unavailable });
			}
		}
		return await promise;
	}

	/**
	 * Apply a reply. `verifiedAppId` MUST come from the identity registry
	 * (never from the payload) — the wire layer resolves `event.sender` and
	 * refuses unregistered senders before this is reached. Mismatched or
	 * unknown replies are dropped silently (counted, never logged).
	 */
	handleResult(verifiedAppId: string, reply: AppCallReply): void {
		if (typeof reply?.callId !== "string") {
			this.drops.malformedReply += 1;
			return;
		}
		const entry = this.pending.get(reply.callId);
		if (!entry) {
			this.drops.unknownCallId += 1;
			return;
		}
		if (entry.appId !== verifiedAppId) {
			// THE invariant: only the renderer the call went to may answer it.
			this.drops.wrongSender += 1;
			return;
		}
		this.pending.delete(reply.callId);
		this.bumpPending(entry.appId, -1);
		if (reply.ok === true) {
			const bytes = payloadBytes(reply.value);
			if (bytes === null || bytes > APP_CALL_RESULT_BYTES_MAX) {
				this.settle(entry, { ok: false, reason: AppCallFailure.TooLarge });
				return;
			}
			this.settle(entry, { ok: true, value: reply.value });
			return;
		}
		const message =
			typeof reply.error === "string" ? reply.error.slice(0, APP_CALL_ERROR_CHARS_MAX) : undefined;
		this.settle(entry, {
			ok: false,
			reason: AppCallFailure.Provider,
			...(message !== undefined ? { message } : {}),
		});
	}

	/** Shutdown: every pending call resolves `Unavailable`. */
	dispose(): void {
		for (const [callId, p] of this.pending) {
			this.pending.delete(callId);
			this.settle(p, { ok: false, reason: AppCallFailure.Unavailable });
		}
		this.senders.clear();
		this.pendingPerApp.clear();
	}

	/** Per-reason drop counters (tests / diagnostics). */
	dropCounters(): Readonly<AppCallDropCounters> {
		return { ...this.drops };
	}

	/** In-flight count for one app (tests / backpressure introspection). */
	pendingFor(appId: string): number {
		return this.pendingPerApp.get(appId) ?? 0;
	}

	private settle(entry: Pending, result: AppCallResult): void {
		clearTimeout(entry.timeout);
		entry.resolve(result);
	}

	private bumpPending(appId: string, delta: number): void {
		const next = (this.pendingPerApp.get(appId) ?? 0) + delta;
		if (next <= 0) this.pendingPerApp.delete(appId);
		else this.pendingPerApp.set(appId, next);
	}
}
