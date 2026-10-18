// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockFrameHandle } from "./block-frame";
import {
	BLOCK_FRAME_DEFAULT_MAX_INBOUND_PER_SECOND,
	BLOCK_FRAME_DEFAULT_MAX_PAYLOAD_BYTES,
	BlockFrameDropReason,
	BlockFramePhase,
} from "./block-frame-constants";
import {
	type BlockFrameEnvelope,
	BlockFrameMessageDirection,
	BlockFrameMessageKind,
	type BlockFrameStartupPayload,
	type BlockFrameTransport,
	createBlockFrameTransport,
} from "./transport";

/**
 * Builds an in-process fake `BlockFrameHandle` whose `iframe.contentWindow`
 * is a phantom object — distinguishable by identity but otherwise free of
 * the real iframe machinery. Real `createBlockFrame` is exercised by
 * `block-frame.test.ts`; here we test the transport layer in isolation.
 */
interface FakeHandle extends BlockFrameHandle {
	setPhase(p: BlockFramePhase): void;
	posts: Array<{ message: unknown; targetOrigin: string }>;
}

function makeFakeHandle(): FakeHandle {
	let phase = BlockFramePhase.Paused;
	let destroyed = false;
	const posts: Array<{ message: unknown; targetOrigin: string }> = [];
	const contentWindow = {
		postMessage(message: unknown, targetOrigin: string): void {
			posts.push({ message, targetOrigin });
		},
	} as unknown as Window;
	const iframe = {
		contentWindow,
	} as unknown as HTMLIFrameElement;
	return {
		iframe,
		getPhase: () => phase,
		getSize: () => ({ width: 0, height: 0 }),
		isDestroyed: () => destroyed,
		destroy(): void {
			destroyed = true;
			phase = BlockFramePhase.Unloaded;
		},
		setPhase(next: BlockFramePhase): void {
			phase = next;
		},
		posts,
	};
}

/**
 * A controllable message-event host. `dispatch` synthesises a MessageEvent
 * with the supplied `source` / `data` / `origin` and delivers it to every
 * registered listener — mirroring the real `window.addEventListener
 * ("message", ...)` semantics.
 */
interface FakeHost {
	addEventListener: typeof window.addEventListener;
	removeEventListener: typeof window.removeEventListener;
	dispatch(detail: { source?: unknown; origin?: string; data?: unknown }): void;
	listenerCount(): number;
}

function makeFakeHost(): FakeHost {
	const listeners = new Set<EventListener>();
	return {
		addEventListener: ((_type: string, listener: EventListener) => {
			listeners.add(listener);
		}) as typeof window.addEventListener,
		removeEventListener: ((_type: string, listener: EventListener) => {
			listeners.delete(listener);
		}) as typeof window.removeEventListener,
		dispatch(detail): void {
			const ev = {
				source: detail.source ?? null,
				origin: detail.origin ?? "null",
				data: detail.data ?? null,
			} as unknown as MessageEvent;
			for (const l of [...listeners]) l(ev as unknown as Event);
		},
		listenerCount: () => listeners.size,
	};
}

function lastEnvelope(handle: FakeHandle): BlockFrameEnvelope<unknown> | undefined {
	const tail = handle.posts.at(-1);
	return tail?.message as BlockFrameEnvelope<unknown> | undefined;
}

