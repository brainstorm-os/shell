/**
 * Stage 10.4 — unit tests for the WebSocket-backed RelayPort adapter.
 *
 * The relay-blind invariant is enforced structurally by the
 * `tools/mcp-server/src/tools/relay-noble-import-check.ts` audit (extended
 * in 10.4 to also cover `packages/relay-server/src/**`); these tests focus
 * on the port's observable behaviour: state machine, send-queue
 * back-pressure, control-message round-trip, reconnect scheduling,
 * subscription re-emission, malformed-input handling, and disposal
 * idempotency. The WebSocket itself is faked end-to-end via a deterministic
 * `FakeWebSocket` so each test can drive open / message / close / error
 * events synchronously.
 */

import { describe, expect, it } from "vitest";
import {
	BUNDLE_CHANNEL_BYTE,
	CONTROL_CHANNEL_BYTE,
	FRAME_CHANNEL_BYTE,
	WebSocketRelayPort,
	WebSocketRelayState,
	decodeBundlePayload,
	decodeCatalogResult,
	decodeControlMessage,
	encodeBundlePayload,
	encodeControlMessage,
	isControlMessage,
	unwrapBinaryFrame,
	wrapBinaryFrame,
} from "./websocket-relay-port";

const OPEN_READY_STATE = 1;
const CLOSED_READY_STATE = 3;

class FakeWebSocketInstance {
	readonly url: string;
	readyState = 0; // CONNECTING
	sent: Uint8Array[] = [];
	closeCalled = 0;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	throwOnSend = false;
	// Captures the production setter ("arraybuffer" — 10.9d step 2 — closes the
	// Blob-inbound-drop race) so tests can assert the WS was put into binary-
	// arraybuffer mode before the open event arrived.
	binaryType: string | undefined = undefined;

	constructor(url: string) {
		this.url = url;
	}

	send(data: Uint8Array): void {
		if (this.throwOnSend) throw new Error("send failed");
		this.sent.push(new Uint8Array(data));
	}

	close(): void {
		this.closeCalled += 1;
		this.readyState = CLOSED_READY_STATE;
	}

	// Test helpers — call from the spec to drive transitions.
	open(): void {
		this.readyState = OPEN_READY_STATE;
		this.onopen?.();
	}

	deliver(bytes: Uint8Array): void {
		this.onmessage?.({ data: bytes });
	}

	dropClose(): void {
		this.readyState = CLOSED_READY_STATE;
		this.onclose?.();
	}

	errorOut(err: unknown): void {
		this.onerror?.(err);
	}
}

type FakeWsCtor = (new (
	url: string,
) => FakeWebSocketInstance) & { instances: FakeWebSocketInstance[] };

function makeFakeWsCtor(): FakeWsCtor {
	const instances: FakeWebSocketInstance[] = [];
	const Ctor = class extends FakeWebSocketInstance {
		constructor(url: string) {
			super(url);
			instances.push(this);
		}
	} as unknown as FakeWsCtor;
	Ctor.instances = instances;
	return Ctor;
}

function deterministicRandom(seq: number[]): () => number {
	let i = 0;
	return () => {
		const v = seq[i % seq.length] ?? 0.5;
		i += 1;
		return v;
	};
}

function manualTimer(): {
	setTimer: (cb: () => void, ms: number) => unknown;
	clearTimer: (h: unknown) => void;
	fire: () => boolean;
	scheduled: () => Array<{ cb: () => void; ms: number }>;
} {
	const pending: Array<{ cb: () => void; ms: number; id: number }> = [];
	let nextId = 1;
	return {
		setTimer(cb, ms) {
			const handle = { cb, ms, id: nextId };
			nextId += 1;
			pending.push(handle);
			return handle;
		},
		clearTimer(h) {
			const idx = pending.findIndex((p) => p === h);
			if (idx >= 0) pending.splice(idx, 1);
		},
		fire() {
			const next = pending.shift();
			if (!next) return false;
			next.cb();
			return true;
		},
		scheduled() {
			return pending.map(({ cb, ms }) => ({ cb, ms }));
		},
	};
}

describe("wrapBinaryFrame / unwrapBinaryFrame", () => {
	it("round-trips the frame body intact with FRAME_CHANNEL_BYTE prefix", () => {
		const body = new Uint8Array([1, 2, 3, 4]);
		const wire = wrapBinaryFrame(body);
		expect(wire[0]).toBe(FRAME_CHANNEL_BYTE);
		const unwrapped = unwrapBinaryFrame(wire);
		expect(unwrapped).toEqual(body);
	});

	it("unwrapBinaryFrame returns null on a control-channel byte", () => {
		const wire = new Uint8Array([CONTROL_CHANNEL_BYTE, 0x7b, 0x7d]);
		expect(unwrapBinaryFrame(wire)).toBeNull();
	});
});

