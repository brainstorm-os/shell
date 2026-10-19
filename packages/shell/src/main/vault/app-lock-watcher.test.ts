import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AppLockWatcherDeps,
	createAppLockWatcher,
	createBackgroundedClock,
	shouldAutoLockOnIdle,
} from "./app-lock-watcher";

describe("shouldAutoLockOnIdle", () => {
	it("is false when auto-lock is off (0 minutes)", () => {
		expect(shouldAutoLockOnIdle(99999, 0)).toBe(false);
	});
	it("is false until the idle threshold is reached", () => {
		expect(shouldAutoLockOnIdle(299, 5)).toBe(false); // 4m59s < 5m
		expect(shouldAutoLockOnIdle(300, 5)).toBe(true); // exactly 5m
		expect(shouldAutoLockOnIdle(301, 5)).toBe(true);
	});
});

describe("createAppLockWatcher", () => {
	let tick: (() => void) | null;
	let systemHandler: (() => void) | null;
	let cleared: boolean;
	let lock: Mock<() => void>;
	let deps: AppLockWatcherDeps;
	// Mutable knobs the fakes read.
	let idle: number;
	let appIdle: number;
	let minutes: number;
	let pin: boolean;
	let locked: boolean;

	beforeEach(() => {
		tick = null;
		systemHandler = null;
		cleared = false;
		lock = vi.fn<() => void>();
		idle = 1000;
		appIdle = 1000;
		minutes = 5;
		pin = true;
		locked = false;
		deps = {
			getIdleSeconds: () => idle,
			getAppIdleSeconds: () => appIdle,
			getAutoLockMinutes: () => Promise.resolve(minutes),
			hasPin: () => Promise.resolve(pin),
			isLocked: () => locked,
			lock: () => lock(),
			subscribeSystemLock: (handler) => {
				systemHandler = handler;
				return () => {
					systemHandler = null;
				};
			},
			pollMs: 1000,
			setInterval: (fn) => {
				tick = fn;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: () => {
				cleared = true;
			},
		};
	});

	afterEach(() => vi.restoreAllMocks());

	const flush = () => new Promise((r) => setTimeout(r, 0));

	it("locks when idle past the threshold with a PIN set", async () => {
		const w = createAppLockWatcher(deps);
		w.start();
		tick?.();
		await flush();
		expect(lock).toHaveBeenCalledTimes(1);
	});

	it("does not lock before the idle threshold", async () => {
		idle = 100; // < 5m
		const w = createAppLockWatcher(deps);
		w.start();
		tick?.();
		await flush();
		expect(lock).not.toHaveBeenCalled();
	});

	it("does not lock when the system is idle but the app is active", async () => {
		idle = 1000; // OS idle past the threshold (no keyboard/mouse)
		appIdle = 30; // but foreground app activity 30s ago
		const w = createAppLockWatcher(deps);
		w.start();
		tick?.();
		await flush();
		expect(lock).not.toHaveBeenCalled();
	});

	it("locks once both the system and the app are idle past the threshold", async () => {
		idle = 1000;
		appIdle = 1000;
		const w = createAppLockWatcher(deps);
		w.start();
		tick?.();
		await flush();
		expect(lock).toHaveBeenCalledTimes(1);
	});

	it("uses the smaller of system and app idle — recent OS input also defers", async () => {
		idle = 10; // keyboard/mouse 10s ago
		appIdle = 1000; // app quiet, but OS input is recent
		const w = createAppLockWatcher(deps);
		w.start();
		tick?.();
		await flush();
		expect(lock).not.toHaveBeenCalled();
	});

	it("locks a vault backgrounded past the timeout even while the user types elsewhere", async () => {
		idle = 2; // active in other apps
		appIdle = 2;
		let backgrounded = 0;
		const w = createAppLockWatcher({ ...deps, getBackgroundedSeconds: () => backgrounded });
		w.start();
		tick?.();
		await flush();
		expect(lock).not.toHaveBeenCalled();
		backgrounded = 5 * 60;
		tick?.();
		await flush();
		expect(lock).toHaveBeenCalledTimes(1);
	});

	it("a backgrounded vault still honours auto-lock-off and the no-PIN rule", async () => {
		idle = 0;
		const w = createAppLockWatcher({ ...deps, getBackgroundedSeconds: () => 99_999 });
		minutes = 0;
		w.start();
		tick?.();
		await flush();
		minutes = 5;
		pin = false;
		tick?.();
		await flush();
		expect(lock).not.toHaveBeenCalled();
	});

	it("the backgrounded clock starts when the last window hides and resets when one shows", () => {
		let visible = true;
		let t = 1_000;
		const clock = createBackgroundedClock(
			() => visible,
			() => t,
		);
		expect(clock()).toBe(0);
		visible = false;
		expect(clock()).toBe(0);
		t += 90_000;
		expect(clock()).toBe(90);
		visible = true;
		expect(clock()).toBe(0);
		visible = false;
		t += 5_000;
		expect(clock()).toBe(0);
	});

	it("a system signal locks immediately even while the app is active", async () => {
		idle = 0;
		appIdle = 0; // actively using the app
		const w = createAppLockWatcher(deps);
		w.start();
		systemHandler?.();
		await flush();
		expect(lock).toHaveBeenCalledTimes(1);
	});

	it("does not lock when auto-lock is off", async () => {
		minutes = 0;
		const w = createAppLockWatcher(deps);
		w.start();
		tick?.();
		await flush();
		expect(lock).not.toHaveBeenCalled();
	});

	it("does not lock when no PIN is set", async () => {
		pin = false;
		const w = createAppLockWatcher(deps);
		w.start();
		tick?.();
		await flush();
		expect(lock).not.toHaveBeenCalled();
	});

	it("does not lock when already locked", async () => {
		locked = true;
		const w = createAppLockWatcher(deps);
		w.start();
		tick?.();
		await flush();
		expect(lock).not.toHaveBeenCalled();
	});

	it("locks immediately on a system signal regardless of idle time", async () => {
		idle = 0; // not idle at all
		const w = createAppLockWatcher(deps);
		w.start();
		systemHandler?.();
		await flush();
		expect(lock).toHaveBeenCalledTimes(1);
	});

	it("a system signal still respects auto-lock-off", async () => {
		idle = 0;
		minutes = 0;
		const w = createAppLockWatcher(deps);
		w.start();
		systemHandler?.();
		await flush();
		expect(lock).not.toHaveBeenCalled();
	});

	it("stop() clears the interval and unsubscribes", () => {
		const w = createAppLockWatcher(deps);
		w.start();
		expect(systemHandler).not.toBeNull();
		w.stop();
		expect(cleared).toBe(true);
		expect(systemHandler).toBeNull();
	});
});