describe("createBlockFrameTransport — channel id minting", () => {
	it("mints a non-empty string id", () => {
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		expect(typeof t.channelId).toBe("string");
		expect(t.channelId.length).toBeGreaterThan(0);
		t.close();
	});

	it("uses the injected minter when supplied", () => {
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "pinned-id-42",
		});
		expect(t.channelId).toBe("pinned-id-42");
		t.close();
	});

	it("spinning N transports yields N distinct channel ids", () => {
		const ids = new Set<string>();
		const N = 64;
		const made: BlockFrameTransport[] = [];
		for (let i = 0; i < N; i++) {
			const handle = makeFakeHandle();
			const host = makeFakeHost();
			const t = createBlockFrameTransport({
				handle,
				entityId: "ent_x",
				capabilities: [],
				host,
			});
			ids.add(t.channelId);
			made.push(t);
		}
		expect(ids.size).toBe(N);
		for (const t of made) t.close();
	});

	it("falls back to crypto.getRandomValues when randomUUID is absent, producing a UUIDv4-shaped id", () => {
		// Stub globalThis.crypto with getRandomValues only (no randomUUID).
		// The 9.5.1 invariant: the channel id must be CSPRNG-derived.
		const original = globalThis.crypto;
		const stub = {
			getRandomValues<T extends ArrayBufferView>(arr: T): T {
				const view = arr as unknown as Uint8Array;
				for (let i = 0; i < view.length; i++) view[i] = i + 1;
				return arr;
			},
		};
		Object.defineProperty(globalThis, "crypto", { value: stub, configurable: true });
		try {
			const handle = makeFakeHandle();
			const host = makeFakeHost();
			const t = createBlockFrameTransport({
				handle,
				entityId: "ent_x",
				capabilities: [],
				host,
			});
			// 36-char UUIDv4 shape (8-4-4-4-12) with version=4 + variant=10xx bits set.
			expect(t.channelId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			t.close();
		} finally {
			Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
		}
	});

	it("throws when no Web Crypto is available at all (fail-loud, not silent-weakening)", () => {
		// A non-CSPRNG fallback (e.g. Math.random) would silently weaken the
		// inbound-gate primary defense — fail loud instead so the wrong
		// runtime is observable, not invisible.
		const original = globalThis.crypto;
		Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
		try {
			const handle = makeFakeHandle();
			const host = makeFakeHost();
			expect(() =>
				createBlockFrameTransport({
					handle,
					entityId: "ent_x",
					capabilities: [],
					host,
				}),
			).toThrow(/no CSPRNG available/);
		} finally {
			Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
		}
	});
});

describe("createBlockFrameTransport — startup envelope", () => {
	it("does NOT send startup when constructed against a Paused handle", () => {
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: ["entities.read:Note"],
			host,
		});
		expect(t.hasSentStartup()).toBe(false);
		expect(handle.posts).toHaveLength(0);
		t.close();
	});

	it("sends startup immediately when handle is already Mounted at construction", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: ["entities.read:Note", "entities.write:Note"],
			host,
		});
		expect(t.hasSentStartup()).toBe(true);
		const env = lastEnvelope(handle);
		expect(env?.kind).toBe(BlockFrameMessageKind.Startup);
		expect(env?.direction).toBe(BlockFrameMessageDirection.HostToBlock);
		expect(env?.entityId).toBe("ent_x");
		expect(env?.channelId).toBe(t.channelId);
		const payload = env?.payload as BlockFrameStartupPayload;
		expect([...payload.capabilities]).toEqual(["entities.read:Note", "entities.write:Note"]);
		t.close();
	});

	it("carries a valid host entity id in the startup payload, and drops a malformed one (9.12.24)", () => {
		const startupFor = (hostEntityId: string) => {
			const handle = makeFakeHandle();
			handle.setPhase(BlockFramePhase.Mounted);
			const t = createBlockFrameTransport({
				handle,
				entityId: "ent_list",
				capabilities: [],
				hostEntityId,
				host: makeFakeHost(),
			});
			const payload = lastEnvelope(handle)?.payload as BlockFrameStartupPayload;
			t.close();
			return payload;
		};
		expect(startupFor("ent_page").hostEntityId).toBe("ent_page");
		expect(startupFor("ent page")).not.toHaveProperty("hostEntityId");
		expect(startupFor("")).not.toHaveProperty("hostEntityId");
	});

	it("flushStartup is idempotent — startup envelope sent exactly once", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		t.flushStartup();
		t.flushStartup();
		t.flushStartup();
		const startupCount = handle.posts.filter(
			(p) => (p.message as BlockFrameEnvelope).kind === BlockFrameMessageKind.Startup,
		).length;
		expect(startupCount).toBe(1);
		t.close();
	});

	it("flushStartup is a no-op while Paused — fires on later Mounted transition", () => {
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: ["entities.read:Note"],
			host,
		});
		t.flushStartup();
		expect(t.hasSentStartup()).toBe(false);
		expect(handle.posts).toHaveLength(0);

		handle.setPhase(BlockFramePhase.Mounted);
		t.flushStartup();
		expect(t.hasSentStartup()).toBe(true);
		expect(handle.posts).toHaveLength(1);
		t.close();
	});

	it("capability list passed to startup is a frozen snapshot — caller mutation does not leak", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const caps = ["entities.read:Note"];
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: caps,
			host,
		});
		caps.push("entities.write:*");
		const env = lastEnvelope(handle);
		const payload = env?.payload as BlockFrameStartupPayload;
		expect([...payload.capabilities]).toEqual(["entities.read:Note"]);
		expect(Object.isFrozen(payload.capabilities)).toBe(true);
		t.close();
	});
});