describe("encodeControlMessage / decodeControlMessage / isControlMessage", () => {
	it("round-trips a subscribe message", () => {
		const wire = encodeControlMessage({ op: "subscribe", entityIds: ["e1", "e2"] });
		expect(wire[0]).toBe(CONTROL_CHANNEL_BYTE);
		expect(decodeControlMessage(wire)).toEqual({ op: "subscribe", entityIds: ["e1", "e2"] });
	});

	it("rejects malformed JSON", () => {
		const wire = new Uint8Array([CONTROL_CHANNEL_BYTE, 0x7b, 0x7b]);
		expect(decodeControlMessage(wire)).toBeNull();
	});

	it("rejects unknown op", () => {
		expect(isControlMessage({ op: "wat", entityIds: ["x"] })).toBe(false);
	});

	it("rejects empty entityId strings", () => {
		expect(isControlMessage({ op: "subscribe", entityIds: [""] })).toBe(false);
	});

	it("rejects non-array entityIds", () => {
		expect(isControlMessage({ op: "subscribe", entityIds: "e1" })).toBe(false);
	});

	it("round-trips a bundle-advertising subscribe; rejects a non-true bundle flag (10.10)", () => {
		const wire = encodeControlMessage({ op: "subscribe", entityIds: ["e1"], bundle: true });
		expect(decodeControlMessage(wire)).toEqual({ op: "subscribe", entityIds: ["e1"], bundle: true });
		expect(isControlMessage({ op: "subscribe", entityIds: ["e1"], bundle: true })).toBe(true);
		expect(isControlMessage({ op: "subscribe", entityIds: ["e1"], bundle: "yes" })).toBe(false);
		expect(isControlMessage({ op: "subscribe", entityIds: ["e1"], bundle: false })).toBe(false);
	});

	it("encodes + validates a catalog query (10.14)", () => {
		const wire = encodeControlMessage({ op: "catalog", account: "acc-b64url" });
		expect(wire[0]).toBe(CONTROL_CHANNEL_BYTE);
		expect(decodeControlMessage(wire)).toEqual({ op: "catalog", account: "acc-b64url" });
		expect(isControlMessage({ op: "catalog", account: "x" })).toBe(true);
		expect(isControlMessage({ op: "catalog", account: "" })).toBe(false);
	});
});

describe("decodeCatalogResult (10.14)", () => {
	const wire = (obj: unknown): Uint8Array => {
		const body = new TextEncoder().encode(JSON.stringify(obj));
		const out = new Uint8Array(1 + body.length);
		out[0] = CONTROL_CHANNEL_BYTE;
		out.set(body, 1);
		return out;
	};

	it("round-trips a catalog-result", () => {
		const entities = [
			{ entityId: "e1", version: 3 },
			{ entityId: "e2", version: 0 },
		];
		expect(decodeCatalogResult(wire({ op: "catalog-result", account: "a", entities }))).toEqual({
			op: "catalog-result",
			account: "a",
			entities,
		});
	});

	it("returns null for a non-catalog-result control message", () => {
		expect(decodeCatalogResult(wire({ op: "subscribe", entityIds: ["e1"] }))).toBeNull();
	});

	it("returns null for malformed entries", () => {
		expect(
			decodeCatalogResult(wire({ op: "catalog-result", account: "a", entities: [{ entityId: 1 }] })),
		).toBeNull();
	});
});

