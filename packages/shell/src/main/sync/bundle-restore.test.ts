/**
 * 10.10 — client-side proof that a BUNDLED backfill applies identically to the
 * per-frame stream, over the real transport + crypto path:
 *
 *   real WebSocketRelayPort (fake socket) → LiveSyncEngine → envelope
 *   pipeline (real Ed25519 + XChaCha, DEK opened per frame) → Y.Doc.
 *
 * The same encrypted frames a durable node would replay are delivered once as
 * N separate `0x01` messages and once as ONE `0x03` bundle; the resulting docs
 * must converge to the same state. Also covers the true bootstrap shape: a
 * `WrapBootstrap` followed by a `Snapshot` inside a single bundle — the
 * in-bundle order must survive dispatch so the DEK installs before the state
 * applies (wraps-first is the node's contract).
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { XCHACHA_NONCE_BYTES, generateSymmetricKey } from "../credentials/crypto";
import { MEMBER_WRAP_ALG, MEMBER_WRAP_VERSION } from "../credentials/member-wraps";
import type { EntityDekHandle, EntityDekStore } from "../entities/entity-dek-store";
import { ed25519 } from "../test-support/crypto-test-helpers";
import {
	type PipelineContext,
	emitSnapshot,
	emitWrapBootstrap,
	encryptAndEmit,
} from "./envelope-pipeline";
import { LiveSyncEngine, type LiveSyncEngineContext } from "./live-sync-engine";
import type { RelayPort, RelaySurface } from "./relay-port";
import {
	BUNDLE_CHANNEL_BYTE,
	WebSocketRelayPort,
	encodeBundlePayload,
	wrapBinaryFrame,
} from "./websocket-relay-port";

const ENT = "ent_bundle_restore";
const TYPE = "brainstorm/Note/v1";
const OPEN_READY_STATE = 1;

class FakeDekStore {
	private readonly deks = new Map<string, Uint8Array>();
	mint(entityId: string): void {
		this.deks.set(entityId, generateSymmetricKey());
	}
	seedFrom(other: FakeDekStore, entityId: string): void {
		const dek = other.deks.get(entityId);
		if (dek) this.deks.set(entityId, new Uint8Array(dek));
	}
	nextDekId(): string {
		return `dek_${this.deks.size}`;
	}
	open(entityId: string): EntityDekHandle | null {
		const dek = this.deks.get(entityId);
		if (!dek) return null;
		return { dekId: "dek-id", dek: new Uint8Array(dek), version: 1 };
	}
	close(dek: Uint8Array): void {
		dek.fill(0);
	}
}

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readonly url: string;
	readyState = 0;
	sent: Uint8Array[] = [];
	binaryType: string | undefined = undefined;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}
	send(data: Uint8Array): void {
		this.sent.push(new Uint8Array(data));
	}
	close(): void {
		this.readyState = 3;
	}
	open(): void {
		this.readyState = OPEN_READY_STATE;
		this.onopen?.();
	}
	deliver(bytes: Uint8Array): void {
		this.onmessage?.({ data: bytes });
	}
}

function randomNonce(): Uint8Array {
	const n = new Uint8Array(XCHACHA_NONCE_BYTES);
	crypto.getRandomValues(n);
	return n;
}

/** Producer-side pipeline context whose `relay.send` captures raw frames —
 *  the exact bytes a durable node would store and replay in backfill. */
function makeProducer(dekStore: FakeDekStore): {
	ctx: PipelineContext;
	frames: Uint8Array[];
} {
	const pair = ed25519.keygen();
	const frames: Uint8Array[] = [];
	const capturePort: RelayPort = {
		send: (frame) => {
			frames.push(new Uint8Array(frame));
		},
		onFrame: () => {},
		offFrame: () => {},
		close: () => {},
	};
	let seq = 0;
	const ctx: PipelineContext = {
		dekStore: dekStore as unknown as EntityDekStore,
		devicePub: new Uint8Array(pair.publicKey),
		deviceSign: (bytes) => new Uint8Array(ed25519.sign(bytes, pair.secretKey)),
		deviceVerify: (sig, bytes, senderPub) => {
			try {
				return ed25519.verify(sig, bytes, senderPub);
			} catch {
				return false;
			}
		},
		resolveEntity: () => ({ id: ENT, type: TYPE }),
		relay: capturePort,
		nextSeq: () => {
			seq += 1;
			return seq - 1;
		},
		nowMs: () => 1700000000000,
		randomNonce,
	};
	return { ctx, frames };
}

