/**
 * `vault:*` app-lock IPC handlers (Stage 13.8c) — the privileged, dashboard-
 * owned surface for engaging / clearing the app-lock. Mirrors the
 * `shortcuts:*` pattern: `ipcMain.handle` (never the broker — a sandboxed app
 * must not be able to lock or unlock the vault on the user's behalf), plus an
 * `app:lock-changed` push to **every** window so all overlays show/tear-down
 * together ("unlock one window unlocks all", OQ-184).
 *
 * Channels:
 *   - `vault:lock`         → { locked: boolean }
 *   - `vault:unlock` (pin) → UnlockResult
 *   - `vault:lock-status`  → { locked: boolean }
 *   - `vault:set-pin` (pin)→ boolean   (set/replace; floor-validated)
 *   - `vault:clear-pin`    → boolean   (whether one existed)
 *   - `vault:has-pin`      → boolean
 *   - `vault:get-autolock` → number (idle minutes; 0 = off)
 *   - `vault:set-autolock` → boolean
 *   - `app:lock-changed`   push { locked: boolean }
 *
 * PIN set/clear/has act on the active (unlocked) session's keystore — the PIN
 * verifier is a keystore secret, not the master key. Dashboard-only like the
 * rest: a sandboxed app must never set, clear, or probe the lock PIN.
 *
 * The lock/unlock logic itself lives in `vault/session.ts` (13.8b) — this layer
 * only adapts IPC args + fans out the broadcast.
 */

import type { LockChangedPayload, UnlockResult } from "@brainstorm-os/protocol/app-lock-wire-types";
import { BrowserWindow, ipcMain } from "electron";
import {
	activeVaultHasPin,
	clearActiveVaultPin,
	getActiveVaultAutoLockMinutes,
	isVaultLocked,
	lockActiveVault,
	setActiveVaultAutoLockMinutes,
	setActiveVaultPin,
	unlockActiveVault,
} from "../vault/session";
import { warmupBroker } from "./vault-handlers";

export const VAULT_LOCK_CHANNEL = "vault:lock" as const;
export const VAULT_UNLOCK_CHANNEL = "vault:unlock" as const;
export const VAULT_LOCK_STATUS_CHANNEL = "vault:lock-status" as const;
export const VAULT_SET_PIN_CHANNEL = "vault:set-pin" as const;
export const VAULT_CLEAR_PIN_CHANNEL = "vault:clear-pin" as const;
export const VAULT_HAS_PIN_CHANNEL = "vault:has-pin" as const;
export const VAULT_GET_AUTOLOCK_CHANNEL = "vault:get-autolock" as const;
export const VAULT_SET_AUTOLOCK_CHANNEL = "vault:set-autolock" as const;
export const APP_LOCK_CHANGED_CHANNEL = "app:lock-changed" as const;

/** Floor on PIN shape, enforced main-side (defence-in-depth — the Settings UI
 *  enforces the exact 6-digit rule). Rejects empty / absurd lengths so a
 *  stale or hostile renderer can't store an unusable verifier. */
const MIN_PIN_LENGTH = 6;
const MAX_PIN_LENGTH = 64;
function isAcceptablePin(pin: unknown): pin is string {
	return typeof pin === "string" && pin.length >= MIN_PIN_LENGTH && pin.length <= MAX_PIN_LENGTH;
}

/** Push `app:lock-changed` to every live window's renderer. */
function defaultBroadcast(locked: boolean): void {
	for (const win of BrowserWindow.getAllWindows()) {
		const wc = win.webContents;
		if (!wc.isDestroyed()) wc.send(APP_LOCK_CHANGED_CHANNEL, { locked } satisfies LockChangedPayload);
	}
}