describe("WebSocketRelayPort — requestCatalog (10.14)", () => {
	it("rejects when the relay is not open", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		await expect(port.requestCatalog("acc")).rejects.toThrow(/not open/);
		port.close();
	});

	it("sends a catalog query and resolves on the catalog-result reply", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		const pending = port.requestCatalog("acc");
		// The query went out on the control channel.
		const lastSent = ws?.sent.at(-1);
		expect(lastSent?.[0]).toBe(CONTROL_CHANNEL_BYTE);
		expect(decodeControlMessage(lastSent as Uint8Array)).toEqual({ op: "catalog", account: "acc" });
		// The node replies.
		const entities = [{ entityId: "e1", version: 2 }];
		const body = new TextEncoder().encode(
			JSON.stringify({ op: "catalog-result", account: "acc", entities }),
		);
		const reply = new Uint8Array(1 + body.length);
		reply[0] = CONTROL_CHANNEL_BYTE;
		reply.set(body, 1);
		ws?.deliver(reply);
		await expect(pending).resolves.toEqual(entities);
		port.close();
	});

	it("rejects on timeout when no reply arrives", async () => {
		const Ctor = makeFakeWsCtor();
		const timer = manualTimer();
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: Ctor,
			setTimer: timer.setTimer,
			clearTimer: timer.clearTimer,
			catalogTimeoutMs: 5_000,
		});
		port.connect();
		Ctor.instances[0]?.open();
		const pending = port.requestCatalog("acc");
		const rejected = expect(pending).rejects.toThrow(/no reply/);
		expect(timer.fire()).toBe(true); // fire the catalog timeout
		await rejected;
		port.close();
	});

	it("rejects in-flight catalog requests when the port closes", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		Ctor.instances[0]?.open();
		const pending = port.requestCatalog("acc");
		port.close();
		await expect(pending).rejects.toThrow(/closed/);
	});
});

describe("WebSocketRelayPort — requestAsset (Asset-B4 blob plane)", () => {
	const ASSET_BYTE = 0x02;
	const assetReply = (body: Uint8Array): Uint8Array => {
		const r = new Uint8Array(1 + body.length);
		r[0] = ASSET_BYTE;
		r.set(body, 1);
		return r;
	};

	it("rejects when the relay is not open", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		await expect(port.requestAsset(new Uint8Array([1]))).rejects.toThrow(/not open/);
		port.close();
	});

	it("sends an asset request on channel 0x02 and resolves on the asset reply", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		const pending = port.requestAsset(new Uint8Array([9, 8, 7]));
		const lastSent = ws?.sent.at(-1);
		expect(lastSent?.[0]).toBe(ASSET_BYTE);
		expect(lastSent?.subarray(1)).toEqual(new Uint8Array([9, 8, 7]));
		ws?.deliver(assetReply(new Uint8Array([4, 5, 6])));
		await expect(pending).resolves.toEqual(new Uint8Array([4, 5, 6]));
		port.close();
	});

	it("serializes concurrent requests — one in flight, FIFO correlation", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		const sentCount = () => (ws?.sent ?? []).filter((m) => m[0] === ASSET_BYTE).length;

		const first = port.requestAsset(new Uint8Array([1]));
		const second = port.requestAsset(new Uint8Array([2]));
		// Only the first request is on the wire — the second waits.
		expect(sentCount()).toBe(1);

		ws?.deliver(assetReply(new Uint8Array([0x11])));
		await expect(first).resolves.toEqual(new Uint8Array([0x11]));
		await Promise.resolve(); // let the chain advance to the second send
		expect(sentCount()).toBe(2);
		expect(ws?.sent.at(-1)?.subarray(1)).toEqual(new Uint8Array([2]));

		ws?.deliver(assetReply(new Uint8Array([0x22])));
		await expect(second).resolves.toEqual(new Uint8Array([0x22]));
		port.close();
	});

	it("rejects on timeout when no asset reply arrives", async () => {
		const Ctor = makeFakeWsCtor();
		const timer = manualTimer();
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: Ctor,
			setTimer: timer.setTimer,
			clearTimer: timer.clearTimer,
			assetTimeoutMs: 5_000,
		});
		port.connect();
		Ctor.instances[0]?.open();
		const pending = port.requestAsset(new Uint8Array([1]));
		const rejected = expect(pending).rejects.toThrow(/no reply/);
		expect(timer.fire()).toBe(true);
		await rejected;
		port.close();
	});

	it("rejects an in-flight asset request when the port closes", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		Ctor.instances[0]?.open();
		const pending = port.requestAsset(new Uint8Array([1]));
		port.close();
		await expect(pending).rejects.toThrow(/closed/);
	});
});

