/**
 * Stage 10.11 — routing-token rotation on the (storeless) relay-server:
 * the `rotate` control verb, subscriber move, the dual-token grace alias,
 * grace expiry, and wire-parse rejects. The durable-node half (storage
 * re-home + catalog + gated authorization) lives in `brainstorm-sync`;
 * this copy keeps the wire contract in lockstep for the product's test
 * harnesses.
 */

import { describe, expect, it } from "vitest";
import { type ServerWebSocketLike, createRelayCore } from "./server";
import { PROTOCOL_VERSION, type RoutingHeader, WireKind } from "./wire";

const CONTROL_CHANNEL_BYTE = 0x00;
const FRAME_CHANNEL_BYTE = 0x01;

const T1 = "route-token-1";
const T2 = "route-token-2";

class SyntheticClient implements ServerWebSocketLike {
	data: { connId?: string } = {};
	received: Uint8Array[] = [];

	send(data: Uint8Array | string): void {
		if (typeof data === "string") return;
		this.received.push(new Uint8Array(data));
	}

	close(): void {}

	controlReplies(): Array<Record<string, unknown>> {
		return this.received
			.filter((w) => w[0] === CONTROL_CHANNEL_BYTE)
			.map((w) => JSON.parse(new TextDecoder().decode(w.subarray(1))) as Record<string, unknown>);
	}

	frames(): Uint8Array[] {
		return this.received.filter((w) => w[0] === FRAME_CHANNEL_BYTE);
	}
}

function encodeFrame(header: RoutingHeader): Uint8Array {
	const sig = new Uint8Array(64);
	const ciphertext = new Uint8Array([0x11, 0x22, 0x33]);
	const headerBytes = new TextEncoder().encode(JSON.stringify(header));
	const out = new Uint8Array(4 + headerBytes.length + 2 + sig.length + 4 + ciphertext.length);
	const view = new DataView(out.buffer);
	let off = 0;
	view.setUint32(off, headerBytes.length, false);
	off += 4;
	out.set(headerBytes, off);
	off += headerBytes.length;
	view.setUint16(off, sig.length, false);
	off += 2;
	out.set(sig, off);
	off += sig.length;
	view.setUint32(off, ciphertext.length, false);
	off += 4;
	out.set(ciphertext, off);
	return out;
}

function makeHeader(entityId: string): RoutingHeader {
	return {
		v: PROTOCOL_VERSION,
		kind: WireKind.Update,
		entityId,
		sender: "sender-1",
		seq: 1,
		nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		ts: 1_700_000_000_000,
	};
}

function channel(byte: number, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(1 + body.length);
	out[0] = byte;
	out.set(body, 1);
	return out;
}

function control(message: Record<string, unknown>): Uint8Array {
	return channel(CONTROL_CHANNEL_BYTE, new TextEncoder().encode(JSON.stringify(message)));
}

function makeCore(graceMs = 60_000) {
	const clock = { now: 1_000 };
	let counter = 0;
	const core = createRelayCore({
		mintConnId: () => `c${++counter}`,
		now: () => clock.now,
		rotateGraceMs: graceMs,
	});
	return { core, clock };
}

describe("relay-server rotate verb (10.11)", () => {
	it("acks rotated, moves subscribers, and fans new-token frames to old-token peers", () => {
		const { core } = makeCore();
		const a = new SyntheticClient();
		const b = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onOpen(b);
		core.handlers.onMessage(b, control({ op: "subscribe", entityIds: [T1] }));

		core.handlers.onMessage(a, control({ op: "rotate", from: T1, to: T2 }));
		expect(a.controlReplies()).toEqual([{ op: "rotated", from: T1, to: T2 }]);

		core.handlers.onMessage(a, channel(FRAME_CHANNEL_BYTE, encodeFrame(makeHeader(T2))));
		expect(b.frames().length).toBe(1);
	});

	it("during grace a frame under the OLD token reaches new-token subscribers", () => {
		const { core } = makeCore();
		const a = new SyntheticClient();
		const b = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onOpen(b);
		core.handlers.onMessage(a, control({ op: "rotate", from: T1, to: T2 }));
		core.handlers.onMessage(b, control({ op: "subscribe", entityIds: [T2] }));
		core.handlers.onMessage(a, channel(FRAME_CHANNEL_BYTE, encodeFrame(makeHeader(T1))));
		expect(b.frames().length).toBe(1);
		// The audit recorded the canonical key, not the rotated-away one.
		expect(core.audit.entries().at(-1)?.entityId).toBe(T2);
	});

	it("a subscribe under the OLD token lands on the new channel during grace", () => {
		const { core } = makeCore();
		const a = new SyntheticClient();
		const late = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onOpen(late);
		core.handlers.onMessage(a, control({ op: "rotate", from: T1, to: T2 }));
		core.handlers.onMessage(late, control({ op: "subscribe", entityIds: [T1] }));
		core.handlers.onMessage(a, channel(FRAME_CHANNEL_BYTE, encodeFrame(makeHeader(T2))));
		expect(late.frames().length).toBe(1);
	});

	it("after grace expiry the old token is an unknown key", () => {
		const { core, clock } = makeCore(60_000);
		const a = new SyntheticClient();
		const b = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onOpen(b);
		core.handlers.onMessage(b, control({ op: "subscribe", entityIds: [T1] }));
		core.handlers.onMessage(a, control({ op: "rotate", from: T1, to: T2 }));
		clock.now += 60_001;
		core.handlers.onMessage(a, channel(FRAME_CHANNEL_BYTE, encodeFrame(makeHeader(T1))));
		expect(b.frames().length).toBe(0);
	});

	it("malformed rotate messages are ignored (no reply, no alias)", () => {
		const { core } = makeCore();
		const a = new SyntheticClient();
		const b = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onOpen(b);
		core.handlers.onMessage(b, control({ op: "subscribe", entityIds: [T1] }));
		for (const bad of [
			{ op: "rotate" },
			{ op: "rotate", from: T1 },
			{ op: "rotate", from: "", to: T2 },
			{ op: "rotate", from: T1, to: T1 },
			{ op: "rotate", from: 3, to: T2 },
		]) {
			core.handlers.onMessage(a, control(bad));
		}
		expect(a.controlReplies()).toEqual([]);
		core.handlers.onMessage(a, channel(FRAME_CHANNEL_BYTE, encodeFrame(makeHeader(T2))));
		expect(b.frames().length).toBe(0); // no alias was installed
	});
});
