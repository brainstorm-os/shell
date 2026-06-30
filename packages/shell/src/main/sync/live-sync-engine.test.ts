/**
 * Stage 10.12 — `LiveSyncEngine` reproduce-first tests.
 *
 * Two engines over a `LoopbackRelayPort` pair, each owning its own live Y.Doc,
 * standing in for two devices/users that already share an entity (the DEK is
 * already distributed — the same key sits in both stores, which is the post-
 * share steady state 10.12 operates in). This is the in-process analog of the
 * two-shell real-Notes co-edit dogfood: a local edit on one side reaches the
 * other's live doc via the normal emit/apply hooks, with no dev bridge.
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { XCHACHA_NONCE_BYTES, generateSymmetricKey } from "../credentials/crypto";
import { MEMBER_WRAP_ALG, MEMBER_WRAP_VERSION } from "../credentials/member-wraps";
import type { EntityDekHandle, EntityDekStore } from "../entities/entity-dek-store";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { type PipelineContext, emitWrapBootstrap } from "./envelope-pipeline";
import { LiveSyncEngine, type LiveSyncEngineContext } from "./live-sync-engine";
import { LoopbackRelayPort, type RelayPort, type RelaySurface } from "./relay-port";

/** Emit a shape-valid (un-openable) `WrapBootstrap` frame onto `port`, signed
 *  by a fresh key — exercises the engine's restore wrap-install path without a
 *  full HPKE round-trip (the engine verifies the sig + parses the wrap; the
 *  HPKE unseal is the wiring's `installWrap`, stubbed in the test). */
async function emitWrapFrom(
	port: RelayPort,
	entityId: string,
	wrap: Record<string, unknown>,
): Promise<void> {
	const pair = ed25519.keygen();
	const ctx = {
		devicePub: new Uint8Array(pair.publicKey),
		deviceSign: (b: Uint8Array) => new Uint8Array(ed25519.sign(b, pair.secretKey)),
		nextSeq: () => 0,
		nowMs: () => 1700000000000,
		randomNonce: () => {
			const n = new Uint8Array(XCHACHA_NONCE_BYTES);
			crypto.getRandomValues(n);
			return n;
		},
		relay: port,
	} as unknown as PipelineContext;
	await emitWrapBootstrap(entityId, wrap as never, ctx);
}

const ENT = "ent_brief";
const TYPE = "brainstorm/Note/v1";

class FakeDekStore {
	private readonly deks = new Map<string, Uint8Array>();
	mint(entityId: string): void {
		this.deks.set(entityId, generateSymmetricKey());
	}
	/** Copy a minted DEK into another store so two "devices" share the key. */
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
		return { dekId: "dek-id", dek: new Uint8Array(dek) };
	}
	close(dek: Uint8Array): void {
		dek.fill(0);
	}
}

function relaySurface(port: RelayPort): RelaySurface {
	return {
		currentPort: () => port,
		onFrame: (cb) => port.onFrame(cb),
		offFrame: (cb) => port.offFrame(cb),
	};
}

const REMOTE_ORIGIN = "live-sync-remote";

type Device = {
	engine: LiveSyncEngine;
	doc: Y.Doc;
	dekStore: FakeDekStore;
	emitFailures: number;
};

/** Build one device: a Y.Doc whose local (non-remote-origin) updates feed the
 *  engine's emit hook, and whose `applyRemoteUpdate` applies inbound plaintext
 *  with a sentinel origin so it never re-emits (the renderer-transport echo
 *  guard, modelled). */
function makeDevice(
	port: RelayPort,
	dekStore: FakeDekStore,
	shared: () => boolean,
	overrides: Partial<LiveSyncEngineContext> = {},
): Device {
	const pair = ed25519.keygen();
	const doc = new Y.Doc();
	const device: Device = {
		engine: undefined as unknown as LiveSyncEngine,
		doc,
		dekStore,
		emitFailures: 0,
	};
	const ctx: LiveSyncEngineContext = {
		getRelay: () => relaySurface(port),
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
		resolveEntityType: () => TYPE,
		isShared: async () => shared(),
		applyRemoteUpdate: async (_id, _type, update) => {
			Y.applyUpdate(doc, update, REMOTE_ORIGIN);
		},
		getEntitySnapshot: async () => Y.encodeStateAsUpdate(doc),
		nowMs: () => 1700000000000,
		randomNonce: () => {
			const n = new Uint8Array(XCHACHA_NONCE_BYTES);
			crypto.getRandomValues(n);
			return n;
		},
		...overrides,
	};
	device.engine = new LiveSyncEngine(ctx);
	// Local edits (origin !== remote sentinel) flow to the emit hook.
	doc.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === REMOTE_ORIGIN) return;
		void device.engine.noteLocalUpdate(ENT, update);
	});
	return device;
}