describe("WebSocketRelayPort — lifecycle", () => {
	it("transitions Idle → Connecting → Open and emits state events", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		const states: WebSocketRelayState[] = [];
		port.on("state", (s) => states.push(s));
		expect(port.state).toBe(WebSocketRelayState.Idle);
		port.connect();
		expect(port.state).toBe(WebSocketRelayState.Connecting);
		const ws = Ctor.instances[0];
		expect(ws).toBeDefined();
		ws?.open();
		expect(port.state).toBe(WebSocketRelayState.Open);
		expect(states).toEqual([WebSocketRelayState.Connecting, WebSocketRelayState.Open]);
		port.close();
	});

	it("connect is idempotent while Open / Connecting / Reconnecting", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		port.connect();
		port.connect();
		expect(Ctor.instances.length).toBe(1);
		port.close();
	});

	it("close is idempotent", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		Ctor.instances[0]?.open();
		port.close();
		port.close();
		expect(port.state).toBe(WebSocketRelayState.Closed);
		expect(Ctor.instances[0]?.closeCalled).toBe(1);
	});

	it("throws if no WebSocket impl is provided and global has none", () => {
		const realWs = (globalThis as { WebSocket?: unknown }).WebSocket;
		try {
			(globalThis as { WebSocket?: unknown }).WebSocket = undefined;
			expect(() => new WebSocketRelayPort({ url: "ws://x" })).toThrow(/no WebSocket implementation/);
		} finally {
			(globalThis as { WebSocket?: unknown }).WebSocket = realWs;
		}
	});

	it("awaitOpen resolves immediately when already Open", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		Ctor.instances[0]?.open();
		await expect(port.awaitOpen(100)).resolves.toBeUndefined();
		port.close();
	});

	it("awaitOpen resolves when transition Connecting → Open fires", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const waiter = port.awaitOpen(1_000);
		Ctor.instances[0]?.open();
		await expect(waiter).resolves.toBeUndefined();
		port.close();
	});

	it("awaitOpen rejects on timeout when WS never opens", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		await expect(port.awaitOpen(20)).rejects.toThrow(/not open within 20ms/);
		port.close();
	});

	it("awaitOpen rejects if the port closes before opening", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const waiter = port.awaitOpen(1_000);
		port.close();
		await expect(waiter).rejects.toThrow(/closed before opening|already closed/);
	});

	it("awaitOpen rejects on a port that was already closed", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.close();
		await expect(port.awaitOpen(20)).rejects.toThrow(/already closed/);
	});

	it("sets binaryType='arraybuffer' on the WS so inbound binary frames decode (10.9d step 2)", () => {
		// Bug pinned: without this setter, the WHATWG WebSocket defaults to
		// blob, the inbound dispatcher's `toUint8Array(event.data)` returns
		// null, every received frame silently increments droppedInbound, and
		// pairing (10.5c) + sync (10.x) handshakes time out.
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		expect(ws?.binaryType).toBe("arraybuffer");
		port.close();
	});
});

describe("WebSocketRelayPort — send-queue", () => {
	it("buffers frames sent before Open and flushes on open", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		port.send(new Uint8Array([1, 2, 3]));
		const ws = Ctor.instances[0];
		expect(ws?.sent.length).toBe(0);
		ws?.open();
		expect(ws?.sent.length).toBe(1);
		const sent = ws?.sent[0];
		expect(sent?.[0]).toBe(FRAME_CHANNEL_BYTE);
		expect(sent?.subarray(1)).toEqual(new Uint8Array([1, 2, 3]));
		port.close();
	});

	it("send while Open writes directly through", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		Ctor.instances[0]?.open();
		port.send(new Uint8Array([9, 9, 9]));
		expect(Ctor.instances[0]?.sent.length).toBe(1);
		port.close();
	});

	it("send while Closed throws", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.close();
		expect(() => port.send(new Uint8Array([1]))).toThrow(/closed/);
	});

	it("drop-oldest at queue cap + droppedSends counter", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		// Queue 260 frames (cap is 256) — 4 should be dropped.
		for (let i = 0; i < 260; i++) {
			const buf = new Uint8Array(2);
			buf[0] = (i >> 8) & 0xff;
			buf[1] = i & 0xff;
			port.send(buf);
		}
		expect(port.droppedSends()).toBe(4);
		const ws = Ctor.instances[0];
		ws?.open();
		// 256 frames flushed; first-out was the 5th oldest, encoding i=4.
		expect(ws?.sent.length).toBe(256);
		const firstFlushed = ws?.sent[0];
		// firstFlushed[0] is FRAME_CHANNEL_BYTE, [1..2] is the i=4 encoding.
		expect(firstFlushed?.subarray(1)).toEqual(new Uint8Array([0, 4]));
		port.close();
	});

	it("send falls back to queue when ws.send throws", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		if (ws) ws.throwOnSend = true;
		port.send(new Uint8Array([1, 2]));
		expect(ws?.sent.length).toBe(0);
		// Buffer is held; flip throw off and trigger flush by re-opening.
		if (ws) ws.throwOnSend = false;
		// Drop the socket; on reconnect schedule + new open, queue flushes.
		port.close();
	});
});

