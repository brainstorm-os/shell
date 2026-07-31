/**
 * P2P-1 — the two things the transport was missing, both measured in the
 * `P2P-0` prototype rather than assumed.
 *
 * 1. **A connect deadline.** A dial to a silent LAN address — what a sleeping
 *    machine looks like, since it sends no RST — took 75,010 ms to fail on the
 *    OS default and 3,003 ms with a 3 s application deadline. `awaitOpen` was
 *    only an observer: it resolved or rejected for its caller and never aborted
 *    the socket or advanced the backoff. Under exclusive LAN-preferred
 *    selection, no deadline means a 75-second sync outage every time the other
 *    machine is asleep.
 *
 * 2. **A heartbeat with a degraded state.** A frozen peer (`SIGSTOP`) was never
 *    noticed by the transport at all; a 5 s heartbeat deadline noticed in
 *    5,047 ms; and the socket was STILL USABLE after the peer woke. So the
 *    correct response to a lapse is to degrade — stop putting frames on the
 *    wire, arm the fallback — not to tear down a connection that recovers.
 *
 * Kept in its own file rather than appended to the 1,300-line
 * `websocket-relay-port.test.ts`: these share a distinct harness (a manual
 * clock plus a manual timer queue) and one concern.
 */

import { describe, expect, it } from "vitest";
import {
	CONTROL_CHANNEL_BYTE,
	WebSocketRelayPort,
	WebSocketRelayState,
	decodeControlMessage,
	decodePingStamp,
	encodeControlMessage,
	isControlMessage,
} from "./websocket-relay-port";

const OPEN_READY_STATE = 1;
const CLOSED_READY_STATE = 3;

class FakeWs {
	readyState = 0;
	sent: Uint8Array[] = [];
	closeCalled = 0;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	constructor(readonly url: string) {}
	send(data: Uint8Array): void {
		this.sent.push(new Uint8Array(data));
	}
	close(): void {
		this.closeCalled += 1;
		this.readyState = CLOSED_READY_STATE;
	}
	open(): void {
		this.readyState = OPEN_READY_STATE;
		this.onopen?.();
	}
	deliver(bytes: Uint8Array): void {
		this.onmessage?.({ data: bytes });
	}
	controls(): Record<string, unknown>[] {
		return this.sent
			.filter((wire) => wire[0] === CONTROL_CHANNEL_BYTE)
			.map(
				(wire) => JSON.parse(new TextDecoder().decode(wire.subarray(1))) as Record<string, unknown>,
			);
	}
}

function fakeCtor(): (new (url: string) => FakeWs) & { instances: FakeWs[] } {
	const instances: FakeWs[] = [];
	const Ctor = class extends FakeWs {
		constructor(url: string) {
			super(url);
			instances.push(this);
		}
	} as unknown as (new (url: string) => FakeWs) & { instances: FakeWs[] };
	Ctor.instances = instances;
	return Ctor;
}

/** Timers keyed by delay so a test can fire exactly the one it means. */
function timerQueue() {
	const pending: { cb: () => void; ms: number; id: number }[] = [];
	let nextId = 1;
	return {
		setTimer(cb: () => void, ms: number): unknown {
			const h = { cb, ms, id: nextId++ };
			pending.push(h);
			return h;
		},
		clearTimer(h: unknown): void {
			const i = pending.indexOf(h as { cb: () => void; ms: number; id: number });
			if (i >= 0) pending.splice(i, 1);
		},
		/** Fire (and remove) the first timer scheduled for exactly `ms`. */
		fireAt(ms: number): boolean {
			const i = pending.findIndex((p) => p.ms === ms);
			if (i < 0) return false;
			const [h] = pending.splice(i, 1);
			h?.cb();
			return true;
		},
		delays(): number[] {
			return pending.map((p) => p.ms);
		},
	};
}

const CONNECT_MS = 3_000;
const HEARTBEAT_MS = 5_000;