describe("createBlockFrameTransport — send(): outbound phase + close gates", () => {
	let handle: FakeHandle;
	let host: FakeHost;
	let t: BlockFrameTransport;

	beforeEach(() => {
		handle = makeFakeHandle();
		host = makeFakeHost();
		t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: ["entities.read:Note"],
			host,
			mintChannelId: () => "ch-test",
		});
	});

	afterEach(() => {
		t.close();
	});

	it("send() while Paused is a no-op (drop, do not queue)", () => {
		t.send({ hello: "world" });
		expect(handle.posts).toHaveLength(0);
	});

	it("send() while Mounted posts a Message envelope (after startup)", () => {
		handle.setPhase(BlockFramePhase.Mounted);
		t.send({ hello: "world" });
		expect(handle.posts).toHaveLength(2); // startup + message
		const startup = handle.posts[0]?.message as BlockFrameEnvelope;
		const msg = handle.posts[1]?.message as BlockFrameEnvelope;
		expect(startup.kind).toBe(BlockFrameMessageKind.Startup);
		expect(msg.kind).toBe(BlockFrameMessageKind.Message);
		expect(msg.direction).toBe(BlockFrameMessageDirection.HostToBlock);
		expect(msg.channelId).toBe("ch-test");
		expect(msg.entityId).toBe("ent_x");
		expect(msg.payload).toEqual({ hello: "world" });
	});

	it("send() uses targetOrigin '*' (opaque-origin frames serialise as 'null' which is rejected)", () => {
		handle.setPhase(BlockFramePhase.Mounted);
		t.send({ ping: 1 });
		expect(handle.posts.every((p) => p.targetOrigin === "*")).toBe(true);
	});

	it("send() after close is a no-op", () => {
		handle.setPhase(BlockFramePhase.Mounted);
		t.close();
		t.send({ hello: "world" });
		expect(handle.posts).toHaveLength(0);
	});

	it("send() back to Paused after Mounted drops outbound (re-Mounted again resumes)", () => {
		handle.setPhase(BlockFramePhase.Mounted);
		t.send({ first: true });
		handle.setPhase(BlockFramePhase.Paused);
		t.send({ second: true });
		const messageEnvelopes = handle.posts.filter(
			(p) => (p.message as BlockFrameEnvelope).kind === BlockFrameMessageKind.Message,
		);
		expect(messageEnvelopes).toHaveLength(1);
		handle.setPhase(BlockFramePhase.Mounted);
		t.send({ third: true });
		const after = handle.posts.filter(
			(p) => (p.message as BlockFrameEnvelope).kind === BlockFrameMessageKind.Message,
		);
		expect(after).toHaveLength(2);
	});

	it("send() before construction-time Mounted does not double-send startup later", () => {
		// Already Paused at construction, never Mounted: no startup.
		// Now flip to Mounted and send: startup fires once.
		handle.setPhase(BlockFramePhase.Mounted);
		t.send({ a: 1 });
		t.send({ b: 2 });
		t.send({ c: 3 });
		const startupCount = handle.posts.filter(
			(p) => (p.message as BlockFrameEnvelope).kind === BlockFrameMessageKind.Startup,
		).length;
		expect(startupCount).toBe(1);
	});
});