describe("WebSocketRelayPort — inbound fan-in", () => {
	it("onFrame fires for inbound binary frames; strips the channel byte", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		const received: Uint8Array[] = [];
		port.onFrame((b) => received.push(b));
		const body = new Uint8Array([10, 20, 30]);
		ws?.deliver(wrapBinaryFrame(body));
		expect(received.length).toBe(1);
		expect(received[0]).toEqual(body);
		port.close();
	});

	it("offFrame removes a specific listener; sibling still fires", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		const a: Uint8Array[] = [];
		const b: Uint8Array[] = [];
		const cbA = (frame: Uint8Array): void => {
			a.push(frame);
		};
		const cbB = (frame: Uint8Array): void => {
			b.push(frame);
		};
		port.onFrame(cbA);
		port.onFrame(cbB);
		port.offFrame(cbA);
		ws?.deliver(wrapBinaryFrame(new Uint8Array([1])));
		expect(a.length).toBe(0);
		expect(b.length).toBe(1);
		port.close();
	});

	it("throwing listener does not block sibling fan-out", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		const received: Uint8Array[] = [];
		port.onFrame(() => {
			throw new Error("boom");
		});
		port.onFrame((b) => received.push(b));
		ws?.deliver(wrapBinaryFrame(new Uint8Array([1])));
		expect(received.length).toBe(1);
		port.close();
	});

	it("drops malformed inbound (empty / unknown channel byte) and bumps counter", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		const received: Uint8Array[] = [];
		port.onFrame((b) => received.push(b));
		ws?.deliver(new Uint8Array(0)); // empty
		ws?.deliver(new Uint8Array([0xff, 1, 2, 3])); // unknown channel
		expect(received.length).toBe(0);
		expect(port.droppedInbound()).toBe(2);
		port.close();
	});

	it("tolerates server-to-client control messages (drop without throwing)", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		ws?.deliver(encodeControlMessage({ op: "subscribe", entityIds: ["x"] }));
		expect(port.droppedInbound()).toBe(0);
		port.close();
	});
});

describe("WebSocketRelayPort — subscriptions", () => {
	it("sends subscribe control on first call when Open", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		port.subscribe("entity-1");
		const wire = ws?.sent[0];
		expect(wire?.[0]).toBe(CONTROL_CHANNEL_BYTE);
		const decoded = wire ? decodeControlMessage(wire) : null;
		expect(decoded).toEqual({ op: "subscribe", entityIds: ["entity-1"], bundle: true });
		port.close();
	});

	it("subscribe + unsubscribe before Open queues no control wire but holds state", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		port.subscribe("entity-1");
		port.subscribe("entity-2");
		port.unsubscribe("entity-1");
		const ws = Ctor.instances[0];
		// Nothing sent yet — socket isn't Open.
		expect(ws?.sent.length).toBe(0);
		ws?.open();
		// One bulk subscribe on open carrying the active set.
		const control = ws?.sent[0] ? decodeControlMessage(ws.sent[0]) : null;
		expect(control).toEqual({ op: "subscribe", entityIds: ["entity-2"], bundle: true });
		expect(port.subscriptionsSnapshot()).toEqual(["entity-2"]);
		port.close();
	});

	it("re-emits the full subscription set after reconnect", () => {
		const Ctor = makeFakeWsCtor();
		const timer = manualTimer();
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: Ctor,
			random: () => 0.5,
			setTimer: timer.setTimer,
			clearTimer: timer.clearTimer,
		});
		port.connect();
		Ctor.instances[0]?.open();
		port.subscribe("e1");
		port.subscribe("e2");
		Ctor.instances[0]?.dropClose();
		expect(port.state).toBe(WebSocketRelayState.Reconnecting);
		expect(timer.fire()).toBe(true);
		expect(port.state).toBe(WebSocketRelayState.Connecting);
		const ws2 = Ctor.instances[1];
		ws2?.open();
		// First send on the new socket = the full subscription set.
		const wire = ws2?.sent[0];
		const control = wire ? decodeControlMessage(wire) : null;
		expect(control).toEqual({ op: "subscribe", entityIds: ["e1", "e2"], bundle: true });
		port.close();
	});

	it("rejects empty entityId on subscribe", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		expect(() => port.subscribe("")).toThrow(/empty entityId/);
		port.close();
	});
});

