/**
 * Stage 10.11 — routing-token mode through the envelope pipeline (OQ-197).
 *
 * The wire-visible property under test: with `routingTokens` wired, the RAW
 * entity id never appears anywhere in the emitted frame bytes — the header's
 * `entityId` slot carries the DEK-derived pseudonym — while two peers sharing
 * the DEK still round-trip and converge. Plus the fail-closed edges: emit
 * with no installed token throws (never silently leaks the raw id), and a
 * routed token that is not the resolved entity's drops before any crypto.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { XCHACHA_NONCE_BYTES, generateSymmetricKey } from "../credentials/crypto";
import type { EntityDekHandle, EntityDekStore } from "../entities/entity-dek-store";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { decodeFrame } from "./envelope-codec";
import {
	type PipelineContext,
	emitAwareness,
	encryptAndEmit,
	receiveAndApply,
} from "./envelope-pipeline";
import { LoopbackRelayPort } from "./relay-port";
import { RoutingTokenTable } from "./routing-token";

/** A raw id that cannot appear in a frame by coincidence. */
const ENTITY_ID = "entity-canary-b7f31c/secret-notes";
const TYPE = "com.example.note";

class TokenTestDekStore {
	readonly deks = new Map<string, Uint8Array>();
	nextDekId(): string {
		return "dek-id";
	}
	persist(): EntityDekHandle {
		throw new Error("not used");
	}
	open(entityId: string): EntityDekHandle | null {
		const dek = this.deks.get(entityId);
		return dek ? { dekId: "dek-id", dek: new Uint8Array(dek) } : null;
	}
	close(dek: Uint8Array): void {
		dek.fill(0);
	}
}

function makeTokenCtx(opts: {
	relay: LoopbackRelayPort;
	dekStore: TokenTestDekStore;
	table: RoutingTokenTable;
}): PipelineContext {
	const pair = ed25519.keygen();
	const secret = new Uint8Array(pair.secretKey);
	let seq = 0;
	return {
		dekStore: opts.dekStore as unknown as EntityDekStore,
		devicePub: new Uint8Array(pair.publicKey),
		deviceSign: (bytes) => new Uint8Array(ed25519.sign(bytes, secret)),
		deviceVerify: (sig, bytes, senderPub) => {
			try {
				return ed25519.verify(sig, bytes, senderPub);
			} catch {
				return false;
			}
		},
		// Token mode: the resolver IS the token table (tokens in, entities out).
		resolveEntity: (routedId) => {
			const id = opts.table.resolve(routedId);
			return id ? { id, type: TYPE } : null;
		},
		routingTokens: opts.table,
		relay: opts.relay,
		nextSeq: () => seq++,
		nowMs: () => 1_700_000_000_000,
		randomNonce: () => {
			const n = new Uint8Array(XCHACHA_NONCE_BYTES);
			crypto.getRandomValues(n);
			return n;
		},
	};
}

function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
}

function setup() {
	const [aRelay, bRelay] = LoopbackRelayPort.pair(2);
	if (!aRelay || !bRelay) throw new Error("missing relay ports");
	const dek = generateSymmetricKey();
	const dekStore = new TokenTestDekStore();
	dekStore.deks.set(ENTITY_ID, dek);
	const table = new RoutingTokenTable();
	const token = table.install(ENTITY_ID, dek);
	const aCtx = makeTokenCtx({ relay: aRelay, dekStore, table });
	const bCtx = makeTokenCtx({ relay: bRelay, dekStore, table });
	// Single-user multi-device: one signing identity on both sides.
	bCtx.devicePub = aCtx.devicePub;
	bCtx.deviceSign = aCtx.deviceSign;
	return { aRelay, bRelay, dek, dekStore, table, token, aCtx, bCtx };
}