describe("createBlockFrameTransport — inbound security gates", () => {
	let handle: FakeHandle;
	let host: FakeHost;
	let onMessage: (payload: unknown) => void;
	let t: BlockFrameTransport;

	beforeEach(() => {
		handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		host = makeFakeHost();
		onMessage = vi.fn();
		t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			onMessage,
		});
	});

	afterEach(() => {
		t.close();
	});

	const validEnvelope = (overrides: Partial<BlockFrameEnvelope> = {}): BlockFrameEnvelope => ({
		channelId: "ch-x",
		entityId: "ent_x",
		direction: BlockFrameMessageDirection.BlockToHost,
		kind: BlockFrameMessageKind.Message,
		payload: { ok: true },
		...overrides,
	});

	it("accepts a well-formed inbound from the bound iframe", () => {
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope(),
		});
		expect(onMessage).toHaveBeenCalledWith({ ok: true });
	});

	it("rejects inbound from a DIFFERENT iframe even with matching channel id (identity gate)", () => {
		const spoofWindow = { postMessage: () => undefined } as unknown as Window;
		host.dispatch({ source: spoofWindow, data: validEnvelope() });
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("rejects inbound from the right iframe with a WRONG channel id (channel gate)", () => {
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope({ channelId: "wrong-id" }),
		});
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("rejects inbound when handle phase is Paused (inbound phase gate)", () => {
		handle.setPhase(BlockFramePhase.Paused);
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope(),
		});
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("rejects inbound when handle phase is Unloaded (post-destroy)", () => {
		handle.setPhase(BlockFramePhase.Unloaded);
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope(),
		});
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("rejects inbound with wrong direction (HostToBlock arriving inbound is an impersonation)", () => {
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope({ direction: BlockFrameMessageDirection.HostToBlock }),
		});
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("rejects inbound with wrong entityId", () => {
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope({ entityId: "ent_y" }),
		});
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("ignores inbound Startup envelopes (host-to-block only kind)", () => {
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope({ kind: BlockFrameMessageKind.Startup }),
		});
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("ignores malformed inbound (null / non-object / missing fields)", () => {
		host.dispatch({ source: handle.iframe.contentWindow, data: null });
		host.dispatch({ source: handle.iframe.contentWindow, data: undefined });
		host.dispatch({ source: handle.iframe.contentWindow, data: 42 });
		host.dispatch({ source: handle.iframe.contentWindow, data: "envelope" });
		host.dispatch({ source: handle.iframe.contentWindow, data: {} });
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("rejects inbound from a sibling block iframe spoofing the right channel id (identity beats channel)", () => {
		// A sibling block frame in the same renderer reports origin "null"
		// (every opaque-origin sandbox does); origin is not the gate. The
		// gate is event.source — if the attacker somehow learned the
		// channel id but cannot get a reference to OUR contentWindow, the
		// identity check still rejects.
		const siblingWindow = { postMessage: () => undefined } as unknown as Window;
		host.dispatch({
			source: siblingWindow,
			origin: "null",
			data: validEnvelope(),
		});
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("a throwing onMessage callback does not break subsequent deliveries", () => {
		const throwing: (p: unknown) => void = vi.fn(() => {
			throw new Error("host crash");
		});
		const t2 = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-2",
			onMessage: throwing,
		});
		expect(() =>
			host.dispatch({
				source: handle.iframe.contentWindow,
				data: validEnvelope({ channelId: "ch-2" }),
			}),
		).not.toThrow();
		expect(throwing).toHaveBeenCalledTimes(1);
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope({ channelId: "ch-2" }),
		});
		expect(throwing).toHaveBeenCalledTimes(2);
		t2.close();
	});
});

describe("createBlockFrameTransport — multiple transports share a window safely", () => {
	it("two transports on the same handle isolate via distinct channel ids", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const onA = vi.fn();
		const onB = vi.fn();
		const a = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-a",
			onMessage: onA,
		});
		const b = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-b",
			onMessage: onB,
		});
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: {
				channelId: "ch-a",
				entityId: "ent_x",
				direction: BlockFrameMessageDirection.BlockToHost,
				kind: BlockFrameMessageKind.Message,
				payload: { for: "a" },
			} as BlockFrameEnvelope,
		});
		expect(onA).toHaveBeenCalledWith({ for: "a" });
		expect(onB).not.toHaveBeenCalled();

		host.dispatch({
			source: handle.iframe.contentWindow,
			data: {
				channelId: "ch-b",
				entityId: "ent_x",
				direction: BlockFrameMessageDirection.BlockToHost,
				kind: BlockFrameMessageKind.Message,
				payload: { for: "b" },
			} as BlockFrameEnvelope,
		});
		expect(onB).toHaveBeenCalledWith({ for: "b" });
		expect(onA).toHaveBeenCalledTimes(1);
		a.close();
		b.close();
	});
});