/** A receiving device over the REAL WebSocketRelayPort (fake socket). */
function makeReceiver(
	dekStore: FakeDekStore,
	overrides: Partial<LiveSyncEngineContext> = {},
): { engine: LiveSyncEngine; doc: Y.Doc; ws: FakeWebSocket; port: WebSocketRelayPort } {
	const pair = ed25519.keygen();
	const doc = new Y.Doc();
	const before = FakeWebSocket.instances.length;
	const port = new WebSocketRelayPort({
		url: "ws://durable-node",
		wsImpl: FakeWebSocket as unknown as new (url: string) => FakeWebSocket,
	});
	port.connect();
	const ws = FakeWebSocket.instances[before];
	if (!ws) throw new Error("no fake socket minted");
	ws.open();
	const surface: RelaySurface = {
		currentPort: () => port,
		onFrame: (cb) => port.onFrame(cb),
		offFrame: (cb) => port.offFrame(cb),
		subscribe: (key) => port.subscribe(key),
		unsubscribe: (key) => port.unsubscribe(key),
		subscribeBatch: (keys) => port.subscribeBatch(keys),
	};
	const engine = new LiveSyncEngine({
		getRelay: () => surface,
		dekStore: dekStore as unknown as EntityDekStore,
		devicePub: new Uint8Array(pair.publicKey),
		deviceSign: (bytes) => new Uint8Array(ed25519.sign(bytes, pair.secretKey)),
		deviceVerify: (sig, bytes, senderPub) => {
			try {
				return ed25519.verify(sig, bytes, senderPub);
			} catch {
				return false;
			}
		},
		resolveEntityType: () => null,
		isShared: async () => true,
		applyRemoteUpdate: async (_id, _type, update) => {
			Y.applyUpdate(doc, update, "remote");
		},
		nowMs: () => 1700000000000,
		randomNonce,
		...overrides,
	});
	return { engine, doc, ws, port };
}

function bundleWire(frames: Uint8Array[]): Uint8Array {
	const payload = encodeBundlePayload(frames);
	if (!payload) throw new Error("empty bundle");
	const wire = new Uint8Array(1 + payload.length);
	wire[0] = BUNDLE_CHANNEL_BYTE;
	wire.set(payload, 1);
	return wire;
}

describe("bundled backfill applies identically to the per-frame stream (10.10)", () => {
	it("one 0x03 bundle converges the doc to the same state as N 0x01 messages", async () => {
		// Producer: three real encrypted Update frames (what the node replays).
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const { ctx, frames } = makeProducer(dekA);
		const docA = new Y.Doc();
		const updates: Uint8Array[] = [];
		docA.on("update", (u: Uint8Array) => updates.push(new Uint8Array(u)));
		docA.getText("body").insert(0, "Hel");
		docA.getText("body").insert(3, "lo ");
		docA.getText("body").insert(6, "world");
		for (const update of updates) await encryptAndEmit(ENT, update, ctx);
		expect(frames.length).toBe(3);

		// Receiver 1 — the old per-frame stream: three WebSocket messages.
		const dek1 = new FakeDekStore();
		dek1.seedFrom(dekA, ENT);
		const r1 = makeReceiver(dek1);
		await r1.engine.trackOpen(ENT, TYPE);
		for (const frame of frames) r1.ws.deliver(wrapBinaryFrame(frame));
		await r1.engine.whenIdle();

		// Receiver 2 — the same frames in ONE bundle message.
		const dek2 = new FakeDekStore();
		dek2.seedFrom(dekA, ENT);
		const r2 = makeReceiver(dek2);
		await r2.engine.trackOpen(ENT, TYPE);
		r2.ws.deliver(bundleWire(frames));
		await r2.engine.whenIdle();

		expect(r1.doc.getText("body").toString()).toBe("Hello world");
		expect(r2.doc.getText("body").toString()).toBe("Hello world");
		expect(Y.encodeStateVector(r2.doc)).toEqual(Y.encodeStateVector(r1.doc));

		r1.engine.dispose();
		r2.engine.dispose();
		r1.port.close();
		r2.port.close();
	});

	it("a wrap-then-snapshot bundle restores in order: DEK installs before the state applies", async () => {
		// Producer: a WrapBootstrap frame followed by a full-state Snapshot frame
		// — the node's wraps-first backfill contract, packed into ONE bundle.
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const { ctx, frames } = makeProducer(dekA);
		await emitWrapBootstrap(
			ENT,
			{
				v: MEMBER_WRAP_VERSION,
				version: 1,
				alg: MEMBER_WRAP_ALG,
				recipientPubB64: "cmVjaXBpZW50",
				encB64: "ZW5j",
				ctB64: "Y3Q",
			} as never,
			ctx,
		);
		const docA = new Y.Doc();
		docA.getText("body").insert(0, "restored state");
		await emitSnapshot(ENT, Y.encodeStateAsUpdate(docA), ctx);
		expect(frames.length).toBe(2);

		// Cold device: no DEK until installWrap fires (the wiring recovers it —
		// stubbed here to seed the store, exactly like live-sync-engine.test.ts).
		const dekB = new FakeDekStore();
		const installs: string[] = [];
		const r = makeReceiver(dekB, {
			installWrap: async (_wrap, id) => {
				installs.push(id);
				dekB.seedFrom(dekA, ENT);
				return TYPE;
			},
		});
		r.engine.trackForRestoreBatch([ENT]);
		expect(r.engine.restoredType(ENT)).toBeNull();

		// The node answers the bundle-advertising subscribe with ONE message.
		r.ws.deliver(bundleWire(frames));
		await r.engine.whenIdle();

		expect(installs).toEqual([ENT]);
		expect(r.engine.restoredType(ENT)).toBe(TYPE);
		expect(r.doc.getText("body").toString()).toBe("restored state");

		r.engine.dispose();
		r.port.close();
	});
});
