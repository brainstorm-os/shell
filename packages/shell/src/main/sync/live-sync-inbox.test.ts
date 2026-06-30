/**
 * Collab-C5.4 — cross-user wrap delivery over a CHANNEL-ROUTED relay (the
 * production routing model, unlike the broadcast loopback the other live-sync
 * tests use). Proves the inbox path end to end: a recipient subscribed ONLY to
 * its inbox receives a `WrapBootstrap` an owner routed there (for an entity it
 * has never seen) and starts tracking that entity — and does NOT receive a wrap
 * routed to the entity channel it never subscribed to.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, it } from "vitest";
import { inboxChannelFor } from "../collab/inbox-channel";
import { XCHACHA_NONCE_BYTES, bytesToBase64 } from "../credentials/crypto";
import { MEMBER_WRAP_ALG, MEMBER_WRAP_VERSION } from "../credentials/member-wraps";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { decodeFrame } from "./envelope-codec";
import { type PipelineContext, emitWrapBootstrap } from "./envelope-pipeline";
import { LiveSyncEngine, type LiveSyncEngineContext } from "./live-sync-engine";
import type { RelayPort, RelaySurface } from "./relay-port";

const ENT = "ent_secret_note";
const TYPE = "brainstorm/Note/v1";

/** A minimal CHANNEL-ROUTED relay: a shared subscription table fans each `send`
 *  to the OTHER connections subscribed to the frame's `route ?? entityId`
 *  (never echoes to the sender). Mirrors the relay-server's `FrameRouter`. */
class ChannelRelay {
	readonly #subs = new Map<string, Set<string>>(); // routingKey -> connIds
	readonly #listeners = new Map<string, Set<(f: Uint8Array) => void>>();

	connection(connId: string): { surface: RelaySurface; close: () => void } {
		const port: RelayPort = {
			send: (frame) => this.#route(connId, frame),
			onFrame: (cb) => this.#listen(connId, cb),
			offFrame: (cb) => this.#listeners.get(connId)?.delete(cb),
			close: () => undefined,
		};
		const surface: RelaySurface = {
			currentPort: () => port,
			onFrame: (cb) => this.#listen(connId, cb),
			offFrame: (cb) => this.#listeners.get(connId)?.delete(cb),
			subscribe: (key) => {
				let set = this.#subs.get(key);
				if (!set) {
					set = new Set();
					this.#subs.set(key, set);
				}
				set.add(connId);
			},
			unsubscribe: (key) => this.#subs.get(key)?.delete(connId),
		};
		return { surface, close: () => this.#listeners.delete(connId) };
	}

	#listen(connId: string, cb: (f: Uint8Array) => void): void {
		let set = this.#listeners.get(connId);
		if (!set) {
			set = new Set();
			this.#listeners.set(connId, set);
		}
		set.add(cb);
	}

	#route(fromConnId: string, frame: Uint8Array): void {
		const { header } = decodeFrame(frame);
		const key = header.route ?? header.entityId;
		for (const toConnId of this.#subs.get(key) ?? []) {
			if (toConnId === fromConnId) continue;
			for (const cb of this.#listeners.get(toConnId) ?? []) cb(frame);
		}
	}
}

/** Emit a shape-valid `WrapBootstrap` from `surface`, optionally routed to an
 *  inbox channel. The sig/parse are real; the HPKE unseal is the recipient's
 *  stubbed `installWrap`. */
async function emitWrap(surface: RelaySurface, entityId: string, route?: string): Promise<void> {
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
		relay: surface.currentPort(),
	} as unknown as PipelineContext;
	const wrap = {
		v: MEMBER_WRAP_VERSION,
		alg: MEMBER_WRAP_ALG,
		recipientPubB64: "cmVjaXBpZW50",
		encB64: "ZW5j",
		ctB64: "Y3Q",
	};
	await emitWrapBootstrap(entityId, wrap as never, ctx, route);
}

function recipientEngine(relay: ChannelRelay): {
	engine: LiveSyncEngine;
	inbox: string;
	devicePub: Uint8Array;
} {
	const pair = ed25519.keygen();
	const devicePub = new Uint8Array(pair.publicKey);
	const { surface } = relay.connection("recipient");
	const ctx: LiveSyncEngineContext = {
		getRelay: () => surface,
		dekStore: {} as unknown as EntityDekStore,
		devicePub,
		deviceSign: (b) => new Uint8Array(ed25519.sign(b, pair.secretKey)),
		deviceVerify: (sig, bytes, senderPub) => {
			try {
				return ed25519.verify(sig, bytes, senderPub);
			} catch {
				return false;
			}
		},
		resolveEntityType: () => null, // truly unknown until the wrap recovers the type
		isShared: async () => true,
		applyRemoteUpdate: async () => undefined,
		installWrap: async () => TYPE, // HPKE unseal stubbed; returns the recovered type
	};
	return {
		engine: new LiveSyncEngine(ctx),
		inbox: inboxChannelFor(bytesToBase64(devicePub)),
		devicePub,
	};
}

describe("Collab-C5.4 — cross-user wrap delivery over a channel-routed relay", () => {
	let relay: ChannelRelay;

	afterEach(() => undefined);

	it("a wrap routed to the recipient's inbox is received → the entity is tracked", async () => {
		relay = new ChannelRelay();
		const { engine, inbox } = recipientEngine(relay);
		engine.start(); // subscribes to its inbox

		const { surface: owner } = relay.connection("owner");
		await emitWrap(owner, ENT, inbox); // owner routes the wrap to the inbox
		await engine.whenIdle();

		expect(engine.isTracked(ENT)).toBe(true);
		engine.dispose();
	});

	it("a wrap routed to the ENTITY channel (no inbox route) is NOT received — the recipient never subscribed to it", async () => {
		relay = new ChannelRelay();
		const { engine } = recipientEngine(relay);
		engine.start();

		const { surface: owner } = relay.connection("owner");
		await emitWrap(owner, ENT); // no route → routed by entityId
		await engine.whenIdle();

		// The recipient is on its inbox only, not the entity channel, so the wrap
		// never reaches it — exactly why cross-user delivery needs the inbox.
		expect(engine.isTracked(ENT)).toBe(false);
		engine.dispose();
	});
});