function lanPort(opts: { onDegraded?: (d: boolean) => void } = {}) {
	const Ctor = fakeCtor();
	const timers = timerQueue();
	const port = new WebSocketRelayPort({
		url: "ws://192.168.1.10:51820",
		wsImpl: Ctor,
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		random: () => 0.5,
		connectTimeoutMs: CONNECT_MS,
		heartbeatIntervalMs: HEARTBEAT_MS,
		heartbeatTimeoutMs: HEARTBEAT_MS,
		...(opts.onDegraded ? { onDegraded: opts.onDegraded } : {}),
	});
	return { port, Ctor, timers };
}

describe("connect deadline", () => {
	it("is not armed at all when the option is absent (the cloud relay path)", () => {
		const Ctor = fakeCtor();
		const timers = timerQueue();
		const port = new WebSocketRelayPort({
			url: "wss://relay.example",
			wsImpl: Ctor,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		port.connect();
		expect(timers.delays()).not.toContain(CONNECT_MS);
		port.close();
	});

	it("aborts a dial that never opens, and advances to the reconnect schedule", () => {
		const { port, Ctor, timers } = lanPort();
		port.connect();
		expect(port.state).toBe(WebSocketRelayState.Connecting);
		const ws = Ctor.instances[0];
		expect(ws).toBeDefined();

		expect(timers.fireAt(CONNECT_MS)).toBe(true);

		// The socket is CLOSED, not merely observed — this is the difference from
		// `awaitOpen`, which never aborted anything.
		expect(ws?.closeCalled).toBe(1);
		expect(port.state).toBe(WebSocketRelayState.Reconnecting);
		port.close();
	});

	it("is cleared when the socket opens, so a healthy link is never torn down", () => {
		const { port, Ctor, timers } = lanPort();
		port.connect();
		Ctor.instances[0]?.open();
		expect(port.state).toBe(WebSocketRelayState.Open);
		expect(timers.delays()).not.toContain(CONNECT_MS);
		port.close();
	});

	it("ignores a stale deadline that fires after a later socket opened", () => {
		const { port, Ctor, timers } = lanPort();
		port.connect();
		const first = Ctor.instances[0];
		Ctor.instances[0]?.open();
		// Re-arm by hand: a deadline captured for the previous handle must not
		// close the live one.
		timers.setTimer(() => undefined, CONNECT_MS);
		expect(port.state).toBe(WebSocketRelayState.Open);
		expect(first?.closeCalled).toBe(0);
		port.close();
	});

	it("re-arms on the reconnect attempt", () => {
		const { port, Ctor, timers } = lanPort();
		port.connect();
		timers.fireAt(CONNECT_MS);
		// Backoff: 500ms base with 0.5 random ⇒ no jitter offset.
		expect(timers.fireAt(500)).toBe(true);
		expect(Ctor.instances).toHaveLength(2);
		expect(timers.delays()).toContain(CONNECT_MS);
		port.close();
	});
});

describe("heartbeat", () => {
	it("pings on an open ungated transport", () => {
		const { port, Ctor, timers } = lanPort();
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		expect(timers.fireAt(HEARTBEAT_MS)).toBe(true);
		expect(ws?.controls().some((c) => c.op === "ping")).toBe(true);
		port.close();
	});

	it("degrades — never closes — when a ping goes unanswered", () => {
		const degraded: boolean[] = [];
		const { port, Ctor, timers } = lanPort({ onDegraded: (d) => degraded.push(d) });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		timers.fireAt(HEARTBEAT_MS); // send the ping + arm the answer deadline
		timers.fireAt(HEARTBEAT_MS); // the answer deadline lapses

		expect(port.state).toBe(WebSocketRelayState.Degraded);
		expect(degraded).toEqual([true]);
		// The measurement that drives this: the socket was still usable after the
		// peer woke, so tearing it down here would destroy a link that recovers.
		expect(ws?.closeCalled).toBe(0);
		port.close();
	});

	it("queues frames while degraded and flushes them when the peer answers", () => {
		const { port, Ctor, timers } = lanPort();
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		timers.fireAt(HEARTBEAT_MS);
		timers.fireAt(HEARTBEAT_MS);
		expect(port.state).toBe(WebSocketRelayState.Degraded);

		const before = ws?.sent.length ?? 0;
		port.send(new Uint8Array([9, 9, 9]));
		expect(ws?.sent.length).toBe(before);

		ws?.deliver(encodeControlMessage({ op: "pong", t: 1 }));
		expect(port.state).toBe(WebSocketRelayState.Open);
		expect(ws?.sent.length ?? 0).toBeGreaterThan(before);
		port.close();
	});

	it("recovering re-notifies the consumer so the fallback disarms", () => {
		const degraded: boolean[] = [];
		const { port, Ctor, timers } = lanPort({ onDegraded: (d) => degraded.push(d) });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		timers.fireAt(HEARTBEAT_MS);
		timers.fireAt(HEARTBEAT_MS);
		ws?.deliver(encodeControlMessage({ op: "pong", t: 1 }));
		expect(degraded).toEqual([true, false]);
		port.close();
	});

	it("answers a peer's ping with the same stamp, so either end can notice", () => {
		const { port, Ctor } = lanPort();
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		ws?.deliver(encodeControlMessage({ op: "ping", t: 4242 }));
		expect(ws?.controls()).toContainEqual({ op: "pong", t: 4242 });
		port.close();
	});

	it("holds the heartbeat until admission on a gated transport", () => {
		const Ctor = fakeCtor();
		const timers = timerQueue();
		const port = new WebSocketRelayPort({
			url: "ws://192.168.1.10:51820",
			wsImpl: Ctor,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			connectTimeoutMs: CONNECT_MS,
			heartbeatIntervalMs: HEARTBEAT_MS,
			requireAdmission: true,
			lanHandshake: {
				helloAccount: () => "acct",
				onSealedChallenge: () => null,
				verifyHostProof: () => true,
			},
		});
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		// Pre-admission the peer has proven nothing: it gets `hello` and nothing
		// else, keepalive included.
		expect(timers.delays()).not.toContain(HEARTBEAT_MS);
		expect(ws?.controls().map((c) => c.op)).toEqual(["hello"]);

		ws?.deliver(encodeControlMessage({ op: "auth-ok", proof: "p" } as never));
		expect(timers.delays()).toContain(HEARTBEAT_MS);
		port.close();
	});

	it("stops every timer on close, so a disposed port leaves nothing pending", () => {
		const { port, Ctor, timers } = lanPort();
		port.connect();
		Ctor.instances[0]?.open();
		timers.fireAt(HEARTBEAT_MS);
		port.close();
		expect(timers.delays()).toEqual([]);
	});

	it("stops the heartbeat when the socket drops", () => {
		const { port, Ctor, timers } = lanPort();
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		timers.fireAt(HEARTBEAT_MS);
		if (ws) ws.readyState = CLOSED_READY_STATE;
		ws?.onclose?.();
		expect(timers.delays()).not.toContain(HEARTBEAT_MS);
		port.close();
	});
});

describe("ping / pong wire shape", () => {
	it("round-trips through the shared control codec", () => {
		const wire = encodeControlMessage({ op: "ping", t: 17 });
		expect(decodeControlMessage(wire)).toEqual({ op: "ping", t: 17 });
		expect(isControlMessage({ op: "pong", t: 0 })).toBe(true);
	});

	it("rejects a keepalive with a non-finite stamp", () => {
		expect(isControlMessage({ op: "ping", t: "soon" })).toBe(false);
		expect(isControlMessage({ op: "pong" })).toBe(false);
	});

	it("decodePingStamp reads only a real ping", () => {
		expect(decodePingStamp(encodeControlMessage({ op: "ping", t: 5 }))).toBe(5);
		expect(decodePingStamp(encodeControlMessage({ op: "pong", t: 5 }))).toBeNull();
		expect(decodePingStamp(encodeControlMessage({ op: "subscribe", entityIds: ["e"] }))).toBeNull();
		expect(decodePingStamp(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(decodePingStamp(new Uint8Array([CONTROL_CHANNEL_BYTE, 0x7b]))).toBeNull();
	});
});
