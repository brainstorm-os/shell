/**
 * App-lock wire types (Stage 13.8) — shared by the main-process session module,
 * the `vault:*` IPC handlers, the preload bridge, and the renderer lock-screen
 * surface. Renderer-safe: pure types, no `electron` import (the
 * `sync-status-types` precedent — keeps the renderer/preload bundle clean).
 */

export type UnlockReason = "not-locked" | "wrong-pin" | "capped";

export type UnlockResult =
	| { ok: true }
	| { ok: false; reason: UnlockReason; failedAttempts: number; cooldownMs: number };

/** Payload of the `app:lock-changed` push — every window mirrors this. */
export type LockChangedPayload = { locked: boolean };