describe("WebSocketRelayPort — reconnect schedule", () => {
	it("schedules sequential delays 500/1000/2000/5000/10000/30000 ms (capped)", () => {
		const Ctor = makeFakeWsCtor();
		const timer = manualTimer();
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: Ctor,
			random: () => 0.5, // jitter = 0
			setTimer: timer.setTimer,
			clearTimer: timer.clearTimer,
		});
		port.connect();
		Ctor.instances[0]?.open();
		const observed: number[] = [];
		for (let i = 0; i < 7; i++) {
			const last = Ctor.instances[Ctor.instances.length - 1];
			last?.dropClose();
			const sched = timer.scheduled();
			const wait = sched[sched.length - 1]?.ms ?? 0;
			observed.push(wait);
			timer.fire();
			// fired socket reconnects → new socket — but we never let it
			// reach Open, so the next dropClose escalates the backoff.
			const nextSocket = Ctor.instances[Ctor.instances.length - 1];
			// Note: a fresh socket starts in CONNECTING; calling dropClose
			// next round simulates the reconnect failing.
			if (!nextSocket) break;
		}
		expect(observed).toEqual([500, 1000, 2000, 5000, 10000, 30000, 30000]);
		port.close();
	});

	it("jitter stays within ±20% of base", () => {
		const Ctor = makeFakeWsCtor();
		const timer = manualTimer();
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: Ctor,
			random: () => 1, // max jitter (positive)
			setTimer: timer.setTimer,
			clearTimer: timer.clearTimer,
		});
		port.connect();
		Ctor.instances[0]?.open();
		Ctor.instances[0]?.dropClose();
		const high = timer.scheduled()[0]?.ms ?? 0;
		// base 500, jitter = +20% → 600
		expect(high).toBe(600);
		port.close();
	});

	it("attempt counter resets after a stable-Open ≥ 30s", () => {
		const Ctor = makeFakeWsCtor();
		const timer = manualTimer();
		let now = 1_000;
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: Ctor,
			random: () => 0.5,
			setTimer: timer.setTimer,
			clearTimer: timer.clearTimer,
			now: () => now,
		});
		port.connect();
		Ctor.instances[0]?.open();
		// Drop after 50s of stable Open — attempt should reset to 0 first.
		now += 50_000;
		Ctor.instances[0]?.dropClose();
		// Next scheduled delay = 500ms (attempt reset).
		expect(timer.scheduled()[0]?.ms).toBe(500);
		port.close();
	});
});

describe("WebSocketRelayPort — disposal cleanup", () => {
	it("close drains pending queue + clears reconnect timer + listeners", () => {
		const Ctor = makeFakeWsCtor();
		const timer = manualTimer();
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: Ctor,
			random: () => 0.5,
			setTimer: timer.setTimer,
			clearTimer: timer.clearTimer,
		});
		port.connect();
		Ctor.instances[0]?.open();
		port.send(new Uint8Array([1]));
		Ctor.instances[0]?.dropClose();
		expect(timer.scheduled().length).toBe(1);
		port.close();
		expect(timer.scheduled().length).toBe(0);
		expect(port.state).toBe(WebSocketRelayState.Closed);
	});

	it("error handler trips Error state then transitions to Reconnecting on close", () => {
		const Ctor = makeFakeWsCtor();
		const timer = manualTimer();
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: Ctor,
			random: () => 0.5,
			setTimer: timer.setTimer,
			clearTimer: timer.clearTimer,
		});
		const states: WebSocketRelayState[] = [];
		port.on("state", (s) => states.push(s));
		port.connect();
		Ctor.instances[0]?.errorOut(new Error("boom"));
		expect(states).toContain(WebSocketRelayState.Error);
		Ctor.instances[0]?.dropClose();
		expect(states).toContain(WebSocketRelayState.Reconnecting);
		port.close();
	});

	it("construct failure transitions to Error then reconnect", () => {
		// Custom ctor that throws synchronously on first construction only.
		let constructed = 0;
		class ThrowingWs extends FakeWebSocketInstance {
			constructor(url: string) {
				super(url);
				constructed += 1;
				if (constructed === 1) throw new Error("construct boom");
			}
		}
		const timer = manualTimer();
		const states: WebSocketRelayState[] = [];
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: ThrowingWs as unknown as new (url: string) => FakeWebSocketInstance,
			random: () => 0.5,
			setTimer: timer.setTimer,
			clearTimer: timer.clearTimer,
		});
		port.on("state", (s) => states.push(s));
		expect(() => port.connect()).not.toThrow();
		expect(states).toContain(WebSocketRelayState.Error);
		port.close();
	});
});

