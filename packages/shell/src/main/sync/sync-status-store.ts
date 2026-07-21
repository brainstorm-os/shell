/**
 * Stage 10.7 — sync-status store.
 *
 * One aggregate `SyncStatusSnapshot` per active vault: the live transport
 * state (read from `ActiveRelayOrchestrator`), the timestamps of the last
 * inbound/outbound traffic ticks (recorded by the pipeline via the new
 * optional `onSent` / `onReceived` callbacks), the `WebSocketRelayPort`
 * drop counters, and a couple of seq-tracker diagnostics surfaced as
 * file-stat + pair-key-count only — **never** the raw `(sender, entityId)`
 * keys themselves (sender pubkey is a device fingerprint).
 *
 * Derivation lives partly in main (`SyncState.LocalOnly` /
 * `Offline` / `Error` — transport-state shaped) and partly in the
 * renderer (`Syncing` vs `Stale` — derived against `Date.now()` against
 * the `RECENT_TRAFFIC_MS` / `STALE_AFTER_MS` thresholds). The renderer
 * runs ONE shared ~5s `setInterval` to re-derive Stale; the store
 * doesn't burn a timer for it.
 *
 * **Debounce.** Traffic ticks coalesce on a 500ms trailing timer.
 * State-change edges (transport-state transitions, vault-session swap,
 * 1-second Error-sticky elapse) fire immediately, bypassing the
 * debounce so the chip paints "Offline" the moment the wire drops.
 * Counters (`droppedSends`, `droppedInbound`) ride the next coalesced
 * tick — they're observational, not user-facing in the chip itself.
 *
 * Per OQ-208 / OQ-209 / OQ-210 (resolved 2026-05-23): stale = 30s,
 * Error sticky = 1s linger threshold, LocalOnly stays quiet-but-visible.
 */

import { statSync } from "node:fs";
import type { AttachmentSyncPauseReason } from "@brainstorm-os/protocol/quota-types";
import { ActiveRelayKind, type ActiveRelayOrchestrator } from "./active-relay";
import { seqTrackerPath } from "./seq-tracker";
import { type WebSocketRelayPort, WebSocketRelayState } from "./websocket-relay-port";

export enum SyncState {
	LocalOnly = "local-only",
	Syncing = "syncing",
	Stale = "stale",
	Offline = "offline",
	Error = "error",
}

export type SyncStatusSnapshot = {
	state: SyncState;
	transportState: WebSocketRelayState | null;
	relayUrl: string | null;
	connectionId: string | null;
	lastInboundAtMs: number | null;
	lastOutboundAtMs: number | null;
	droppedSends: number;
	droppedInbound: number;
	seqStateBytes: number;
	pairKeyCount: number;
	/** 14.7 — why attachment uploads are paused (storage quota), or null. */
	attachmentSyncPausedReason: AttachmentSyncPauseReason | null;
};

export const RECENT_TRAFFIC_MS = 5_000;
export const STALE_AFTER_MS = 30_000;
export const ERROR_STICKY_MS = 1_000;
const COALESCE_DEBOUNCE_MS = 500;

export type SyncStatusVaultSessionLike = {
	vaultPath: string;
};

export type SyncStatusStoreOptions = {
	activeRelay: ActiveRelayOrchestrator;
	getVaultSession: () => SyncStatusVaultSessionLike | null;
	/** Injectable for tests — defaults to `Date.now`. */
	clock?: () => number;
	/** Injectable for tests — defaults to native `setTimeout`/`clearTimeout`. */
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Injectable for tests — defaults to `node:fs.statSync`. Only the
	 *  `size` property is read, so the test fake's surface is narrow. */
	statFile?: (path: string) => { size: number } | undefined;
	/** Injectable for tests — defaults to file-read parse. Returns the
	 *  pair-key count by parsing the persisted seq.json. Never exposes
	 *  the raw keys (privacy). */
	readSeqPairCount?: (path: string) => number;
	/** 14.7 — the quota gate's pause signal (`QuotaService`), riding every
	 *  snapshot so the dashboard can show "attachment sync paused: storage
	 *  quota". Absent ⇒ never paused. */
	getAttachmentSyncPausedReason?: () => AttachmentSyncPauseReason | null;
};

const ChangeReason = {
	StateEdge: "state-edge",
	Coalesced: "coalesced",
} as const;
type ChangeReason = (typeof ChangeReason)[keyof typeof ChangeReason];

