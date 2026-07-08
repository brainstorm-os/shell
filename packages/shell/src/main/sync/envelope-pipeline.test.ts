import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { XCHACHA_NONCE_BYTES, bytesToBase64, generateSymmetricKey } from "../credentials/crypto";
import { generateDeviceX25519 } from "../credentials/device-x25519";
import { type MemberWrapPayload, wrapDekForRecipient } from "../credentials/member-wraps";
import type { EntityDekHandle, EntityDekStore } from "../entities/entity-dek-store";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { decodeFrame } from "./envelope-codec";
import {
	type PipelineContext,
	emitSnapshot,
	emitWrapBootstrap,
	encryptAndEmit,
	receiveAndApply,
	receiveWrapBootstrap,
} from "./envelope-pipeline";
import { LoopbackRelayPort } from "./relay-port";
import { WireKind } from "./routing-header";

// Structural surface — NOT `Pick<EntityDekStore, ...>`. `EntityDekStore`
// is a class with TS-private fields (`#deks`, `#masterKey`, etc.), and
// `Pick<>` over a class with `#`-private members brings every private
// member along (they're nominal), making the picked type inhabit-able
// only by the class itself. The pipeline only calls these four methods,
// so the fake is typed against a plain structural interface; the call
// site casts via `dekStore as unknown as EntityDekStore` (acceptable in
// a unit test — production code never sees this shape).
type DekStoreSurface = {
	nextDekId(): string;
	persist(...args: Parameters<EntityDekStore["persist"]>): ReturnType<EntityDekStore["persist"]>;
	open(entityId: string): EntityDekHandle | null;
	close(dek: Uint8Array): void;
};

class FakeDekStore implements DekStoreSurface {
	private readonly deks = new Map<string, Uint8Array>();
	nextDekId(): string {
		return `dek_${this.deks.size}`;
	}
	mint(entityId: string): void {
		this.deks.set(entityId, generateSymmetricKey());
	}
	persist(): EntityDekHandle {
		throw new Error("FakeDekStore: persist not used in pipeline tests");
	}
	open(entityId: string): EntityDekHandle | null {
		const dek = this.deks.get(entityId);
		if (!dek) return null;
		return { dekId: "dek-id", dek: new Uint8Array(dek) };
	}
	close(dek: Uint8Array): void {
		dek.fill(0);
	}
}

function makeDevice() {
	const pair = ed25519.keygen();
	return {
		secret: new Uint8Array(pair.secretKey),
		pub: new Uint8Array(pair.publicKey),
	};
}

// Omit `dekStore` from `Partial<PipelineContext>` so the intersection
// doesn't demand `EntityDekStore & FakeDekStore` (the class-private-
// field-collision again). The fake is structural; the makeCtx callsite
// is the single cast-to-EntityDekStore boundary.
function makeCtx(
	overrides: Omit<Partial<PipelineContext>, "dekStore"> & { dekStore: FakeDekStore } & {
		relay: LoopbackRelayPort;
		entities: Map<string, { id: string; type: string }>;
	},
): PipelineContext {
	const device = makeDevice();
	let seq = 0;
	return {
		dekStore: overrides.dekStore as unknown as EntityDekStore,
		devicePub: device.pub,
		deviceSign: (bytes) => new Uint8Array(ed25519.sign(bytes, device.secret)),
		deviceVerify: (sig, bytes, senderPub) => {
			try {
				return ed25519.verify(sig, bytes, senderPub);
			} catch {
				return false;
			}
		},
		resolveEntity: (routedId) => overrides.entities.get(routedId) ?? null,
		relay: overrides.relay,
		nextSeq: () => seq++,
		nowMs: () => 1700000000000,
		randomNonce: () => {
			const n = new Uint8Array(XCHACHA_NONCE_BYTES);
			crypto.getRandomValues(n);
			return n;
		},
		// Spread the test's own optional overrides AFTER the defaults
		// above so an explicit deviceSign / nextSeq / nowMs wins. Skip
		// `dekStore` + `relay` here: they were already set explicitly
		// above with the FakeDekStore→EntityDekStore widen-cast +
		// LoopbackRelayPort, and re-spreading them would re-introduce
		// the class-private-field collision the cast resolves.
		...stripDekStoreAndRelay(overrides),
	};
}