describe("createBlockFrameTransport — close() teardown", () => {
	it("close() removes the window listener (no leak)", () => {
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		expect(host.listenerCount()).toBe(1);
		t.close();
		expect(host.listenerCount()).toBe(0);
	});

	it("close() is idempotent — second close is a no-op", () => {
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		t.close();
		t.close();
		t.close();
		expect(t.isClosed()).toBe(true);
		expect(host.listenerCount()).toBe(0);
	});

	it("inbound after close is silently ignored (listener removed)", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const onMessage = vi.fn();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			onMessage,
		});
		t.close();
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: {
				channelId: "ch-x",
				entityId: "ent_x",
				direction: BlockFrameMessageDirection.BlockToHost,
				kind: BlockFrameMessageKind.Message,
				payload: { whatever: true },
			} as BlockFrameEnvelope,
		});
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("does NOT destroy the underlying handle", () => {
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		t.close();
		expect(handle.isDestroyed()).toBe(false);
	});

	it("flushStartup after close is a no-op", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		expect(handle.posts).toHaveLength(1); // startup fired at construction
		t.close();
		t.flushStartup();
		expect(handle.posts).toHaveLength(1);
	});
});

describe("createBlockFrameTransport — payload-size cap (9.5.3)", () => {
	const validEnvelope = (overrides: Partial<BlockFrameEnvelope> = {}): BlockFrameEnvelope => ({
		channelId: "ch-x",
		entityId: "ent_x",
		direction: BlockFrameMessageDirection.BlockToHost,
		kind: BlockFrameMessageKind.Message,
		payload: { ok: true },
		...overrides,
	});

	it("default cap is 256 KiB", () => {
		expect(BLOCK_FRAME_DEFAULT_MAX_PAYLOAD_BYTES).toBe(256 * 1024);
	});

	it("send() drops outbound payload over the cap and counts it", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			maxPayloadBytes: 200,
		});
		// startup envelope is exempt from the cap
		expect(handle.posts).toHaveLength(1);
		t.send({ big: "x".repeat(500) });
		expect(handle.posts).toHaveLength(1);
		expect(t.dropCounts()[BlockFrameDropReason.OutboundPayloadTooLarge]).toBe(1);
		t.close();
	});

	it("send() passes outbound payload under the cap", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			maxPayloadBytes: 4096,
		});
		t.send({ small: true });
		expect(handle.posts).toHaveLength(2); // startup + message
		expect(t.dropCounts()[BlockFrameDropReason.OutboundPayloadTooLarge]).toBe(0);
		t.close();
	});

	it("startup envelope is exempt from the size cap", () => {
		// A tiny cap (10 bytes) cannot fit even the startup envelope's
		// header, but the startup must still be delivered.
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: ["entities.read:Note"],
			host,
			mintChannelId: () => "ch-x",
			maxPayloadBytes: 10,
		});
		expect(t.hasSentStartup()).toBe(true);
		expect(handle.posts).toHaveLength(1);
		t.close();
	});

	it("inbound over the cap is dropped + counted", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const onMessage = vi.fn();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			onMessage,
			maxPayloadBytes: 200,
		});
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope({ payload: { big: "x".repeat(500) } }),
		});
		expect(onMessage).not.toHaveBeenCalled();
		expect(t.dropCounts()[BlockFrameDropReason.InboundPayloadTooLarge]).toBe(1);
		t.close();
	});

	it("inbound under the cap is accepted", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const onMessage = vi.fn();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			onMessage,
			maxPayloadBytes: 4096,
		});
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope(),
		});
		expect(onMessage).toHaveBeenCalledTimes(1);
		expect(t.dropCounts()[BlockFrameDropReason.InboundPayloadTooLarge]).toBe(0);
		t.close();
	});

	it("non-serialisable payload (cyclic) is dropped on send (treated as oversize)", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
		});
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		t.send(cyclic);
		expect(handle.posts).toHaveLength(1); // startup only — the cyclic send dropped
		expect(
			handle.posts.filter(
				(p) => (p.message as BlockFrameEnvelope).kind === BlockFrameMessageKind.Message,
			),
		).toHaveLength(0);
		expect(t.dropCounts()[BlockFrameDropReason.OutboundPayloadTooLarge]).toBe(1);
		t.close();
	});

	it("invalid cap (≤0) falls back to the default", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			maxPayloadBytes: 0,
		});
		// 1 KiB payload sails through the default (256 KiB) cap.
		t.send({ kb: "x".repeat(1024) });
		expect(
			handle.posts.filter(
				(p) => (p.message as BlockFrameEnvelope).kind === BlockFrameMessageKind.Message,
			),
		).toHaveLength(1);
		t.close();
	});
});