export class SyncStatusStore {
	readonly #activeRelay: ActiveRelayOrchestrator;
	readonly #getVaultSession: () => SyncStatusVaultSessionLike | null;
	readonly #clock: () => number;
	readonly #setTimer: (cb: () => void, ms: number) => unknown;
	readonly #clearTimer: (handle: unknown) => void;
	readonly #statFile: (path: string) => { size: number } | undefined;
	readonly #readSeqPairCount: (path: string) => number;
	readonly #getAttachmentSyncPausedReason: () => AttachmentSyncPauseReason | null;
	readonly #listeners = new Set<(snap: SyncStatusSnapshot | null) => void>();
	#started = false;
	#disposed = false;
	#lastInboundAtMs: number | null = null;
	#lastOutboundAtMs: number | null = null;
	#errorEnteredAtMs: number | null = null;
	#errorPaintedSticky = false;
	#errorStickyTimer: unknown = null;
	#coalesceTimer: unknown = null;
	#detachActiveRelay: (() => void) | null = null;

	constructor(opts: SyncStatusStoreOptions) {
		this.#activeRelay = opts.activeRelay;
		this.#getVaultSession = opts.getVaultSession;
		this.#clock = opts.clock ?? Date.now;
		this.#setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
		this.#clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		this.#statFile = opts.statFile ?? ((path: string) => statSync(path));
		this.#readSeqPairCount = opts.readSeqPairCount ?? defaultReadSeqPairCount;
		this.#getAttachmentSyncPausedReason = opts.getAttachmentSyncPausedReason ?? (() => null);
	}

	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		const onState = (): void => {
			this.#evaluateErrorSticky();
			this.#emit(ChangeReason.StateEdge);
		};
		this.#activeRelay.on("state", onState);
		this.#detachActiveRelay = () => this.#activeRelay.off("state", onState);
		// Initial reading — capture sticky-Error timing if we boot into Error.
		this.#evaluateErrorSticky();
	}

	stop(): void {
		if (!this.#started) return;
		this.#started = false;
		this.#detachActiveRelay?.();
		this.#detachActiveRelay = null;
		if (this.#coalesceTimer !== null) {
			this.#clearTimer(this.#coalesceTimer);
			this.#coalesceTimer = null;
		}
		if (this.#errorStickyTimer !== null) {
			this.#clearTimer(this.#errorStickyTimer);
			this.#errorStickyTimer = null;
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.stop();
		this.#disposed = true;
		this.#listeners.clear();
	}

	snapshot(): SyncStatusSnapshot | null {
		if (this.#disposed) return null;
		const session = this.#getVaultSession();
		if (!session) return null;
		return this.#composeSnapshot(session);
	}

	onChange(listener: (snap: SyncStatusSnapshot | null) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	recordOutbound(_frameBytes: number): void {
		if (this.#disposed) return;
		this.#lastOutboundAtMs = this.#clock();
		this.#scheduleCoalesced();
	}

	recordInbound(_frameBytes: number): void {
		if (this.#disposed) return;
		this.#lastInboundAtMs = this.#clock();
		this.#scheduleCoalesced();
	}

	/** Notify the store the active vault session changed. Bypasses the
	 *  500ms coalesce timer so the chip paints the LocalOnly/Offline
	 *  shape immediately on vault open / close. Counter + traffic
	 *  state stays attached to the store; tests can reset by disposing. */
	notifyVaultSessionChanged(): void {
		if (this.#disposed) return;
		this.#lastInboundAtMs = null;
		this.#lastOutboundAtMs = null;
		this.#errorEnteredAtMs = null;
		this.#errorPaintedSticky = false;
		if (this.#errorStickyTimer !== null) {
			this.#clearTimer(this.#errorStickyTimer);
			this.#errorStickyTimer = null;
		}
		this.#emit(ChangeReason.StateEdge);
	}

	/** 14.7 — the quota pause signal flipped; re-emit immediately (a state
	 *  edge, like a transport transition — the dashboard should paint the
	 *  "attachment sync paused" line without waiting for traffic). */
	notifyQuotaChanged(): void {
		if (this.#disposed) return;
		this.#emit(ChangeReason.StateEdge);
	}

	#scheduleCoalesced(): void {
		if (this.#coalesceTimer !== null) return;
		this.#coalesceTimer = this.#setTimer(() => {
			this.#coalesceTimer = null;
			this.#emit(ChangeReason.Coalesced);
		}, COALESCE_DEBOUNCE_MS);
	}

	#emit(_reason: ChangeReason): void {
		if (this.#disposed) return;
		const snap = this.snapshot();
		for (const listener of this.#listeners) {
			try {
				listener(snap);
			} catch (error) {
				console.warn("[brainstorm] sync-status onChange listener threw:", error);
			}
		}
	}

	#evaluateErrorSticky(): void {
		const transport = readTransport(this.#activeRelay);
		const transportState = transport?.state ?? null;
		if (transportState === WebSocketRelayState.Error) {
			if (this.#errorEnteredAtMs === null) {
				this.#errorEnteredAtMs = this.#clock();
				this.#errorPaintedSticky = false;
				if (this.#errorStickyTimer !== null) this.#clearTimer(this.#errorStickyTimer);
				this.#errorStickyTimer = this.#setTimer(() => {
					this.#errorStickyTimer = null;
					if (this.#disposed) return;
					if (readTransport(this.#activeRelay)?.state === WebSocketRelayState.Error) {
						this.#errorPaintedSticky = true;
						this.#emit(ChangeReason.StateEdge);
					}
				}, ERROR_STICKY_MS);
			}
		} else {
			this.#errorEnteredAtMs = null;
			this.#errorPaintedSticky = false;
			if (this.#errorStickyTimer !== null) {
				this.#clearTimer(this.#errorStickyTimer);
				this.#errorStickyTimer = null;
			}
		}
	}

	#composeSnapshot(session: SyncStatusVaultSessionLike): SyncStatusSnapshot {
		const relayState = this.#activeRelay.state();
		const lastInboundAtMs = this.#lastInboundAtMs;
		const lastOutboundAtMs = this.#lastOutboundAtMs;
		if (relayState.kind === ActiveRelayKind.Loopback) {
			return {
				state: SyncState.LocalOnly,
				transportState: null,
				relayUrl: null,
				connectionId: null,
				lastInboundAtMs,
				lastOutboundAtMs,
				droppedSends: 0,
				droppedInbound: 0,
				...this.#readSeqDiagnostics(session.vaultPath),
				attachmentSyncPausedReason: this.#pausedReasonSafe(),
			};
		}
		const transport = readTransport(this.#activeRelay);
		const transportState = transport?.state ?? null;
		const relayUrl = relayState.syncRelayUrl ?? transport?.url ?? null;
		const state = this.#deriveState(transportState, lastInboundAtMs, lastOutboundAtMs);
		return {
			state,
			transportState,
			relayUrl,
			connectionId: null,
			lastInboundAtMs,
			lastOutboundAtMs,
			droppedSends: transport?.droppedSends() ?? 0,
			droppedInbound: transport?.droppedInbound() ?? 0,
			...this.#readSeqDiagnostics(session.vaultPath),
			attachmentSyncPausedReason: this.#pausedReasonSafe(),
		};
	}

	#pausedReasonSafe(): AttachmentSyncPauseReason | null {
		try {
			return this.#getAttachmentSyncPausedReason();
		} catch {
			return null;
		}
	}

	#deriveState(
		transportState: WebSocketRelayState | null,
		lastInboundAtMs: number | null,
		lastOutboundAtMs: number | null,
	): SyncState {
		if (transportState === WebSocketRelayState.Error) {
			return this.#errorPaintedSticky ? SyncState.Error : SyncState.Offline;
		}
		if (
			transportState === WebSocketRelayState.Connecting ||
			transportState === WebSocketRelayState.Reconnecting ||
			transportState === WebSocketRelayState.Closed ||
			transportState === WebSocketRelayState.Idle ||
			transportState === null
		) {
			return SyncState.Offline;
		}
		// transportState === Open
		const now = this.#clock();
		const latest = Math.max(
			lastInboundAtMs ?? Number.NEGATIVE_INFINITY,
			lastOutboundAtMs ?? Number.NEGATIVE_INFINITY,
		);
		if (!Number.isFinite(latest)) return SyncState.Stale;
		if (now - latest <= RECENT_TRAFFIC_MS) return SyncState.Syncing;
		if (now - latest >= STALE_AFTER_MS) return SyncState.Stale;
		return SyncState.Syncing;
	}

	#readSeqDiagnostics(vaultPath: string): { seqStateBytes: number; pairKeyCount: number } {
		const path = seqTrackerPath(vaultPath);
		let seqStateBytes = 0;
		try {
			const stat = this.#statFile(path);
			if (stat && typeof stat.size === "number") seqStateBytes = stat.size;
		} catch {
			// ENOENT or transient FS error — diagnostics are best-effort.
		}
		let pairKeyCount = 0;
		try {
			pairKeyCount = this.#readSeqPairCount(path);
		} catch {
			// Same posture — best-effort.
		}
		return { seqStateBytes, pairKeyCount };
	}
}

function readTransport(activeRelay: ActiveRelayOrchestrator): WebSocketRelayPort | null {
	const state = activeRelay.state();
	if (state.kind !== ActiveRelayKind.WebSocket) return null;
	const port = state.port as WebSocketRelayPort;
	if (typeof port?.state !== "string") return null;
	return port;
}

function defaultReadSeqPairCount(path: string): number {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as {
			receive?: Record<string, unknown>;
		};
		if (!parsed.receive || typeof parsed.receive !== "object") return 0;
		return Object.keys(parsed.receive).length;
	} catch {
		return 0;
	}
}
