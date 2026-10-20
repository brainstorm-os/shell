/**
 * App-lock auto-lock watcher (Stage 13.8 surface). Engages the lock when the
 * machine has been idle past the per-vault `autoLockMinutes`, or immediately on
 * a system sleep / OS-screen-lock signal. "Idle" is the *effective* idle —
 * `min(systemIdle, appIdle)` — so foreground in-app activity that emits no OS
 * keyboard/mouse input (media playback, a long import/sync) still counts as the
 * user being present and defers the lock. All triggers are gated on: auto-lock
 * enabled (`minutes > 0`), a PIN being set, and the vault not already locked.
 *
 * Pure of `electron`: every dependency (system idle time, the setting, the PIN
 * probe, the lock action, the suspend/lock-screen subscription, the timer) is
 * injected, so the orchestration is unit-testable with fakes + fake timers. The
 * real wiring (`powerMonitor` + the `vault:lock` handler) lives in `index.ts`.
 */

const DEFAULT_POLL_MS = 15_000;

/** Seconds since the shell last showed a window. Sampled at each poll, so it
 *  is accurate to the poll interval — fine against minute-scale timeouts. */
export function createBackgroundedClock(
	anyWindowVisible: () => boolean,
	now: () => number = Date.now,
): () => number {
	let hiddenSince: number | null = null;
	return () => {
		if (anyWindowVisible()) {
			hiddenSince = null;
			return 0;
		}
		hiddenSince ??= now();
		return (now() - hiddenSince) / 1000;
	};
}

/** Pure idle decision — exposed for direct testing. */
export function shouldAutoLockOnIdle(idleSeconds: number, autoLockMinutes: number): boolean {
	return autoLockMinutes > 0 && idleSeconds >= autoLockMinutes * 60;
}

export type AppLockWatcherDeps = {
	/** Seconds since the last user input, system-wide (`powerMonitor.getSystemIdleTime()`). */
	getIdleSeconds: () => number;
	/** Seconds since the last *foreground* app→host IPC activity (`Infinity` when
	 *  none yet). Folded into the idle decision via `min(systemIdle, appIdle)` so
	 *  in-app activity with no OS input still defers the lock. Optional — omitted
	 *  ⇒ system-idle only (the pre-activity-tracking behaviour). */
	getAppIdleSeconds?: () => number;
	/** Seconds the shell has had NO visible window (closed to the tray, or every
	 *  window hidden); `0` while anything is shown. Raises the effective idle:
	 *  input in other apps resets the system idle clock, but nobody can be
	 *  using a vault they cannot see, so a backgrounded vault still locks after
	 *  the same timeout. Optional — omitted ⇒ visibility is not considered. */
	getBackgroundedSeconds?: () => number;
	/** Current per-vault idle timeout in minutes (`0` = auto-lock off). */
	getAutoLockMinutes: () => Promise<number>;
	/** Whether the active vault has a PIN set (no PIN → nothing to lock against). */
	hasPin: () => Promise<boolean>;
	/** Whether the vault is already locked. */
	isLocked: () => boolean;
	/** Engage the lock — the same path as the `vault:lock` IPC handler. */
	lock: () => void;
	/** Subscribe to immediate-lock system signals (suspend + OS screen-lock);
	 *  returns an unsubscribe. */
	subscribeSystemLock: (handler: () => void) => () => void;
	pollMs?: number;
	setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
	clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
};

export type AppLockWatcher = {
	start: () => void;
	stop: () => void;
};

export function createAppLockWatcher(deps: AppLockWatcherDeps): AppLockWatcher {
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const setIntervalFn = deps.setInterval ?? setInterval;
	const clearIntervalFn = deps.clearInterval ?? clearInterval;
	let timer: ReturnType<typeof setInterval> | null = null;
	let unsubscribe: (() => void) | null = null;

	// `ignoreIdle` is set for the system signals (sleep/screen-lock) — those lock
	// immediately, not after the idle threshold.
	const maybeLock = async (ignoreIdle: boolean): Promise<void> => {
		if (deps.isLocked()) return;
		const minutes = await deps.getAutoLockMinutes();
		if (minutes <= 0) return;
		if (!ignoreIdle) {
			const appIdle = deps.getAppIdleSeconds?.() ?? Number.POSITIVE_INFINITY;
			const effectiveIdle = Math.max(
				Math.min(deps.getIdleSeconds(), appIdle),
				deps.getBackgroundedSeconds?.() ?? 0,
			);
			if (!shouldAutoLockOnIdle(effectiveIdle, minutes)) return;
		}
		if (!(await deps.hasPin())) return;
		// Re-check after the awaits — an unlock could have raced in.
		if (deps.isLocked()) return;
		deps.lock();
	};

	return {
		start() {
			if (timer !== null) return;
			timer = setIntervalFn(() => void maybeLock(false), pollMs);
			unsubscribe = deps.subscribeSystemLock(() => void maybeLock(true));
		},
		stop() {
			if (timer !== null) {
				clearIntervalFn(timer);
				timer = null;
			}
			unsubscribe?.();
			unsubscribe = null;
		},
	};
}