export type VaultLockHandlers = {
	lock(): { locked: boolean };
	unlock(pin: string): Promise<UnlockResult>;
	status(): { locked: boolean };
	setPin(pin: unknown): Promise<boolean>;
	clearPin(): Promise<boolean>;
	hasPin(): Promise<boolean>;
	getAutoLock(): Promise<number>;
	setAutoLock(minutes: unknown): Promise<boolean>;
};

/** Build the handler functions over an injectable `broadcast` (tests pass a
 *  spy; production uses the all-windows push) and an optional `onLockChange`
 *  (production hides every app window while locked + reveals them on unlock, so
 *  open apps don't stay visible behind the dashboard lock route — app windows
 *  are sandboxed and can't render the lock screen themselves). Both fire only on
 *  a genuine lock-state transition. Pure of `electron` so it's unit-testable
 *  against real vault sessions. */
export function makeVaultLockHandlers(
	broadcast: (locked: boolean) => void,
	onLockChange: (locked: boolean) => void = () => {},
): VaultLockHandlers {
	return {
		lock() {
			const mode = lockActiveVault();
			// Only fan out when something actually locked (a no-op lock — no active
			// vault, or already locked-and-broadcast — shouldn't re-spam renderers).
			if (mode !== null) {
				broadcast(true);
				onLockChange(true);
			}
			return { locked: isVaultLocked() };
		},
		async unlock(pin) {
			const result = await unlockActiveVault(pin);
			if (result.ok) {
				// A hard-unlock re-opened a brand-new VaultSession (same vaultId, fresh
				// ledger.db) — re-cache it on the broker before any app IPC arrives, so
				// the first call doesn't hit the disposed session's closed handle.
				// No-op when there's no workers handle (unit tests).
				await warmupBroker();
				broadcast(false);
				onLockChange(false);
			}
			return result;
		},
		status() {
			return { locked: isVaultLocked() };
		},
		setPin(pin) {
			if (!isAcceptablePin(pin)) return Promise.resolve(false);
			return setActiveVaultPin(pin);
		},
		clearPin() {
			return clearActiveVaultPin();
		},
		hasPin() {
			return activeVaultHasPin();
		},
		getAutoLock() {
			return getActiveVaultAutoLockMinutes();
		},
		setAutoLock(minutes) {
			if (typeof minutes !== "number") return Promise.resolve(false);
			return setActiveVaultAutoLockMinutes(minutes);
		},
	};
}

/** Register the `vault:*` channels on `ipcMain`. Dashboard-only; never broker.
 *  Returns the handlers so the host can reuse `lock()` for the auto-lock watcher
 *  (same path: lock → broadcast → app-window mask). */
export function registerVaultLockHandlers(
	options: {
		broadcast?: (locked: boolean) => void;
		onLockChange?: (locked: boolean) => void;
	} = {},
): VaultLockHandlers {
	const handlers = makeVaultLockHandlers(
		options.broadcast ?? defaultBroadcast,
		options.onLockChange,
	);
	ipcMain.handle(VAULT_LOCK_CHANNEL, () => handlers.lock());
	ipcMain.handle(VAULT_UNLOCK_CHANNEL, (_event, pinArg: unknown) =>
		handlers.unlock(typeof pinArg === "string" ? pinArg : ""),
	);
	ipcMain.handle(VAULT_LOCK_STATUS_CHANNEL, () => handlers.status());
	ipcMain.handle(VAULT_SET_PIN_CHANNEL, (_event, pinArg: unknown) => handlers.setPin(pinArg));
	ipcMain.handle(VAULT_CLEAR_PIN_CHANNEL, () => handlers.clearPin());
	ipcMain.handle(VAULT_HAS_PIN_CHANNEL, () => handlers.hasPin());
	ipcMain.handle(VAULT_GET_AUTOLOCK_CHANNEL, () => handlers.getAutoLock());
	ipcMain.handle(VAULT_SET_AUTOLOCK_CHANNEL, (_event, minutes: unknown) =>
		handlers.setAutoLock(minutes),
	);
	return handlers;
}