describe("SYNC-4b gated handshake (onChallenge)", () => {
	const enc = new TextEncoder();
	const control = (msg: unknown): Uint8Array => {
		const body = enc.encode(JSON.stringify(msg));
		const out = new Uint8Array(1 + body.length);
		out[0] = CONTROL_CHANNEL_BYTE;
		out.set(body, 1);
		return out;
	};
	const tick = () => new Promise((r) => setTimeout(r, 0));

	it("answers a challenge by sending the onChallenge auth payload", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: Ctor,
			onChallenge: async (nonce) => ({ token: "tok", account: "acct", sig: `sig_${nonce}` }),
		});
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		ws?.deliver(control({ op: "challenge", nonce: "NONCE1" }));
		await tick();
		const auth = ws?.sent.map((b) => decodeControlMessage(b)).find((m) => m?.op === "auth");
		expect(auth).toEqual({ op: "auth", token: "tok", account: "acct", sig: "sig_NONCE1" });
		port.close();
	});

	it("re-sends subscriptions on auth-ok (a gated node dropped the pre-auth ones)", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({
			url: "ws://x",
			wsImpl: Ctor,
			onChallenge: async () => null,
		});
		port.subscribe("e1");
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open(); // sends subscribe #1
		ws?.deliver(control({ op: "auth-ok", plan: "plus" }));
		await tick();
		const subs = (ws?.sent ?? [])
			.map((b) => decodeControlMessage(b))
			.filter((m) => m?.op === "subscribe");
		expect(subs.length).toBeGreaterThanOrEqual(2);
		port.close();
	});

	it("ignores a challenge when no onChallenge is configured (open node)", async () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		ws?.deliver(control({ op: "challenge", nonce: "N" }));
		await tick();
		const auth = (ws?.sent ?? []).map((b) => decodeControlMessage(b)).find((m) => m?.op === "auth");
		expect(auth).toBeUndefined();
		port.close();
	});
});

describe("bundle payload codec (10.10)", () => {
	it("round-trips frames byte-identically", () => {
		const frames = [new Uint8Array([1, 2, 3]), new Uint8Array([9]), new Uint8Array(600).fill(7)];
		const payload = encodeBundlePayload(frames);
		expect(payload).not.toBeNull();
		const decoded = decodeBundlePayload(payload as Uint8Array);
		expect(decoded).not.toBeNull();
		expect(decoded?.length).toBe(3);
		for (let i = 0; i < frames.length; i++) {
			expect(decoded?.[i]).toEqual(frames[i]);
		}
	});

	it("decoded sub-frames are copies of the payload buffer", () => {
		const payload = encodeBundlePayload([new Uint8Array([5, 6])]) as Uint8Array;
		const first = (decodeBundlePayload(payload) as Uint8Array[])[0] as Uint8Array;
		first[0] = 0;
		expect((decodeBundlePayload(payload) as Uint8Array[])[0]).toEqual(new Uint8Array([5, 6]));
	});

	it("rejects malformed payloads wholly (null, never partial)", () => {
		expect(decodeBundlePayload(new Uint8Array(0))).toBeNull(); // empty
		expect(decodeBundlePayload(new Uint8Array([0, 0, 1]))).toBeNull(); // truncated prefix
		expect(decodeBundlePayload(new Uint8Array([0, 0, 0, 0]))).toBeNull(); // zero-length sub-frame
		expect(decodeBundlePayload(new Uint8Array([0, 0, 0, 5, 1, 2]))).toBeNull(); // overrun
		const good = encodeBundlePayload([new Uint8Array([1, 2])]) as Uint8Array;
		const trailing = new Uint8Array([...good, 9, 9]); // trailing garbage
		expect(decodeBundlePayload(trailing)).toBeNull();
	});

	it("refuses to encode an empty bundle or an empty sub-frame", () => {
		expect(encodeBundlePayload([])).toBeNull();
		expect(encodeBundlePayload([new Uint8Array(0)])).toBeNull();
	});
});

