/**
 * LAN-6 — the wedge, proven end-to-end with NO cloud relay.
 *
 * Two `LiveSyncEngine`s (two "devices"), each with its own Y.Doc, connected to
 * a single in-process `LanRelayHost` (the embedded blind fan-out) through the
 * unchanged `WebSocketRelayPort`, gated by the roster-verified admission
 * challenge. Proves:
 *
 *   1. LIVE CO-EDIT — a local edit on A reaches B's live doc through the sealed
 *      pipeline over the LAN host (no server, no dev bridge).
 *   2. BACKFILL OF OFFLINE CHANGES — B disconnects, A edits while B is away, B
 *      reconnects (re-auth + re-subscribe), and a full-state resync brings B's
 *      doc up to date. The DEK-sealed `Snapshot` merges via the CRDT.
 *
 * The resync TRIGGER here is driven explicitly (`engineA.noteCompaction`) to
 * stand in for the production host-driven peer-join notification (a named LAN
 * rung); the DATA PATH being proven — offline edits reconciled via a DEK-sealed
 * full-state snapshot over the localhost blind host — is the genuine one.
 *
 * NOT SHIPPABLE FROM THIS PASS: this is the localhost / in-process proof; the
 * real external-interface listener + admission gate are withheld behind the
 * mandatory /security-review + /pentester (see `docs/data/lan-p2p-sync.md` §4).
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { XCHACHA_NONCE_BYTES, generateSymmetricKey } from "../credentials/crypto";
import type { EntityDekHandle, EntityDekStore } from "../entities/entity-dek-store";
import { bytesToBase64Url } from "../pairing/pairing-channel";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { makeLanAdmissionVerifier, makeLanChallengeResponder } from "./lan-admission";
import { LanRelayHost } from "./lan-relay-host";
import { LiveSyncEngine, type LiveSyncEngineContext } from "./live-sync-engine";
import type { RelayPort, RelaySurface } from "./relay-port";
import { WebSocketRelayPort } from "./websocket-relay-port";

const ENT = "ent_lan_brief";
const TYPE = "brainstorm/Note/v1";
const REMOTE_ORIGIN = "lan-remote";

async function flush(times = 12): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

async function waitFor(pred: () => boolean, tries = 60): Promise<boolean> {
	for (let i = 0; i < tries; i++) {
		if (pred()) return true;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	return pred();
}

/** Minimal per-entity DEK store; `seedFrom` copies a minted DEK so two devices
 *  share the key (the post-share steady state). */
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

/** A swap-stable relay surface (a minimal `ActiveRelayOrchestrator`): frame
 *  listeners + subscriptions survive a port swap (a reconnect), re-attaching to
 *  the replacement port — the production swap-survival contract. */
class SwapSurface implements RelaySurface {
	#port: RelayPort;
	readonly #listeners = new Set<(f: Uint8Array) => void>();
	readonly #subs = new Set<string>();
	constructor(port: RelayPort) {
		this.#port = port;
	}
	currentPort(): RelayPort {
		return this.#port;
	}
	onFrame(cb: (f: Uint8Array) => void): void {
		this.#listeners.add(cb);
		this.#port.onFrame(cb);
	}
	offFrame(cb: (f: Uint8Array) => void): void {
		this.#listeners.delete(cb);
		this.#port.offFrame(cb);
	}
	subscribe(key: string): void {
		this.#subs.add(key);
		(this.#port as RelayPort & { subscribe?: (k: string) => void }).subscribe?.(key);
	}
	unsubscribe(key: string): void {
		this.#subs.delete(key);
		(this.#port as RelayPort & { unsubscribe?: (k: string) => void }).unsubscribe?.(key);
	}
	swap(next: RelayPort): void {
		for (const l of this.#listeners) next.onFrame(l);
		for (const k of this.#subs) {
			(next as RelayPort & { subscribe?: (k: string) => void }).subscribe?.(k);
		}
		this.#port = next;
	}
}

type Device = {
	engine: LiveSyncEngine;
	doc: Y.Doc;
	surface: SwapSurface;
	makePort: () => WebSocketRelayPort;
};

function buildDevice(
	host: LanRelayHost,
	kp: ReturnType<typeof ed25519.keygen>,
	store: FakeDekStore,
): Device {
	const devicePub = new Uint8Array(kp.publicKey);
	const account = bytesToBase64Url(devicePub);
	const ctor = host.webSocketCtor();
	const responder = makeLanChallengeResponder({
		account: () => account,
		signNonce: (nonce) => new Uint8Array(ed25519.sign(nonce, kp.secretKey)),
	});
	const makePort = (): WebSocketRelayPort =>
		new WebSocketRelayPort({ url: "lan://host", wsImpl: ctor, onChallenge: responder });
	const port0 = makePort();
	const surface = new SwapSurface(port0);
	const doc = new Y.Doc();
	const ctx: LiveSyncEngineContext = {
		getRelay: () => surface,
		dekStore: store as unknown as EntityDekStore,
		devicePub,
		deviceSign: (bytes) => new Uint8Array(ed25519.sign(bytes, kp.secretKey)),
		deviceVerify: (sig, bytes, senderPub) => {
			try {
				return ed25519.verify(sig, bytes, senderPub);
			} catch {
				return false;
			}
		},
		resolveEntityType: () => TYPE,
		isShared: async () => true,
		applyRemoteUpdate: async (_id, _type, update) => {
			Y.applyUpdate(doc, update, REMOTE_ORIGIN);
		},
		getEntitySnapshot: async () => Y.encodeStateAsUpdate(doc),
		nowMs: () => 1_700_000_000_000,
		randomNonce: () => {
			const n = new Uint8Array(XCHACHA_NONCE_BYTES);
			crypto.getRandomValues(n);
			return n;
		},
	};
	const engine = new LiveSyncEngine(ctx);
	doc.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === REMOTE_ORIGIN) return;
		void engine.noteLocalUpdate(ENT, update);
	});
	port0.connect();
	return { engine, doc, surface, makePort };
}

