/**
 * Stage 10.4 — relay-server connection-handler integration tests.
 *
 * The Bun.serve runtime is replaced by direct handler driving so the
 * tests run identically under any vitest environment. The server module
 * exposes `createRelayCore()` whose `handlers` field is the same surface
 * Bun.serve calls in production; we exercise it through synthetic
 * `ServerWebSocketLike` clients.
 *
 * Coverage focus: subscribe → frame → fan-out → no-echo path, bad-control
 * tolerance, bad-binary tolerance, drop-on-close cleanup, audit
 * payload-fence.
 */

import { describe, expect, it } from "vitest";
import { type ServerWebSocketLike, createRelayCore } from "./server";
import { PROTOCOL_VERSION, type RoutingHeader, WireKind } from "./wire";

const CONTROL_CHANNEL_BYTE = 0x00;
const FRAME_CHANNEL_BYTE = 0x01;

class SyntheticClient implements ServerWebSocketLike {
	data: { connId?: string } = {};
	received: Uint8Array[] = [];
	closed = false;

	send(data: Uint8Array | string): void {
		if (typeof data === "string") return;
		this.received.push(new Uint8Array(data));
	}

	close(): void {
		this.closed = true;
	}
}

function encodeFrame(opts: {
	header: RoutingHeader;
	sig?: Uint8Array;
	ciphertext?: Uint8Array;
}): Uint8Array {
	const sig = opts.sig ?? new Uint8Array(64);
	const ciphertext = opts.ciphertext ?? new Uint8Array([0x11, 0x22, 0x33]);
	const headerJson = JSON.stringify({
		v: opts.header.v,
		kind: opts.header.kind,
		entityId: opts.header.entityId,
		sender: opts.header.sender,
		seq: opts.header.seq,
		nonce: opts.header.nonce,
		ts: opts.header.ts,
	});
	const headerBytes = new TextEncoder().encode(headerJson);
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

function makeHeader(overrides: Partial<RoutingHeader> = {}): RoutingHeader {
	return {
		v: PROTOCOL_VERSION,
		kind: WireKind.Update,
		entityId: "ent_1",
		sender: "sender-1",
		seq: 1,
		nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		ts: 1_700_000_000_000,
		...overrides,
	};
}

function wrapFrame(frame: Uint8Array): Uint8Array {
	const out = new Uint8Array(1 + frame.length);
	out[0] = FRAME_CHANNEL_BYTE;
	out.set(frame, 1);
	return out;
}

function wrapControl(message: object): Uint8Array {
	const body = new TextEncoder().encode(JSON.stringify(message));
	const out = new Uint8Array(1 + body.length);
	out[0] = CONTROL_CHANNEL_BYTE;
	out.set(body, 1);
	return out;
}

describe("createRelayCore — connection handlers", () => {
	it("two clients connect, subscribe, frame round-trips with no echo", () => {
		const seq: string[] = ["c1", "c2"];
		const core = createRelayCore({
			mintConnId: () => seq.shift() ?? "fallback",
		});
		const a = new SyntheticClient();
		const b = new SyntheticClient();
		const aConn = core.handlers.onOpen(a);
		const bConn = core.handlers.onOpen(b);
		expect(aConn).toBe("c1");
		expect(bConn).toBe("c2");
		core.handlers.onMessage(a, wrapControl({ op: "subscribe", entityIds: ["ent_1"] }));
		core.handlers.onMessage(b, wrapControl({ op: "subscribe", entityIds: ["ent_1"] }));
		const frame = encodeFrame({ header: makeHeader() });
		core.handlers.onMessage(a, wrapFrame(frame));
		expect(a.received.length).toBe(0);
		expect(b.received.length).toBe(1);
		const inbound = b.received[0];
		expect(inbound?.[0]).toBe(FRAME_CHANNEL_BYTE);
		expect(inbound?.subarray(1)).toEqual(frame);
	});

	it("a bundle-advertising subscribe (10.10 new client) still subscribes on this old node", () => {
		// Forward-compat pin: the 10.10 client adds `bundle:true` to every
		// subscribe. An old node (this test relay, and any pre-10.10
		// brainstorm-sync) must ignore the unknown field and subscribe normally —
		// that IS the fallback path (per-frame backfill, live fan-out unchanged).
		const seq: string[] = ["c1", "c2"];
		const core = createRelayCore({ mintConnId: () => seq.shift() ?? "fallback" });
		const a = new SyntheticClient();
		const b = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onOpen(b);
		core.handlers.onMessage(a, wrapControl({ op: "subscribe", entityIds: ["ent_1"] }));
		core.handlers.onMessage(b, wrapControl({ op: "subscribe", entityIds: ["ent_1"], bundle: true }));
		const frame = encodeFrame({ header: makeHeader() });
		core.handlers.onMessage(a, wrapFrame(frame));
		expect(b.received.length).toBe(1);
		expect(b.received[0]?.[0]).toBe(FRAME_CHANNEL_BYTE);
	});

	it("malformed control message is dropped without killing the connection", () => {
		const core = createRelayCore({ mintConnId: () => "c1" });
		const a = new SyntheticClient();
		core.handlers.onOpen(a);
		// Garbage JSON
		core.handlers.onMessage(a, new Uint8Array([CONTROL_CHANNEL_BYTE, 0x7b, 0x7b]));
		// op missing
		core.handlers.onMessage(a, wrapControl({ entityIds: ["e1"] }));
		// non-array entityIds
		core.handlers.onMessage(a, wrapControl({ op: "subscribe", entityIds: "e1" }));
		expect(a.closed).toBe(false);
		expect(core.router.subscriberCount("ent_1")).toBe(0);
	});

	it("malformed binary frame is dropped without killing the connection", () => {
		const seq: string[] = ["c1", "c2"];
		const core = createRelayCore({ mintConnId: () => seq.shift() ?? "fallback" });
		const a = new SyntheticClient();
		const b = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onOpen(b);
		core.handlers.onMessage(b, wrapControl({ op: "subscribe", entityIds: ["ent_1"] }));
		// Send a non-frame buffer with the channel byte stamped
		const bogus = new Uint8Array([FRAME_CHANNEL_BYTE, 0xff, 0xff, 0xff]);
		core.handlers.onMessage(a, bogus);
		expect(a.closed).toBe(false);
		expect(b.received.length).toBe(0);
		expect(core.router.malformedDropped()).toBe(1);
	});

	it("onClose removes the connection from the router + connections map", () => {
		const seq = ["c1", "c2"];
		const core = createRelayCore({ mintConnId: () => seq.shift() ?? "fallback" });
		const a = new SyntheticClient();
		const b = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onOpen(b);
		core.handlers.onMessage(a, wrapControl({ op: "subscribe", entityIds: ["ent_1"] }));
		core.handlers.onMessage(b, wrapControl({ op: "subscribe", entityIds: ["ent_1"] }));
		expect(core.router.subscriberCount("ent_1")).toBe(2);
		core.handlers.onClose(a);
		expect(core.router.subscriberCount("ent_1")).toBe(1);
		expect(core.connections.has("c1")).toBe(false);
	});

	it("control: unsubscribe stops fan-out to that connection", () => {
		const seq = ["c1", "c2"];
		const core = createRelayCore({ mintConnId: () => seq.shift() ?? "fallback" });
		const a = new SyntheticClient();
		const b = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onOpen(b);
		core.handlers.onMessage(b, wrapControl({ op: "subscribe", entityIds: ["ent_1"] }));
		core.handlers.onMessage(b, wrapControl({ op: "unsubscribe", entityIds: ["ent_1"] }));
		core.handlers.onMessage(a, wrapFrame(encodeFrame({ header: makeHeader() })));
		expect(b.received.length).toBe(0);
	});

	it("unknown channel byte is dropped silently", () => {
		const core = createRelayCore({ mintConnId: () => "c1" });
		const a = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onMessage(a, new Uint8Array([0x09, 1, 2, 3]));
		expect(a.closed).toBe(false);
	});

	it("audit-log records each delivered frame; entries never contain payload bytes", () => {
		const seq = ["c1", "c2"];
		const core = createRelayCore({ mintConnId: () => seq.shift() ?? "fallback", now: () => 100 });
		const a = new SyntheticClient();
		const b = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onOpen(b);
		core.handlers.onMessage(b, wrapControl({ op: "subscribe", entityIds: ["ent_1"] }));
		const ciphertext = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const frame = encodeFrame({ header: makeHeader(), ciphertext });
		core.handlers.onMessage(a, wrapFrame(frame));
		const entries = core.audit.entries();
		expect(entries.length).toBe(1);
		const jsonl = core.audit.toJSONL();
		// Ciphertext byte sequence "DE AD BE EF" must never appear in the audit log.
		expect(jsonl).not.toMatch(/deadbeef/i);
		// And the entry shape pinned exactly.
		expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
			"bytes",
			"entityId",
			"fromConnId",
			"kind",
			"toConnId",
			"ts",
		]);
	});

	it("string message body is dropped (binary-only wire)", () => {
		const core = createRelayCore({ mintConnId: () => "c1" });
		const a = new SyntheticClient();
		core.handlers.onOpen(a);
		core.handlers.onMessage(a, "hello");
		expect(a.closed).toBe(false);
		expect(core.audit.entries().length).toBe(0);
	});
});