describe("WebSocketRelayPort — inbound bundles (10.10)", () => {
	function bundleWire(frames: Uint8Array[]): Uint8Array {
		const payload = encodeBundlePayload(frames) as Uint8Array;
		const wire = new Uint8Array(1 + payload.length);
		wire[0] = BUNDLE_CHANNEL_BYTE;
		wire.set(payload, 1);
		return wire;
	}

	it("delivers bundle sub-frames to listeners byte-identically to per-frame delivery", () => {
		const frames = [new Uint8Array([1, 1, 1]), new Uint8Array([2, 2]), new Uint8Array([3])];

		// Per-frame path: three 0x01 messages.
		const CtorA = makeFakeWsCtor();
		const portA = new WebSocketRelayPort({ url: "ws://a", wsImpl: CtorA });
		portA.connect();
		CtorA.instances[0]?.open();
		const perFrame: Uint8Array[] = [];
		portA.onFrame((f) => perFrame.push(f));
		for (const f of frames) CtorA.instances[0]?.deliver(wrapBinaryFrame(f));
		portA.close();

		// Bundled path: ONE 0x03 message.
		const CtorB = makeFakeWsCtor();
		const portB = new WebSocketRelayPort({ url: "ws://b", wsImpl: CtorB });
		portB.connect();
		CtorB.instances[0]?.open();
		const bundled: Uint8Array[] = [];
		portB.onFrame((f) => bundled.push(f));
		CtorB.instances[0]?.deliver(bundleWire(frames));
		expect(portB.droppedInbound()).toBe(0);
		portB.close();

		expect(bundled.length).toBe(perFrame.length);
		for (let i = 0; i < perFrame.length; i++) {
			expect(bundled[i]).toEqual(perFrame[i]);
		}
	});

	it("drops a malformed bundle wholly and counts it as droppedInbound", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		const received: Uint8Array[] = [];
		port.onFrame((f) => received.push(f));
		ws?.deliver(new Uint8Array([BUNDLE_CHANNEL_BYTE, 0, 0, 0, 9, 1])); // overrun length
		expect(received.length).toBe(0);
		expect(port.droppedInbound()).toBe(1);
		port.close();
	});

	it("a listener throwing on one sub-frame doesn't block the rest of the bundle", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		const seen: number[] = [];
		port.onFrame((f) => {
			seen.push(f[0] as number);
			if (f[0] === 1) throw new Error("boom");
		});
		ws?.deliver(bundleWire([new Uint8Array([1]), new Uint8Array([2])]));
		expect(seen).toEqual([1, 2]);
		port.close();
	});
});

describe("WebSocketRelayPort — subscribeBatch (10.10)", () => {
	it("coalesces N fresh ids into ONE bundle-advertising control message", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		const ids = Array.from({ length: 40 }, (_, i) => `ent_${i}`);
		port.subscribeBatch(ids);
		expect(ws?.sent.length).toBe(1);
		const control = ws?.sent[0] ? decodeControlMessage(ws.sent[0]) : null;
		expect(control).toEqual({ op: "subscribe", entityIds: ids, bundle: true });
		expect(port.subscriptionsSnapshot()).toEqual(ids);
		port.close();
	});

	it("chunks past the batch cap and skips already-subscribed / empty ids", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		const ws = Ctor.instances[0];
		ws?.open();
		port.subscribe("dup");
		const ids = ["dup", "", ...Array.from({ length: 300 }, (_, i) => `ent_${i}`)];
		port.subscribeBatch(ids);
		const subs = (ws?.sent ?? [])
			.map((b) => decodeControlMessage(b))
			.filter(
				(m): m is { op: "subscribe"; entityIds: string[]; bundle?: true } => m?.op === "subscribe",
			);
		// 1 for the single subscribe + 2 chunks (256 + 44) for the batch.
		expect(subs.length).toBe(3);
		expect(subs[1]?.entityIds.length).toBe(256);
		expect(subs[2]?.entityIds.length).toBe(44);
		expect(subs[1]?.entityIds).not.toContain("dup");
		expect(subs[1]?.bundle).toBe(true);
		expect(subs[2]?.bundle).toBe(true);
		port.close();
	});

	it("before Open, holds state silently and re-emits the set on open", () => {
		const Ctor = makeFakeWsCtor();
		const port = new WebSocketRelayPort({ url: "ws://x", wsImpl: Ctor });
		port.connect();
		port.subscribeBatch(["e1", "e2"]);
		const ws = Ctor.instances[0];
		expect(ws?.sent.length).toBe(0);
		ws?.open();
		const control = ws?.sent[0] ? decodeControlMessage(ws.sent[0]) : null;
		expect(control).toEqual({ op: "subscribe", entityIds: ["e1", "e2"], bundle: true });
		port.close();
	});
});