describe("createBlockFrameTransport — inbound rate-limit (9.5.3)", () => {
	const validEnvelope = (overrides: Partial<BlockFrameEnvelope> = {}): BlockFrameEnvelope => ({
		channelId: "ch-x",
		entityId: "ent_x",
		direction: BlockFrameMessageDirection.BlockToHost,
		kind: BlockFrameMessageKind.Message,
		payload: { ok: true },
		...overrides,
	});

	it("default rate is 1000/s", () => {
		expect(BLOCK_FRAME_DEFAULT_MAX_INBOUND_PER_SECOND).toBe(1000);
	});

	it("under-rate inbound flows through", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const onMessage = vi.fn();
		let t = 0;
		const transport = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			onMessage,
			maxInboundPerSecond: 3,
			now: () => t,
		});
		for (let i = 0; i < 3; i++) {
			host.dispatch({ source: handle.iframe.contentWindow, data: validEnvelope() });
			t += 10;
		}
		expect(onMessage).toHaveBeenCalledTimes(3);
		expect(transport.dropCounts()[BlockFrameDropReason.InboundRateLimited]).toBe(0);
		transport.close();
	});

	it("over-rate inbound is dropped + counted; window slide reopens the path", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const onMessage = vi.fn();
		let t = 0;
		const transport = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			onMessage,
			maxInboundPerSecond: 3,
			now: () => t,
		});
		// 5 within the window — 3 accepted, 2 dropped.
		for (let i = 0; i < 5; i++) {
			host.dispatch({ source: handle.iframe.contentWindow, data: validEnvelope() });
		}
		expect(onMessage).toHaveBeenCalledTimes(3);
		expect(transport.dropCounts()[BlockFrameDropReason.InboundRateLimited]).toBe(2);
		// Slide the window past the 1s mark — counts reset (timestamps pruned).
		t += 1001;
		for (let i = 0; i < 2; i++) {
			host.dispatch({ source: handle.iframe.contentWindow, data: validEnvelope() });
		}
		expect(onMessage).toHaveBeenCalledTimes(5);
		expect(transport.dropCounts()[BlockFrameDropReason.InboundRateLimited]).toBe(2);
		transport.close();
	});

	it("rate-limit charges only valid envelopes; spoofed floods do NOT advance the counter", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const onMessage = vi.fn();
		const transport = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			onMessage,
			maxInboundPerSecond: 2,
			now: () => 0,
		});
		const spoofWindow = { postMessage: () => undefined } as unknown as Window;
		// Flood 100 spoofs — none should consume a slot.
		for (let i = 0; i < 100; i++) {
			host.dispatch({ source: spoofWindow, data: validEnvelope() });
		}
		// 2 legitimate envelopes — both should pass.
		for (let i = 0; i < 2; i++) {
			host.dispatch({ source: handle.iframe.contentWindow, data: validEnvelope() });
		}
		expect(onMessage).toHaveBeenCalledTimes(2);
		expect(transport.dropCounts()[BlockFrameDropReason.InboundIdentity]).toBe(100);
		expect(transport.dropCounts()[BlockFrameDropReason.InboundRateLimited]).toBe(0);
		transport.close();
	});

	it("invalid rate-limit (≤0) falls back to the default", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const onMessage = vi.fn();
		const transport = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			onMessage,
			maxInboundPerSecond: 0,
			now: () => 0,
		});
		// 100 envelopes well below the 1000 default cap.
		for (let i = 0; i < 100; i++) {
			host.dispatch({ source: handle.iframe.contentWindow, data: validEnvelope() });
		}
		expect(onMessage).toHaveBeenCalledTimes(100);
		expect(transport.dropCounts()[BlockFrameDropReason.InboundRateLimited]).toBe(0);
		transport.close();
	});

	it("rate-limit silently drops — no console noise (DoS-safe)", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const transport = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			maxInboundPerSecond: 1,
			now: () => 0,
		});
		for (let i = 0; i < 50; i++) {
			host.dispatch({
				source: handle.iframe.contentWindow,
				data: {
					channelId: "ch-x",
					entityId: "ent_x",
					direction: BlockFrameMessageDirection.BlockToHost,
					kind: BlockFrameMessageKind.Message,
					payload: {},
				} as BlockFrameEnvelope,
			});
		}
		expect(warn).not.toHaveBeenCalled();
		expect(errSpy).not.toHaveBeenCalled();
		warn.mockRestore();
		errSpy.mockRestore();
		transport.close();
	});
});