function text(doc: Y.Doc): string {
	return doc.getText("t").toString();
}

function gated(device: Device): boolean {
	const port = device.surface.currentPort() as WebSocketRelayPort;
	return typeof port.gatedAdmission === "function" && port.gatedAdmission();
}

describe("LAN P2P sync (LAN-6) — two engines over a localhost blind host, no cloud relay", () => {
	it("live co-edit converges, then backfills a peer's offline edits on reconnect", async () => {
		const dekA = new FakeDekStore();
		const dekB = new FakeDekStore();
		dekA.mint(ENT);
		dekB.seedFrom(dekA, ENT); // shared DEK (post-share steady state)

		const kpA = ed25519.keygen();
		const kpB = ed25519.keygen();
		const accountA = bytesToBase64Url(new Uint8Array(kpA.publicKey));
		const accountB = bytesToBase64Url(new Uint8Array(kpB.publicKey));
		const roster = new Set([accountA, accountB]);

		const host = new LanRelayHost({
			admit: makeLanAdmissionVerifier({
				isRosterMember: (acc) => roster.has(acc),
				verify: (pub, msg, sig) => ed25519.verify(sig, msg, pub),
			}),
		});

		const deviceA = buildDevice(host, kpA, dekA);
		const deviceB = buildDevice(host, kpB, dekB);

		try {
			// Both peers open the shared entity: subscribe + attach frame listener.
			await deviceA.engine.trackOpen(ENT, TYPE);
			await deviceB.engine.trackOpen(ENT, TYPE);
			// Wait for admission (mutual challenge) + subscription propagation.
			expect(await waitFor(() => gated(deviceA))).toBe(true);
			expect(await waitFor(() => gated(deviceB))).toBe(true);
			await flush(16);

			// 1) LIVE CO-EDIT: A types, B converges — through the LAN host only.
			deviceA.doc.getText("t").insert(0, "hello");
			expect(await waitFor(() => text(deviceB.doc) === "hello")).toBe(true);

			// 2) BACKFILL: B goes offline, A edits, B misses it.
			(deviceB.surface.currentPort() as WebSocketRelayPort).close();
			await flush(8);
			deviceA.doc.getText("t").insert(5, " world"); // "hello world" on A only
			await flush(12);
			expect(text(deviceB.doc)).toBe("hello"); // B missed the offline edit

			// B reconnects: fresh port, swap-survive listeners + subscriptions,
			// re-auth via the challenge, re-subscribe on the host.
			const portB2 = deviceB.makePort();
			deviceB.surface.swap(portB2);
			portB2.connect();
			expect(await waitFor(() => portB2.gatedAdmission())).toBe(true);
			await flush(16);

			// Resync trigger (stands in for the host-driven peer-join notification):
			// the still-present peer A re-emits full state; B merges the offline edit.
			await deviceA.engine.noteCompaction(ENT);
			expect(await waitFor(() => text(deviceB.doc) === "hello world")).toBe(true);
			expect(text(deviceA.doc)).toBe("hello world");
		} finally {
			try {
				(deviceB.surface.currentPort() as WebSocketRelayPort).close();
			} catch {
				/* ignore */
			}
			try {
				(deviceA.surface.currentPort() as WebSocketRelayPort).close();
			} catch {
				/* ignore */
			}
			deviceA.engine.dispose();
			deviceB.engine.dispose();
			host.close();
		}
	});
});