async function settle(...devices: Device[]): Promise<void> {
	// Flush emit microtasks, then the peers' inbound apply chains, twice — a
	// frame applied on B can itself produce nothing further here, but the
	// double pass covers the emit→receive→idle handoff deterministically.
	for (let i = 0; i < 3; i++) {
		await Promise.resolve();
		await Promise.all(devices.map((d) => d.engine.whenIdle()));
	}
}

describe("LiveSyncEngine — always-on live sync (10.12)", () => {
	it("a local edit on one shared, tracked device reaches the other's live doc", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const dekB = new FakeDekStore();
		dekB.seedFrom(dekA, ENT);

		const a = makeDevice(pa, dekA, () => true);
		const b = makeDevice(pb, dekB, () => true);
		await a.engine.trackOpen(ENT, TYPE);
		await b.engine.trackOpen(ENT, TYPE);
		expect(a.engine.isTracked(ENT)).toBe(true);
		expect(b.engine.isTracked(ENT)).toBe(true);

		a.doc.getText("body").insert(0, "Northbound brief. ");
		await settle(a, b);

		expect(b.doc.getText("body").toString()).toBe("Northbound brief. ");
	});

	it("a local awareness update on one shared device reaches the other's applyRemoteAwareness", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const dekB = new FakeDekStore();
		dekB.seedFrom(dekA, ENT);

		const received: Uint8Array[] = [];
		const a = makeDevice(pa, dekA, () => true);
		const b = makeDevice(pb, dekB, () => true, {
			applyRemoteAwareness: (_id, _type, update) => {
				received.push(update);
			},
		});
		await a.engine.trackOpen(ENT, TYPE);
		await b.engine.trackOpen(ENT, TYPE);

		// Opaque awareness bytes (the y-protocols encode/decode lives in the
		// renderer; the engine only seals + routes them under the entity DEK).
		await a.engine.emitLocalAwareness(ENT, new Uint8Array([1, 2, 3, 4]));
		await settle(a, b);

		expect(received.length).toBe(1);
		expect([...(received[0] ?? [])]).toEqual([1, 2, 3, 4]);
	});

	it("does not route awareness for an entity the receiver isn't tracking", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const dekB = new FakeDekStore();
		dekB.seedFrom(dekA, ENT);

		const received: Uint8Array[] = [];
		const a = makeDevice(pa, dekA, () => true);
		const b = makeDevice(pb, dekB, () => true, {
			applyRemoteAwareness: (_id, _type, update) => {
				received.push(update);
			},
		});
		await a.engine.trackOpen(ENT, TYPE);
		// b does NOT trackOpen → it must not accept awareness for ENT.
		await a.engine.emitLocalAwareness(ENT, new Uint8Array([9, 9]));
		await settle(a, b);

		expect(received.length).toBe(0);
	});

	it("concurrent edits converge both docs and do not echo back", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const dekB = new FakeDekStore();
		dekB.seedFrom(dekA, ENT);

		const a = makeDevice(pa, dekA, () => true);
		const b = makeDevice(pb, dekB, () => true);
		await a.engine.trackOpen(ENT, TYPE);
		await b.engine.trackOpen(ENT, TYPE);

		a.doc.getText("body").insert(0, "[A]");
		b.doc.getText("body").insert(0, "[B]");
		await settle(a, b);
		// A second round would echo if the remote-origin guard were missing —
		// settle again and assert the text is stable (no growth).
		await settle(a, b);

		const finalA = a.doc.getText("body").toString();
		const finalB = b.doc.getText("body").toString();
		expect(finalA).toBe(finalB);
		expect(finalA).toContain("[A]");
		expect(finalA).toContain("[B]");
		// Exactly one of each marker — no duplication from an echo loop.
		expect(finalA.match(/\[A\]/g)).toHaveLength(1);
		expect(finalA.match(/\[B\]/g)).toHaveLength(1);
	});

	it("a solo (unshared) entity never emits — the relay stays quiet", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const dekB = new FakeDekStore();
		dekB.seedFrom(dekA, ENT);

		const a = makeDevice(pa, dekA, () => false);
		const b = makeDevice(pb, dekB, () => true);
		await a.engine.trackOpen(ENT, TYPE);
		await b.engine.trackOpen(ENT, TYPE);
		expect(a.engine.isTracked(ENT)).toBe(false);

		a.doc.getText("body").insert(0, "solo note");
		await settle(a, b);

		expect(b.doc.getText("body").toString()).toBe("");
	});

	it("refreshMembership flips a solo entity into syncing after a share", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const dekB = new FakeDekStore();
		dekB.seedFrom(dekA, ENT);

		let shared = false;
		const a = makeDevice(pa, dekA, () => shared);
		const b = makeDevice(pb, dekB, () => true);
		await a.engine.trackOpen(ENT, TYPE);
		expect(a.engine.isTracked(ENT)).toBe(false);

		shared = true;
		await a.engine.refreshMembership(ENT, TYPE);
		await b.engine.trackOpen(ENT, TYPE);
		expect(a.engine.isTracked(ENT)).toBe(true);

		a.doc.getText("body").insert(0, "now shared");
		await settle(a, b);
		expect(b.doc.getText("body").toString()).toBe("now shared");
	});

	it("a shared entity the selective-sync policy excludes is NOT tracked (10.13)", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const dekB = new FakeDekStore();
		dekB.seedFrom(dekA, ENT);

		const a = makeDevice(pa, dekA, () => true, { policyAdmits: () => false });
		const b = makeDevice(pb, dekB, () => true);
		await a.engine.trackOpen(ENT, TYPE);
		await b.engine.trackOpen(ENT, TYPE);
		expect(a.engine.isTracked(ENT)).toBe(false);

		a.doc.getText("body").insert(0, "excluded");
		await settle(a, b);
		expect(b.doc.getText("body").toString()).toBe("");
	});

	it("refreshPolicy untracks an entity the new policy no longer admits (10.13)", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const dekB = new FakeDekStore();
		dekB.seedFrom(dekA, ENT);

		let admit = true;
		const a = makeDevice(pa, dekA, () => true, { policyAdmits: () => admit });
		const b = makeDevice(pb, dekB, () => true);
		await a.engine.trackOpen(ENT, TYPE);
		await b.engine.trackOpen(ENT, TYPE);
		expect(a.engine.isTracked(ENT)).toBe(true);

		admit = false;
		await a.engine.refreshPolicy();
		expect(a.engine.isTracked(ENT)).toBe(false);

		a.doc.getText("body").insert(0, "after-exclude");
		await settle(a, b);
		expect(b.doc.getText("body").toString()).toBe("");
	});

	it("noteCompaction emits a Snapshot that brings a peer up to date (10.14)", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const dekB = new FakeDekStore();
		dekB.seedFrom(dekA, ENT);

		const a = makeDevice(pa, dekA, () => true);
		const b = makeDevice(pb, dekB, () => true);
		await a.engine.trackOpen(ENT, TYPE);

		// a edits BEFORE b is online → b's frame listener isn't attached, so b
		// misses the live update (the offline-while-edited case).
		a.doc.getText("body").insert(0, "compacted");
		await settle(a, b);
		expect(b.doc.getText("body").toString()).toBe("");

		// b comes online + tracks; a's doc compacts and emits a full snapshot —
		// which catches b up with no replay of the missed deltas.
		await b.engine.trackOpen(ENT, TYPE);
		await a.engine.noteCompaction(ENT);
		await settle(a, b);
		expect(b.doc.getText("body").toString()).toBe("compacted");
	});

	it("noteCompaction is a no-op for an untracked entity", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		dekA.mint(ENT);
		const dekB = new FakeDekStore();
		dekB.seedFrom(dekA, ENT);

		const a = makeDevice(pa, dekA, () => true);
		const b = makeDevice(pb, dekB, () => true);
		await b.engine.trackOpen(ENT, TYPE);
		// a never tracked ENT → noteCompaction must not emit anything.
		a.doc.getText("body").insert(0, "x");
		await a.engine.noteCompaction(ENT);
		await settle(a, b);
		expect(b.doc.getText("body").toString()).toBe("");
	});

	it("installs a DEK from an inbound WrapBootstrap during restore — NOT gated on tracking (10.14)", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const installed: Array<{ id: string; wrap: { v: number } }> = [];
		const b = makeDevice(pb, new FakeDekStore(), () => true, {
			installWrap: async (wrap, id) => {
				installed.push({ id, wrap: wrap as unknown as { v: number } });
				return null;
			},
		});
		// A cold/restoring device attaches its listener WITHOUT tracking any
		// entity (it has no doc to read the access record from).
		b.engine.start();
		expect(b.engine.isTracked(ENT)).toBe(false);

		// The durable node replays the entity's wrap first; the engine installs
		// the DEK even though the entity isn't tracked.
		await emitWrapFrom(pa, ENT, {
			v: MEMBER_WRAP_VERSION,
			alg: MEMBER_WRAP_ALG,
			recipientPubB64: "cmVjaXBpZW50",
			encB64: "ZW5j",
			ctB64: "Y3Q",
		});
		await settle(b);

		expect(installed).toHaveLength(1);
		expect(installed[0]?.id).toBe(ENT);
		expect(installed[0]?.wrap.v).toBe(1);
	});

	it("trackForRestore + a type-carrying wrap promotes the tracked type (10.14)", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const b = makeDevice(pb, new FakeDekStore(), () => true, {
			// The wiring's installWrap recovers the type from the wrap; here we
			// just return it so the engine can promote the restore-tracked entity.
			installWrap: async () => "brainstorm/Note/v1",
		});
		b.engine.trackForRestore(ENT);
		expect(b.engine.isTracked(ENT)).toBe(true);
		expect(b.engine.restoredType(ENT)).toBeNull(); // pending until the wrap lands

		await emitWrapFrom(pa, ENT, {
			v: MEMBER_WRAP_VERSION,
			alg: MEMBER_WRAP_ALG,
			recipientPubB64: "cmVjaXBpZW50",
			encB64: "ZW5j",
			ctB64: "Y3Q",
		});
		await settle(b);

		expect(b.engine.restoredType(ENT)).toBe("brainstorm/Note/v1");
	});

	it("auto-tracks an UNTRACKED entity when a type-carrying wrap lands (Collab-C5 cross-user share)", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const b = makeDevice(pb, new FakeDekStore(), () => true, {
			installWrap: async () => "brainstorm/Note/v1",
			// The entity is TRULY unknown — no local row, so `resolveEntity` would
			// return null and `receiveWrapBootstrap` would reject it without the
			// speculative pre-register.
			resolveEntityType: () => null,
		});
		// The recipient just listens — it has NEVER seen this entity (not open,
		// not restore-tracked); it was granted access out of band.
		b.engine.start();
		expect(b.engine.isTracked(ENT)).toBe(false);

		await emitWrapFrom(pa, ENT, {
			v: MEMBER_WRAP_VERSION,
			alg: MEMBER_WRAP_ALG,
			recipientPubB64: "cmVjaXBpZW50",
			encB64: "ZW5j",
			ctB64: "Y3Q",
		});
		await settle(b);

		// A wrap sealed for this device is a grant; the engine now tracks the
		// entity so the doc state that follows applies + its edits sync back.
		expect(b.engine.isTracked(ENT)).toBe(true);
		// It's a share-track, not a restore-track (no recovered type recorded).
		expect(b.engine.restoredType(ENT)).toBeNull();
	});

	it("ignores an inbound WrapBootstrap when no installWrap is wired (live-only mode)", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const b = makeDevice(pb, new FakeDekStore(), () => true); // no installWrap
		b.engine.start();
		await emitWrapFrom(pa, ENT, {
			v: MEMBER_WRAP_VERSION,
			alg: MEMBER_WRAP_ALG,
			recipientPubB64: "r",
			encB64: "e",
			ctB64: "c",
		});
		await settle(b);
		// No throw, no effect — the engine simply doesn't process wraps.
		expect(b.engine.isTracked(ENT)).toBe(false);
	});

	it("an emit failure is swallowed (online-only — a missed frame is not a failed edit)", async () => {
		const [pa, pb] = LoopbackRelayPort.pair(2);
		if (!pa || !pb) throw new Error("missing ports");
		const dekA = new FakeDekStore();
		// Intentionally do NOT mint the DEK for A → encryptAndEmit throws Unavailable.
		const dekB = new FakeDekStore();

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const a = makeDevice(pa, dekA, () => true);
		const b = makeDevice(pb, dekB, () => true);
		await a.engine.trackOpen(ENT, TYPE);
		await b.engine.trackOpen(ENT, TYPE);

		a.doc.getText("body").insert(0, "x");
		await settle(a, b);

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("emit failed"));
		expect(b.doc.getText("body").toString()).toBe("");
		warn.mockRestore();
	});
});