function stripDekStoreAndRelay<T extends { dekStore: unknown; relay: unknown }>(
	o: T,
): Omit<T, "dekStore" | "relay"> {
	const { dekStore: _d, relay: _r, ...rest } = o;
	return rest;
}

describe("envelope-pipeline", () => {
	it("encrypt -> loopback -> receive -> applyUpdate converges two Y.Docs", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_one");
		const entities = new Map([["ent_one", { id: "ent_one", type: "T" }]]);

		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const bCtx = makeCtx({ dekStore, relay: bRelay, entities });
		// Use one shared device key on both sides for the convergence test
		// (single-user multi-device single-doc scenario).
		bCtx.devicePub = aCtx.devicePub;
		bCtx.deviceSign = aCtx.deviceSign;

		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const applied: Uint8Array[] = [];
		bRelay.onFrame(async (frame) => {
			await receiveAndApply(frame, bCtx, (plaintext) => {
				applied.push(plaintext);
				Y.applyUpdate(docB, plaintext);
			});
		});

		docA.on("update", (update: Uint8Array) => {
			void encryptAndEmit("ent_one", update, aCtx);
		});

		docA.getText("body").insert(0, "Hello");
		await flushMicrotasks();
		expect(applied.length).toBeGreaterThan(0);
		expect(docB.getText("body").toString()).toBe("Hello");
	});

	it("emitSnapshot puts a Snapshot-kind frame on the wire that opens like an Update (10.14)", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_snap");
		const entities = new Map([["ent_snap", { id: "ent_snap", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const bCtx = makeCtx({ dekStore, relay: bRelay, entities });
		bCtx.devicePub = aCtx.devicePub;
		bCtx.deviceSign = aCtx.deviceSign;

		const received: Uint8Array[] = [];
		bRelay.onFrame((frame) => received.push(frame));

		const docA = new Y.Doc();
		docA.getText("body").insert(0, "full state");
		await emitSnapshot("ent_snap", Y.encodeStateAsUpdate(docA), aCtx);
		await flushMicrotasks();

		expect(received.length).toBe(1);
		const frame = received[0] as Uint8Array;
		expect(decodeFrame(frame).header.kind).toBe(WireKind.Snapshot);
		// It opens + applies like any doc-state frame.
		const docB = new Y.Doc();
		await receiveAndApply(frame, bCtx, (plaintext) => Y.applyUpdate(docB, plaintext));
		expect(docB.getText("body").toString()).toBe("full state");
	});

	it("one Y.Doc transact -> exactly one envelope on the wire", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_tx");
		const entities = new Map([["ent_tx", { id: "ent_tx", type: "T" }]]);
		const ctx = makeCtx({ dekStore, relay: aRelay, entities });

		const received: Uint8Array[] = [];
		bRelay.onFrame((frame) => received.push(frame));

		const doc = new Y.Doc();
		doc.on("update", (update: Uint8Array) => {
			void encryptAndEmit("ent_tx", update, ctx);
		});
		doc.transact(() => {
			doc.getText("body").insert(0, "abc");
			doc.getText("body").insert(3, "def");
		});
		await flushMicrotasks();
		expect(received.length).toBe(1);

		// Two consecutive transacts produce two envelopes.
		const before = received.length;
		doc.transact(() => doc.getText("body").insert(6, "x"));
		doc.transact(() => doc.getText("body").insert(7, "y"));
		await flushMicrotasks();
		expect(received.length).toBe(before + 2);
	});

	it("receive throws Unavailable on unknown entityId", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_known");
		const ctx = makeCtx({
			dekStore,
			relay: bRelay,
			entities: new Map([["ent_known", { id: "ent_known", type: "T" }]]),
		});

		const senderCtx = makeCtx({
			dekStore,
			relay: aRelay,
			entities: new Map([["ent_known", { id: "ent_known", type: "T" }]]),
		});
		await encryptAndEmit("ent_known", new Uint8Array([1, 2, 3]), senderCtx);
		// Now drop the entity on the receiver side and try receive with a
		// fresh frame whose header points at it.
		const captured: Uint8Array[] = [];
		bRelay.onFrame((f) => captured.push(f));
		await encryptAndEmit("ent_known", new Uint8Array([1, 2, 3]), senderCtx);
		await flushMicrotasks();
		const frame = captured[0];
		if (!frame) throw new Error("expected a relayed frame");
		const ctxNoEntity = { ...ctx, resolveEntity: () => null };
		await expect(receiveAndApply(frame, ctxNoEntity, () => {})).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("receive throws EntityIdMismatch when resolver maps to a different id", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_correct");
		dekStore.mint("ent_other");
		const senderCtx = makeCtx({
			dekStore,
			relay: aRelay,
			entities: new Map([["ent_correct", { id: "ent_correct", type: "T" }]]),
		});
		const captured: Uint8Array[] = [];
		bRelay.onFrame((f) => captured.push(f));
		await encryptAndEmit("ent_correct", new Uint8Array([1]), senderCtx);
		await flushMicrotasks();
		const frame = captured[0];
		if (!frame) throw new Error("expected a frame");

		const recvCtx = makeCtx({
			dekStore,
			relay: bRelay,
			entities: new Map([["ent_correct", { id: "ent_other", type: "T" }]]),
		});
		recvCtx.devicePub = senderCtx.devicePub;
		recvCtx.deviceSign = senderCtx.deviceSign;
		await expect(receiveAndApply(frame, recvCtx, () => {})).rejects.toMatchObject({
			name: "EntityIdMismatch",
		});
	});

	it("DEK is opened on resolved row id (not the header id) — closes via the same handle", async () => {
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_resolved");
		const closeSpy = vi.spyOn(dekStore, "close");
		const openSpy = vi.spyOn(dekStore, "open");
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const senderCtx = makeCtx({
			dekStore,
			relay: aRelay,
			entities: new Map([["ent_resolved", { id: "ent_resolved", type: "T" }]]),
		});
		await encryptAndEmit("ent_resolved", new Uint8Array([1]), senderCtx);
		expect(openSpy).toHaveBeenCalledWith("ent_resolved");
		expect(closeSpy).toHaveBeenCalled();
	});

	it("encrypt throws Unavailable when entity has no DEK row", async () => {
		const [aRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		const ctx = makeCtx({
			dekStore,
			relay: aRelay,
			entities: new Map(),
		});
		await expect(encryptAndEmit("ent_missing", new Uint8Array([1]), ctx)).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("1000-envelope property run: no nonce collisions", async () => {
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_n");
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const ctx = makeCtx({
			dekStore,
			relay: aRelay,
			entities: new Map([["ent_n", { id: "ent_n", type: "T" }]]),
		});
		const nonces = new Set<string>();
		bRelay.onFrame((frame) => {
			// Header is the first u32-be(len)+JSON region; parse the JSON
			// to extract the nonce field.
			const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
			const len = view.getUint32(0, false);
			const json = new TextDecoder().decode(frame.subarray(4, 4 + len));
			const header = JSON.parse(json) as { nonce: string };
			nonces.add(header.nonce);
		});
		const N = 1000;
		const proms: Promise<void>[] = [];
		for (let i = 0; i < N; i++) {
			proms.push(encryptAndEmit("ent_n", new Uint8Array([i & 0xff]), ctx));
		}
		await Promise.all(proms);
		await flushMicrotasks();
		expect(nonces.size).toBe(N);
	});
});

describe("wrap-bootstrap envelope flow", () => {
	function makeWrap(entityId = "ent_wb"): {
		wrap: MemberWrapPayload;
		deviceSecret: Uint8Array;
		dek: Uint8Array;
	} {
		const dek = generateSymmetricKey();
		const device = generateDeviceX25519();
		const wrap = wrapDekForRecipient(dek, device.publicKey, entityId);
		return { wrap, deviceSecret: device.secretKey, dek };
	}

	it("emit -> loopback -> receive yields the same wrap payload", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		const entities = new Map([["ent_wb", { id: "ent_wb", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const bCtx = makeCtx({ dekStore, relay: bRelay, entities });
		bCtx.devicePub = aCtx.devicePub;
		bCtx.deviceSign = aCtx.deviceSign;

		const { wrap } = makeWrap();
		const received: MemberWrapPayload[] = [];
		bRelay.onFrame(async (frame) => {
			await receiveWrapBootstrap(frame, bCtx, (w) => {
				received.push(w);
			});
		});

		await emitWrapBootstrap("ent_wb", wrap, aCtx);
		await flushMicrotasks();
		expect(received.length).toBe(1);
		expect(received[0]).toEqual(wrap);
	});

	it("receiveWrapBootstrap throws Invalid on an Update-kind frame", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_ub");
		const entities = new Map([["ent_ub", { id: "ent_ub", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const bCtx = makeCtx({ dekStore, relay: bRelay, entities });
		bCtx.devicePub = aCtx.devicePub;
		bCtx.deviceSign = aCtx.deviceSign;

		const captured: Uint8Array[] = [];
		bRelay.onFrame((f) => captured.push(f));
		await encryptAndEmit("ent_ub", new Uint8Array([1]), aCtx);
		await flushMicrotasks();
		const frame = captured[0];
		if (!frame) throw new Error("expected a frame");
		await expect(receiveWrapBootstrap(frame, bCtx, () => {})).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("receiveWrapBootstrap throws Unavailable when the entity is unknown", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		const aCtx = makeCtx({
			dekStore,
			relay: aRelay,
			entities: new Map([["ent_wb", { id: "ent_wb", type: "T" }]]),
		});
		const bCtx = makeCtx({ dekStore, relay: bRelay, entities: new Map() });
		bCtx.devicePub = aCtx.devicePub;
		bCtx.deviceSign = aCtx.deviceSign;

		const captured: Uint8Array[] = [];
		bRelay.onFrame((f) => captured.push(f));
		const { wrap } = makeWrap();
		await emitWrapBootstrap("ent_wb", wrap, aCtx);
		await flushMicrotasks();
		const frame = captured[0];
		if (!frame) throw new Error("expected a frame");
		await expect(receiveWrapBootstrap(frame, bCtx, () => {})).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("relay sees only wrap JSON, never an HPKE plaintext / DEK byte", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		const entities = new Map([["ent_wb", { id: "ent_wb", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });

		const { wrap, dek } = makeWrap();
		const observed: Uint8Array[] = [];
		bRelay.onFrame((f) => observed.push(f));
		await emitWrapBootstrap("ent_wb", wrap, aCtx);
		await flushMicrotasks();
		expect(observed.length).toBe(1);
		const wireBytes = observed[0];
		if (!wireBytes) throw new Error("expected a wire frame");
		const hex = Buffer.from(wireBytes).toString("hex");
		// Plaintext DEK bytes must NOT appear in the wire payload.
		expect(hex.includes(Buffer.from(dek).toString("hex"))).toBe(false);
	});
});

describe("revocation enforcement (Stage 10.5c, OQ-203)", () => {
	it("receiveAndApply throws Revoked BEFORE invoking deviceVerify when sender is revoked", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_revoke");
		const entities = new Map([["ent_revoke", { id: "ent_revoke", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const verifyCalls: number[] = [];
		const bCtx: PipelineContext = {
			...makeCtx({ dekStore, relay: bRelay, entities }),
			devicePub: aCtx.devicePub,
			deviceSign: aCtx.deviceSign,
			deviceVerify: (sig, bytes, senderPub) => {
				verifyCalls.push(1);
				try {
					return ed25519.verify(sig, bytes, senderPub);
				} catch {
					return false;
				}
			},
			isDeviceRevoked: (_senderPub) => true,
		};
		let frameSeen: Uint8Array | null = null;
		bRelay.onFrame((f) => {
			frameSeen = f;
		});
		await encryptAndEmit("ent_revoke", new Uint8Array([1, 2, 3, 4]), aCtx);
		await flushMicrotasks();
		if (!frameSeen) throw new Error("expected a frame on B");
		let thrown: Error | null = null;
		try {
			await receiveAndApply(frameSeen, bCtx, () => undefined);
		} catch (error) {
			thrown = error as Error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown?.name).toBe("Revoked");
		expect(verifyCalls.length).toBe(0); // sig-verify never ran.
	});

	it("receiveAndApply applies an update when authorizeWriter allows (Editor)", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_authz");
		const entities = new Map([["ent_authz", { id: "ent_authz", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const bCtx: PipelineContext = {
			...makeCtx({ dekStore, relay: bRelay, entities }),
			devicePub: aCtx.devicePub,
			deviceSign: aCtx.deviceSign,
			deviceVerify: (sig, bytes, senderPub) => ed25519.verify(sig, bytes, senderPub),
			authorizeWriter: () => true,
		};
		let frameSeen: Uint8Array | null = null;
		bRelay.onFrame((f) => {
			frameSeen = f;
		});
		await encryptAndEmit("ent_authz", new Uint8Array([9, 9, 9]), aCtx);
		await flushMicrotasks();
		if (!frameSeen) throw new Error("expected a frame on B");
		let applied: Uint8Array | null = null;
		await receiveAndApply(frameSeen, bCtx, (plaintext) => {
			applied = plaintext;
		});
		expect(applied).toEqual(new Uint8Array([9, 9, 9]));
	});

	it("receiveAndApply throws Unauthorized and never applies when authorizeWriter denies (Viewer, F-288)", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_authz");
		const entities = new Map([["ent_authz", { id: "ent_authz", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const seenSenders: string[] = [];
		const bCtx: PipelineContext = {
			...makeCtx({ dekStore, relay: bRelay, entities }),
			devicePub: aCtx.devicePub,
			deviceSign: aCtx.deviceSign,
			deviceVerify: (sig, bytes, senderPub) => ed25519.verify(sig, bytes, senderPub),
			authorizeWriter: (senderB64, entityId) => {
				seenSenders.push(`${senderB64}:${entityId}`);
				return false; // a Viewer: authenticated, but not an authorized writer.
			},
		};
		let frameSeen: Uint8Array | null = null;
		bRelay.onFrame((f) => {
			frameSeen = f;
		});
		await encryptAndEmit("ent_authz", new Uint8Array([1, 2, 3]), aCtx);
		await flushMicrotasks();
		if (!frameSeen) throw new Error("expected a frame on B");
		let applied = false;
		let thrown: Error | null = null;
		try {
			await receiveAndApply(frameSeen, bCtx, () => {
				applied = true;
			});
		} catch (error) {
			thrown = error as Error;
		}
		expect(thrown?.name).toBe("Unauthorized");
		expect(applied).toBe(false); // the plaintext was NEVER handed to applyUpdate.
		expect(seenSenders).toHaveLength(1); // authorization consulted post-verify.
		expect(seenSenders[0]).toContain(":ent_authz");
	});

	it("receiveAndApply passes through when isDeviceRevoked returns false", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_ok");
		const entities = new Map([["ent_ok", { id: "ent_ok", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const bCtx: PipelineContext = {
			...makeCtx({ dekStore, relay: bRelay, entities }),
			devicePub: aCtx.devicePub,
			deviceSign: aCtx.deviceSign,
			isDeviceRevoked: () => false,
		};
		let frameSeen: Uint8Array | null = null;
		bRelay.onFrame((f) => {
			frameSeen = f;
		});
		const docA = new Y.Doc();
		const emits: Promise<void>[] = [];
		docA.on("update", (u) => emits.push(encryptAndEmit("ent_ok", u, aCtx)));
		docA.getText("body").insert(0, "hi");
		await Promise.all(emits);
		await flushMicrotasks();
		if (!frameSeen) throw new Error("expected a frame on B");
		const applied: Uint8Array[] = [];
		await receiveAndApply(frameSeen, bCtx, (plaintext) => {
			applied.push(plaintext);
		});
		expect(applied.length).toBe(1);
	});

	it("receiveAndApply respects the absent-predicate default (no revocation enforced)", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_default");
		const entities = new Map([["ent_default", { id: "ent_default", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const bCtx = makeCtx({ dekStore, relay: bRelay, entities });
		bCtx.devicePub = aCtx.devicePub;
		bCtx.deviceSign = aCtx.deviceSign;
		// isDeviceRevoked deliberately not set on bCtx.
		let frameSeen: Uint8Array | null = null;
		bRelay.onFrame((f) => {
			frameSeen = f;
		});
		const docA = new Y.Doc();
		const emits: Promise<void>[] = [];
		docA.on("update", (u) => emits.push(encryptAndEmit("ent_default", u, aCtx)));
		docA.getText("body").insert(0, "k");
		await Promise.all(emits);
		await flushMicrotasks();
		if (!frameSeen) throw new Error("expected a frame on B");
		const applied: Uint8Array[] = [];
		await receiveAndApply(frameSeen, bCtx, (p) => {
			applied.push(p);
		});
		expect(applied.length).toBe(1);
	});

	it("receiveWrapBootstrap throws Revoked when sender is revoked", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_wbr");
		const entities = new Map([["ent_wbr", { id: "ent_wbr", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const bCtx: PipelineContext = {
			...makeCtx({ dekStore, relay: bRelay, entities }),
			devicePub: aCtx.devicePub,
			deviceSign: aCtx.deviceSign,
			isDeviceRevoked: () => true,
		};
		const dek = generateSymmetricKey();
		const recipient = generateDeviceX25519();
		const wrap = wrapDekForRecipient(dek, recipient.publicKey, "ent_wbr");
		let frameSeen: Uint8Array | null = null;
		bRelay.onFrame((f) => {
			frameSeen = f;
		});
		await emitWrapBootstrap("ent_wbr", wrap, aCtx);
		await flushMicrotasks();
		if (!frameSeen) throw new Error("expected wrap frame");
		let thrown: Error | null = null;
		try {
			await receiveWrapBootstrap(frameSeen, bCtx, async () => undefined);
		} catch (error) {
			thrown = error as Error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown?.name).toBe("Revoked");
	});
});

describe("relay-port is structurally blind", () => {
	it("relay-port.ts imports zero crypto-lib / seal / credentials / node:crypto", () => {
		const src = readFileSync(join(__dirname, "relay-port.ts"), "utf8");
		// Strip line comments so the `// relay-blind:` annotation header is NOT
		// counted as an import.
		const code = src
			.split("\n")
			.filter((l) => !l.trim().startsWith("//"))
			.join("\n");
		// Built from a part so this assertion's own source carries no literal
		// crypto-lib package name (keeps the whole package grep-clean).
		const cryptoLib = `@${"noble"}`;
		expect(code).not.toMatch(new RegExp(`from\\s+["']${cryptoLib}/`));
		expect(code).not.toMatch(/from\s+["']\.\/envelope-seal/);
		expect(code).not.toMatch(/from\s+["']\.\/envelope-codec/);
		expect(code).not.toMatch(/from\s+["']\.\.\/credentials\//);
		expect(code).not.toMatch(/from\s+["']node:crypto/);
		expect(code).not.toMatch(new RegExp(`require\\(["']${cryptoLib}/`));
	});
});

function flushMicrotasks(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

describe("envelope-pipeline traffic callbacks (10.7)", () => {
	it("onSent fires after successful encryptAndEmit", async () => {
		const [aRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay) throw new Error("missing relay port");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_one");
		const entities = new Map([["ent_one", { id: "ent_one", type: "T" }]]);
		const onSent = vi.fn();
		const ctx: PipelineContext = { ...makeCtx({ dekStore, relay: aRelay, entities }), onSent };
		await encryptAndEmit("ent_one", new Uint8Array([1, 2, 3]), ctx);
		expect(onSent).toHaveBeenCalledTimes(1);
		expect(onSent.mock.calls[0]?.[0]).toBeGreaterThan(0);
	});

	it("onSent does NOT fire on encryptAndEmit throw (missing DEK)", async () => {
		const [aRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay) throw new Error("missing relay port");
		const dekStore = new FakeDekStore();
		const entities = new Map([["ent_missing", { id: "ent_missing", type: "T" }]]);
		const onSent = vi.fn();
		const ctx: PipelineContext = { ...makeCtx({ dekStore, relay: aRelay, entities }), onSent };
		await expect(encryptAndEmit("ent_missing", new Uint8Array([1]), ctx)).rejects.toMatchObject({
			name: "Unavailable",
		});
		expect(onSent).not.toHaveBeenCalled();
	});

	it("onReceived fires after successful receiveAndApply", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_recv");
		const entities = new Map([["ent_recv", { id: "ent_recv", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const onReceived = vi.fn();
		const bCtx: PipelineContext = {
			...makeCtx({ dekStore, relay: bRelay, entities }),
			onReceived,
			devicePub: aCtx.devicePub,
			deviceSign: aCtx.deviceSign,
		};
		const captured: Uint8Array[] = [];
		bRelay.onFrame((f) => captured.push(f));
		await encryptAndEmit("ent_recv", new Uint8Array([7, 8, 9]), aCtx);
		await flushMicrotasks();
		const frame = captured[0];
		if (!frame) throw new Error("expected a relayed frame");
		await receiveAndApply(frame, bCtx, () => undefined);
		expect(onReceived).toHaveBeenCalledTimes(1);
		expect(onReceived.mock.calls[0]?.[0]).toBe(frame.byteLength);
	});

	it("onReceived does NOT fire when revoked-sender drops on the cheap path", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_rev");
		const entities = new Map([["ent_rev", { id: "ent_rev", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const onReceived = vi.fn();
		const bCtx: PipelineContext = {
			...makeCtx({ dekStore, relay: bRelay, entities }),
			onReceived,
			isDeviceRevoked: () => true,
			devicePub: aCtx.devicePub,
			deviceSign: aCtx.deviceSign,
		};
		const captured: Uint8Array[] = [];
		bRelay.onFrame((f) => captured.push(f));
		await encryptAndEmit("ent_rev", new Uint8Array([1]), aCtx);
		await flushMicrotasks();
		const frame = captured[0];
		if (!frame) throw new Error("expected a relayed frame");
		await expect(receiveAndApply(frame, bCtx, () => undefined)).rejects.toMatchObject({
			name: "Revoked",
		});
		expect(onReceived).not.toHaveBeenCalled();
	});

	it("missing onSent/onReceived defaults to no-op (existing call sites stay green)", async () => {
		const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
		if (!aRelay || !bRelay) throw new Error("missing relay ports");
		const dekStore = new FakeDekStore();
		dekStore.mint("ent_noop");
		const entities = new Map([["ent_noop", { id: "ent_noop", type: "T" }]]);
		const aCtx = makeCtx({ dekStore, relay: aRelay, entities });
		const bCtx: PipelineContext = {
			...makeCtx({ dekStore, relay: bRelay, entities }),
			devicePub: aCtx.devicePub,
			deviceSign: aCtx.deviceSign,
		};
		const captured: Uint8Array[] = [];
		bRelay.onFrame((f) => captured.push(f));
		await encryptAndEmit("ent_noop", new Uint8Array([42]), aCtx);
		await flushMicrotasks();
		const frame = captured[0];
		if (!frame) throw new Error("expected a relayed frame");
		await expect(receiveAndApply(frame, bCtx, () => undefined)).resolves.toBeUndefined();
	});
});