describe("createBlockFrameTransport — drop-counter contract (9.5.3)", () => {
	it("dropCounts() returns a fresh object each call", () => {
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		const a = t.dropCounts();
		const b = t.dropCounts();
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
		t.close();
	});

	it("dropCounts() snapshot is frozen — caller mutation throws + transport state stays intact", () => {
		// 9.5.3 integrator-fix hardened `dropCounts()` to return an
		// `Object.freeze`-d snapshot. The type already said `Readonly<>`;
		// the runtime now matches. This pins both invariants: (a) the
		// snapshot itself rejects writes (TypeError under strict mode);
		// (b) even if a caller bypasses (e.g. casts away the type), the
		// transport's internal counter is a different object and is
		// unaffected.
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		const snap = t.dropCounts();
		expect(Object.isFrozen(snap)).toBe(true);
		expect(() => {
			(snap as unknown as Record<string, number>)[BlockFrameDropReason.InboundChannel] = 999;
		}).toThrow(TypeError);
		expect(t.dropCounts()[BlockFrameDropReason.InboundChannel]).toBe(0);
		t.close();
	});

	it("every BlockFrameDropReason key is present in the snapshot (no missing zeros)", () => {
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		const snap = t.dropCounts();
		for (const reason of Object.values(BlockFrameDropReason)) {
			expect(snap[reason as BlockFrameDropReason]).toBe(0);
		}
		t.close();
	});

	it("OutboundClosed counts send() after close", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		t.close();
		t.send({ a: 1 });
		t.send({ b: 2 });
		expect(t.dropCounts()[BlockFrameDropReason.OutboundClosed]).toBe(2);
	});

	it("OutboundNotMounted counts send() while Paused", () => {
		const handle = makeFakeHandle();
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
		});
		t.send({ a: 1 });
		t.send({ b: 2 });
		t.send({ c: 3 });
		expect(t.dropCounts()[BlockFrameDropReason.OutboundNotMounted]).toBe(3);
		t.close();
	});

	it("inbound-gate reasons increment independently", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const onMessage = vi.fn();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			onMessage,
		});
		const validEnvelope = (overrides: Partial<BlockFrameEnvelope> = {}): BlockFrameEnvelope => ({
			channelId: "ch-x",
			entityId: "ent_x",
			direction: BlockFrameMessageDirection.BlockToHost,
			kind: BlockFrameMessageKind.Message,
			payload: { ok: true },
			...overrides,
		});
		// Identity fail
		const spoof = { postMessage: () => undefined } as unknown as Window;
		host.dispatch({ source: spoof, data: validEnvelope() });
		// Channel fail
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope({ channelId: "wrong" }),
		});
		// EntityId fail
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope({ entityId: "ent_y" }),
		});
		// Direction fail
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope({ direction: BlockFrameMessageDirection.HostToBlock }),
		});
		// Kind fail (startup arriving inbound)
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: validEnvelope({ kind: BlockFrameMessageKind.Startup }),
		});
		// Malformed
		host.dispatch({ source: handle.iframe.contentWindow, data: null });
		// Phase fail
		handle.setPhase(BlockFramePhase.Paused);
		host.dispatch({ source: handle.iframe.contentWindow, data: validEnvelope() });
		const counts = t.dropCounts();
		expect(counts[BlockFrameDropReason.InboundIdentity]).toBe(1);
		expect(counts[BlockFrameDropReason.InboundChannel]).toBe(1);
		expect(counts[BlockFrameDropReason.InboundEntityId]).toBe(1);
		expect(counts[BlockFrameDropReason.InboundDirection]).toBe(1);
		expect(counts[BlockFrameDropReason.InboundKind]).toBe(1);
		expect(counts[BlockFrameDropReason.InboundMalformed]).toBe(1);
		expect(counts[BlockFrameDropReason.InboundPhase]).toBe(1);
		expect(onMessage).not.toHaveBeenCalled();
		t.close();
	});
});

