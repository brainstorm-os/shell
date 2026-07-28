/**
 * The start/stop loop. The reentrancy and bind-failure cases are the reason this
 * is a class rather than four lines in `index.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { LanHostController, type LanListenerLike } from "./lan-host-controller";
import { LanHostMode, type LanHostState } from "./lan-host-policy";

const on = (over: Partial<LanHostState> = {}): LanHostState => ({
	mode: LanHostMode.WhenVaultOpen,
	hasSession: true,
	hasSharedEntities: false,
	...over,
});

function fakeListener(over: Partial<LanListenerLike> = {}) {
	const started: string[] = [];
	const listener: LanListenerLike & { started: string[]; stops: number } = {
		started,
		stops: 0,
		start: async () => {
			started.push("start");
			return { url: "ws://192.168.1.9:51234" };
		},
		stop: async () => {
			listener.stops += 1;
		},
		...over,
	};
	return listener;
}

describe("LanHostController", () => {
	it("stays off when the policy says off, and never builds a listener", () => {
		const createListener = vi.fn(() => fakeListener());
		const c = new LanHostController({
			readState: () => on({ mode: LanHostMode.Off }),
			createListener,
		});
		return c.apply().then(() => {
			expect(createListener).not.toHaveBeenCalled();
			expect(c.listening).toBe(false);
			expect(c.url).toBeNull();
		});
	});

	it("starts when the policy says listen, and publishes the URL", async () => {
		const urls: (string | null)[] = [];
		const c = new LanHostController({
			readState: () => on(),
			createListener: () => fakeListener(),
			onUrlChanged: (u) => urls.push(u),
		});
		await c.apply();
		expect(c.listening).toBe(true);
		expect(c.url).toBe("ws://192.168.1.9:51234");
		expect(urls).toEqual(["ws://192.168.1.9:51234"]);
	});

	it("is idempotent — a second apply with unchanged policy does not rebind", async () => {
		const createListener = vi.fn(() => fakeListener());
		const c = new LanHostController({ readState: () => on(), createListener });
		await c.apply();
		await c.apply();
		expect(createListener).toHaveBeenCalledTimes(1);
	});

	it("stops when the policy flips off, and clears the URL", async () => {
		let state = on();
		const listener = fakeListener();
		const urls: (string | null)[] = [];
		const c = new LanHostController({
			readState: () => state,
			createListener: () => listener,
			onUrlChanged: (u) => urls.push(u),
		});
		await c.apply();
		state = on({ mode: LanHostMode.Off });
		await c.apply();
		expect(c.listening).toBe(false);
		expect(c.url).toBeNull();
		expect(listener.stops).toBe(1);
		expect(urls).toEqual(["ws://192.168.1.9:51234", null]);
	});

	it("serialises overlapping applies — exactly ONE listener binds", async () => {
		// The real race: a vault opening as the user flips the toggle. Without
		// serialisation two sockets bind and only one is tracked, so the other
		// leaks for the life of the process.
		const createListener = vi.fn(() => fakeListener());
		const c = new LanHostController({ readState: () => on(), createListener });
		await Promise.all([c.apply(), c.apply(), c.apply()]);
		expect(createListener).toHaveBeenCalledTimes(1);
		expect(c.listening).toBe(true);
	});

	it("survives a bind failure with LAN off and the app alive", async () => {
		// A busy port or a vanished interface must not take down the main process.
		const errors: unknown[] = [];
		const listener = fakeListener({
			start: async () => {
				throw new Error("EADDRINUSE");
			},
		});
		const c = new LanHostController({
			readState: () => on(),
			createListener: () => listener,
			onError: (e) => errors.push(e),
		});
		await expect(c.apply()).resolves.toBeUndefined();
		expect(c.listening).toBe(false);
		expect(c.url).toBeNull();
		expect(errors).toHaveLength(1);
		// The half-built listener is torn down rather than left dangling.
		expect(listener.stops).toBe(1);
	});

	it("retries on the next apply after a bind failure", async () => {
		let fail = true;
		const c = new LanHostController({
			readState: () => on(),
			createListener: () =>
				fakeListener(
					fail
						? {
								start: async () => {
									throw new Error("EADDRINUSE");
								},
							}
						: {},
				),
			onError: () => undefined,
		});
		await c.apply();
		expect(c.listening).toBe(false);
		fail = false;
		await c.apply();
		expect(c.listening).toBe(true);
	});

	it("never binds at all when dispose lands BEFORE the reconcile runs", async () => {
		// `apply()` only queues the work; `dispose()` sets the flag synchronously.
		// So the reconcile sees `disposed` first and declines to build anything —
		// better than binding and immediately tearing down.
		const createListener = vi.fn(() => fakeListener());
		const c = new LanHostController({ readState: () => on(), createListener });
		const applying = c.apply();
		const disposing = c.dispose();
		await Promise.all([applying, disposing]);
		expect(createListener).not.toHaveBeenCalled();
		expect(c.listening).toBe(false);
	});

	it("does not leave a socket bound when dispose lands MID-BIND", async () => {
		// The genuine race: the reconcile has already entered `start()` and is
		// awaiting the bind when dispose arrives. We own the listener by then, so
		// it must be stopped rather than tracked — otherwise it leaks bound for the
		// life of the process.
		// Initialised to no-ops: assigning only inside the executor narrows the
		// binding to `never` and tsc then rejects the call.
		let release: () => void = () => undefined;
		const bindGate = new Promise<void>((r) => {
			release = r;
		});
		let entered: () => void = () => undefined;
		const startEntered = new Promise<void>((r) => {
			entered = r;
		});
		const listener = fakeListener({
			start: async () => {
				entered();
				await bindGate;
				return { url: "ws://192.168.1.9:51234" };
			},
		});
		const c = new LanHostController({ readState: () => on(), createListener: () => listener });
		const applying = c.apply();
		await startEntered; // the socket is now mid-bind
		const disposing = c.dispose();
		release();
		await Promise.all([applying, disposing]);
		expect(c.listening).toBe(false);
		expect(c.url).toBeNull();
		expect(listener.stops).toBeGreaterThanOrEqual(1);
	});

	it("dispose is safe when never started", async () => {
		const c = new LanHostController({
			readState: () => on({ mode: LanHostMode.Off }),
			createListener: () => fakeListener(),
		});
		await expect(c.dispose()).resolves.toBeUndefined();
	});

	it("stays off once disposed, even if apply is called again", async () => {
		const createListener = vi.fn(() => fakeListener());
		const c = new LanHostController({ readState: () => on(), createListener });
		await c.dispose();
		await c.apply();
		expect(c.listening).toBe(false);
	});

	it("stays off when no listener can be built (no session, no interface)", async () => {
		const c = new LanHostController({ readState: () => on(), createListener: () => null });
		await c.apply();
		expect(c.listening).toBe(false);
		expect(c.url).toBeNull();
	});
});