describe("envelope-pipeline in routing-token mode", () => {
	it("the wire frame carries the token — the raw entity id appears NOWHERE in the bytes", async () => {
		const { bRelay, token, aCtx } = setup();
		const captured: Uint8Array[] = [];
		bRelay.onFrame((frame) => captured.push(frame));

		const doc = new Y.Doc();
		doc.getText("t").insert(0, "hello");
		await encryptAndEmit(ENTITY_ID, Y.encodeStateAsUpdate(doc), aCtx);

		expect(captured.length).toBe(1);
		const wire = captured[0];
		if (!wire) throw new Error("no frame captured");
		const decoded = decodeFrame(wire);
		expect(decoded.header.entityId).toBe(token);
		expect(decoded.header.entityId).not.toBe(ENTITY_ID);
		const rawId = new TextEncoder().encode(ENTITY_ID);
		expect(containsSubsequence(wire, rawId)).toBe(false);
	});

	it("round-trips: token-routed frames resolve, decrypt, and converge two Y.Docs", async () => {
		const { bRelay, aCtx, bCtx } = setup();
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const appliedFor: string[] = [];
		bRelay.onFrame(async (frame) => {
			await receiveAndApply(frame, bCtx, (plaintext) => {
				appliedFor.push(ENTITY_ID);
				Y.applyUpdate(docB, plaintext);
			});
		});
		docA.getText("t").insert(0, "rotated world");
		await encryptAndEmit(ENTITY_ID, Y.encodeStateAsUpdate(docA), aCtx);
		expect(appliedFor).toEqual([ENTITY_ID]);
		expect(docB.getText("t").toString()).toBe("rotated world");
	});

	it("awareness frames route by token too", async () => {
		const { bRelay, token, aCtx } = setup();
		const captured: Uint8Array[] = [];
		bRelay.onFrame((frame) => captured.push(frame));
		await emitAwareness(ENTITY_ID, new Uint8Array([1, 2, 3]), aCtx);
		const wire = captured[0];
		if (!wire) throw new Error("no frame captured");
		expect(decodeFrame(wire).header.entityId).toBe(token);
	});

	it("FAIL-CLOSED: emitting for an entity with no installed token throws, sends nothing", async () => {
		const { aRelay, bRelay, dekStore, aCtx } = setup();
		void aRelay;
		const captured: Uint8Array[] = [];
		bRelay.onFrame((frame) => captured.push(frame));
		dekStore.deks.set("ent_untokened", generateSymmetricKey());
		await expect(encryptAndEmit("ent_untokened", new Uint8Array([1]), aCtx)).rejects.toThrowError(
			expect.objectContaining({ name: "Unavailable" }),
		);
		expect(captured.length).toBe(0);
	});

	it("FAIL-CLOSED: a routed token that is not the resolved entity's drops before crypto", async () => {
		const { bRelay, aCtx, bCtx, dekStore, table } = setup();
		// B's resolver maliciously (or buggily) maps every token to a DIFFERENT
		// entity — the token↔row binding check must refuse to open under it.
		dekStore.deks.set("ent_other", generateSymmetricKey());
		table.install("ent_other", dekStore.deks.get("ent_other") as Uint8Array);
		bCtx.resolveEntity = () => ({ id: "ent_other", type: TYPE });
		const applied: Uint8Array[] = [];
		let failure: Error | null = null;
		bRelay.onFrame(async (frame) => {
			try {
				await receiveAndApply(frame, bCtx, (p) => {
					applied.push(p);
				});
			} catch (error) {
				failure = error as Error;
			}
		});
		const doc = new Y.Doc();
		doc.getText("t").insert(0, "x");
		await encryptAndEmit(ENTITY_ID, Y.encodeStateAsUpdate(doc), aCtx);
		expect(applied.length).toBe(0);
		expect(failure).not.toBeNull();
		expect((failure as unknown as Error).name).toBe("EntityIdMismatch");
	});

	it("grace window: a frame under the PREVIOUS token still resolves and applies after a rotation", async () => {
		const { bRelay, aCtx, bCtx, table, dek } = setup();
		const docB = new Y.Doc();
		bRelay.onFrame(async (frame) => {
			await receiveAndApply(frame, bCtx, (plaintext) => {
				Y.applyUpdate(docB, plaintext);
			});
		});
		// A emits under the CURRENT (soon-to-be-old) token…
		const docA = new Y.Doc();
		docA.getText("t").insert(0, "in-flight");
		const emitPromise = encryptAndEmit(ENTITY_ID, Y.encodeStateAsUpdate(docA), aCtx);
		await emitPromise;
		// …B rotates (new DEK generation installed) BEFORE the next old frame.
		table.install(ENTITY_ID, generateSymmetricKey());
		// A (not yet flipped — its table copy is stale) sends another old-token
		// frame; simulate by re-installing the old derivation on A's side only:
		// the shared table now resolves BOTH generations, so B still applies it.
		docA.getText("t").insert(9, " catches up");
		// Reuse the old token by rolling the table back on the emit path only.
		const oldTable = new RoutingTokenTable();
		oldTable.install(ENTITY_ID, dek);
		aCtx.routingTokens = oldTable;
		await encryptAndEmit(ENTITY_ID, Y.encodeStateAsUpdate(docA), aCtx);
		expect(docB.getText("t").toString()).toBe("in-flight catches up");
	});
});