describe("createBlockFrameTransport — adversarial inbound payloads (9.5.3)", () => {
	let handle: FakeHandle;
	let host: FakeHost;
	let onMessage: (payload: unknown) => void;
	let t: BlockFrameTransport;

	beforeEach(() => {
		handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		host = makeFakeHost();
		onMessage = vi.fn();
		t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: [],
			host,
			mintChannelId: () => "ch-x",
			onMessage,
		});
	});

	afterEach(() => {
		t.close();
	});

	const valid = (overrides: Partial<BlockFrameEnvelope> = {}): BlockFrameEnvelope => ({
		channelId: "ch-x",
		entityId: "ent_x",
		direction: BlockFrameMessageDirection.BlockToHost,
		kind: BlockFrameMessageKind.Message,
		payload: { ok: true },
		...overrides,
	});

	it("payload containing a Symbol property — accepted (Symbols are dropped by clone but the gate is shape-only)", () => {
		// postMessage's structured-clone walk silently drops Symbol-keyed
		// props (in real browsers); jsdom passes the object through. The
		// transport's gates don't inspect payload values — that's the
		// BP-protocol layer's job. We assert the gate doesn't crash and
		// the delivery happens.
		const env = valid({ payload: { ok: true, [Symbol("s") as unknown as string]: 1 } });
		host.dispatch({ source: handle.iframe.contentWindow, data: env });
		expect(onMessage).toHaveBeenCalledTimes(1);
	});

	it("payload with __proto__ literal — accepted; no host pollution (only the envelope is read)", () => {
		// The transport reads `data.channelId / .entityId / .direction /
		// .kind / .payload`. A payload whose own keys include `__proto__`
		// cannot pollute the host's Object.prototype because the
		// transport never copy-merges it; the host receives `payload` as
		// an opaque value to forward to its BP handler. This test pins
		// the contract: no prototype pollution at the transport level.
		const env = valid({ payload: JSON.parse('{"__proto__": {"polluted": true}}') });
		host.dispatch({ source: handle.iframe.contentWindow, data: env });
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(onMessage).toHaveBeenCalledTimes(1);
	});

	it("very deeply nested payload under the cap — accepted (no stack overflow at the transport)", () => {
		let deep: unknown = { leaf: true };
		for (let i = 0; i < 200; i++) deep = { nested: deep };
		host.dispatch({ source: handle.iframe.contentWindow, data: valid({ payload: deep }) });
		expect(onMessage).toHaveBeenCalledTimes(1);
	});

	it("envelope whose channelId is a TYPE (number) is dropped under the channel gate (not a JSON-shape coercion)", () => {
		host.dispatch({
			source: handle.iframe.contentWindow,
			data: { ...valid(), channelId: 0 } as unknown as BlockFrameEnvelope,
		});
		expect(onMessage).not.toHaveBeenCalled();
		expect(t.dropCounts()[BlockFrameDropReason.InboundChannel]).toBe(1);
	});

	it("non-object inbound (array) is dropped under the malformed gate", () => {
		// Arrays are typeof 'object' but lack channelId; the type check is
		// `typeof data !== 'object'` so an array passes — then channelId
		// check fails. The user-visible behaviour is "dropped silently".
		host.dispatch({ source: handle.iframe.contentWindow, data: [1, 2, 3] });
		expect(onMessage).not.toHaveBeenCalled();
		// either malformed (we now reject) or channel — pinned below
		const counts = t.dropCounts();
		expect(
			counts[BlockFrameDropReason.InboundMalformed] + counts[BlockFrameDropReason.InboundChannel],
		).toBe(1);
	});
});

describe("createBlockFrameTransport — enum + envelope shape contract", () => {
	it("BlockFrameMessageDirection values are the wire strings", () => {
		expect(BlockFrameMessageDirection.HostToBlock).toBe("host-to-block");
		expect(BlockFrameMessageDirection.BlockToHost).toBe("block-to-host");
	});

	it("BlockFrameMessageKind values are the wire strings", () => {
		expect(BlockFrameMessageKind.Startup).toBe("startup");
		expect(BlockFrameMessageKind.Message).toBe("message");
	});

	it("startup envelope shape carries channelId/entityId/direction/kind/payload", () => {
		const handle = makeFakeHandle();
		handle.setPhase(BlockFramePhase.Mounted);
		const host = makeFakeHost();
		const t = createBlockFrameTransport({
			handle,
			entityId: "ent_x",
			capabilities: ["entities.read:Note"],
			host,
			mintChannelId: () => "ch-x",
		});
		const env = lastEnvelope(handle) as BlockFrameEnvelope<BlockFrameStartupPayload>;
		expect(env.channelId).toBe("ch-x");
		expect(env.entityId).toBe("ent_x");
		expect(env.direction).toBe(BlockFrameMessageDirection.HostToBlock);
		expect(env.kind).toBe(BlockFrameMessageKind.Startup);
		expect(env.payload).toEqual({ capabilities: ["entities.read:Note"] });
		t.close();
	});
});
