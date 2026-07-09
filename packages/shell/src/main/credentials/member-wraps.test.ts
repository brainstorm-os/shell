import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { generateSymmetricKey } from "./crypto";
import { generateDeviceX25519 } from "./device-x25519";
import {
	ENTITY_META_TOP,
	ENTITY_WRAPS_KEY,
	MEMBER_WRAP_ALG,
	MEMBER_WRAP_VERSION,
	type MemberWrapPayload,
	appendWrap,
	findWrapForRecipient,
	getEntityMetaMap,
	getWrapsArray,
	isMemberWrapPayload,
	listWraps,
	unwrapDekAndTypeForRecipient,
	unwrapDekForRecipient,
	wrapDekForRecipient,
	wrapDekVersionOf,
} from "./member-wraps";

function freshEntity(): { doc: Y.Doc; id: string } {
	return { doc: new Y.Doc(), id: "ent_test_001" };
}

describe("member-wraps schema (Stage 10.2)", () => {
	describe("HPKE round-trip", () => {
		it("wraps + unwraps a DEK addressed to the device's X25519 pubkey", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_42");
			const recovered = unwrapDekForRecipient(wrap, device.secretKey, "ent_42");
			expect(Buffer.compare(recovered, dek)).toBe(0);
		});

		it("seals + recovers an entity type alongside the DEK (10.14)", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_42", "brainstorm/Note/v1");
			const { dek: recoveredDek, type } = unwrapDekAndTypeForRecipient(
				wrap,
				device.secretKey,
				"ent_42",
			);
			expect(Buffer.compare(recoveredDek, dek)).toBe(0);
			expect(type).toBe("brainstorm/Note/v1");
		});

		it("a type-carrying wrap still yields the bare DEK via unwrapDekForRecipient", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_42", "brainstorm/Task/v1");
			expect(Buffer.compare(unwrapDekForRecipient(wrap, device.secretKey, "ent_42"), dek)).toBe(0);
		});

		it("a pre-10.14 wrap (no type) recovers a null type — legacy fallback", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_42");
			const { dek: recoveredDek, type } = unwrapDekAndTypeForRecipient(
				wrap,
				device.secretKey,
				"ent_42",
			);
			expect(Buffer.compare(recoveredDek, dek)).toBe(0);
			expect(type).toBeNull();
		});

		it("type framing stays bound to the entity id (AAD) — wrong id throws", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_a", "brainstorm/Note/v1");
			expect(() => unwrapDekAndTypeForRecipient(wrap, device.secretKey, "ent_b")).toThrow();
		});

		it("stamps the schema version + algorithm + recipient pub", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			// A bare (no-ordinal) wrap stays v1 — wire-identical to pre-ROT-3a-i.
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_x");
			expect(wrap.v).toBe(1);
			expect(wrap.version).toBeUndefined();
			expect(wrap.alg).toBe(MEMBER_WRAP_ALG);
			expect(wrap.recipientPubB64).toBe(Buffer.from(device.publicKey).toString("base64"));
			expect(wrap.encB64.length).toBeGreaterThan(0);
			expect(wrap.ctB64.length).toBeGreaterThan(0);
		});

		it("a versioned wrap stamps v2 + the ordinal, and round-trips (ROT-3a-i)", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_x", undefined, 5);
			expect(wrap.v).toBe(MEMBER_WRAP_VERSION);
			expect(wrap.version).toBe(5);
			expect(wrapDekVersionOf(wrap)).toBe(5);
			const opened = unwrapDekForRecipient(wrap, device.secretKey, "ent_x");
			expect([...opened]).toEqual([...dek]);
		});

		it("wrapDekVersionOf treats a v1 wrap as ordinal 1", () => {
			const device = generateDeviceX25519();
			const wrap = wrapDekForRecipient(generateSymmetricKey(), device.publicKey, "ent_x");
			expect(wrapDekVersionOf(wrap)).toBe(1);
		});

		it("the AAD-bound ordinal is authenticated: tampering `version` fails the unwrap", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_x", undefined, 3);
			// A relay that re-labels the ordinal (to masquerade as newer) breaks the
			// AEAD tag — the reconstructed AAD no longer matches (anti-rollback).
			const tampered = { ...wrap, version: 99 };
			expect(() => unwrapDekForRecipient(tampered, device.secretKey, "ent_x")).toThrow();
		});

		it("encB64 decodes to a 32-byte ephemeral pubkey; ctB64 decodes to 48 bytes (32 DEK + 16 tag)", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_y");
			expect(Buffer.from(wrap.encB64, "base64").length).toBe(32);
			expect(Buffer.from(wrap.ctB64, "base64").length).toBe(48);
		});

		it("unwrap fails on entity-id mismatch (AAD binding)", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_X");
			expect(() => unwrapDekForRecipient(wrap, device.secretKey, "ent_Y")).toThrow();
		});

		it("unwrap fails for a different device's secret key", () => {
			const a = generateDeviceX25519();
			const b = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, a.publicKey, "ent_x");
			expect(() => unwrapDekForRecipient(wrap, b.secretKey, "ent_x")).toThrow();
		});

		it("unwrap fails on tampered ciphertext (Poly1305 auth)", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_x");
			const ct = Buffer.from(wrap.ctB64, "base64");
			ct.writeUInt8(ct.readUInt8(0) ^ 0x01, 0);
			const tampered: MemberWrapPayload = { ...wrap, ctB64: ct.toString("base64") };
			expect(() => unwrapDekForRecipient(tampered, device.secretKey, "ent_x")).toThrow();
		});

		it("unwrap fails on tampered enc (HPKE recovers a different shared secret)", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_x");
			const enc = Buffer.from(wrap.encB64, "base64");
			enc.writeUInt8(enc.readUInt8(0) ^ 0x01, 0);
			const tampered: MemberWrapPayload = { ...wrap, encB64: enc.toString("base64") };
			expect(() => unwrapDekForRecipient(tampered, device.secretKey, "ent_x")).toThrow();
		});

		it("two wraps of the same DEK produce different enc + ct (per-wrap ephemeral key)", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const w1 = wrapDekForRecipient(dek, device.publicKey, "ent_x");
			const w2 = wrapDekForRecipient(dek, device.publicKey, "ent_x");
			expect(w1.encB64).not.toBe(w2.encB64);
			expect(w1.ctB64).not.toBe(w2.ctB64);
			// Both still unwrap to the same DEK.
			expect(Buffer.compare(unwrapDekForRecipient(w1, device.secretKey, "ent_x"), dek)).toBe(0);
			expect(Buffer.compare(unwrapDekForRecipient(w2, device.secretKey, "ent_x"), dek)).toBe(0);
		});

		it("rejects empty entityId on wrap and on unwrap", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			expect(() => wrapDekForRecipient(dek, device.publicKey, "")).toThrow(/non-empty/);
			const wrap = wrapDekForRecipient(dek, device.publicKey, "ent_x");
			expect(() => unwrapDekForRecipient(wrap, device.secretKey, "")).toThrow(/non-empty/);
		});

		it("rejects wrong-size DEK at the boundary", () => {
			const device = generateDeviceX25519();
			expect(() => wrapDekForRecipient(new Uint8Array(16), device.publicKey, "ent_x")).toThrow(
				/32-byte/,
			);
		});
	});

	describe("Y.Doc codec", () => {
		it("installs meta + wraps on first access; idempotent on second", () => {
			const { doc } = freshEntity();
			const meta1 = getEntityMetaMap(doc);
			const wraps1 = getWrapsArray(doc);
			const meta2 = getEntityMetaMap(doc);
			const wraps2 = getWrapsArray(doc);
			expect(meta1).toBe(meta2);
			expect(wraps1).toBe(wraps2);
			expect(doc.getMap(ENTITY_META_TOP).get(ENTITY_WRAPS_KEY)).toBe(wraps1);
		});

		it("listWraps reads back appended wraps in insertion order", () => {
			const { doc, id } = freshEntity();
			const a = generateDeviceX25519();
			const b = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const w1 = wrapDekForRecipient(dek, a.publicKey, id);
			const w2 = wrapDekForRecipient(dek, b.publicKey, id);
			appendWrap(doc, w1);
			appendWrap(doc, w2);
			const list = listWraps(doc);
			expect(list).toHaveLength(2);
			expect(list[0]?.recipientPubB64).toBe(w1.recipientPubB64);
			expect(list[1]?.recipientPubB64).toBe(w2.recipientPubB64);
		});

		it("findWrapForRecipient returns the right entry; null when no match", () => {
			const { doc, id } = freshEntity();
			const a = generateDeviceX25519();
			const b = generateDeviceX25519();
			const stranger = generateDeviceX25519();
			const dek = generateSymmetricKey();
			appendWrap(doc, wrapDekForRecipient(dek, a.publicKey, id));
			appendWrap(doc, wrapDekForRecipient(dek, b.publicKey, id));
			const found = findWrapForRecipient(doc, a.publicKey);
			expect(found).toBeTruthy();
			expect(found?.recipientPubB64).toBe(Buffer.from(a.publicKey).toString("base64"));
			expect(findWrapForRecipient(doc, stranger.publicKey)).toBeNull();
		});

		it("encoded Y.Doc state contains the wraps and round-trips through Y.applyUpdate", () => {
			const { doc, id } = freshEntity();
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, id);
			appendWrap(doc, wrap);

			const update = Y.encodeStateAsUpdate(doc);
			const replica = new Y.Doc();
			Y.applyUpdate(replica, update);

			// Replica reads the same wraps, and the unwrap still works
			// against this device's secret because the AAD is just the
			// entity id (no doc/replica-instance binding).
			const list = listWraps(replica);
			expect(list).toHaveLength(1);
			const recovered = unwrapDekForRecipient(list[0] as MemberWrapPayload, device.secretKey, id);
			expect(Buffer.compare(recovered, dek)).toBe(0);
		});

		it("isMemberWrapPayload accepts valid payloads and rejects junk", () => {
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const valid = wrapDekForRecipient(dek, device.publicKey, "ent_x");
			expect(isMemberWrapPayload(valid)).toBe(true);
			expect(isMemberWrapPayload(null)).toBe(false);
			expect(isMemberWrapPayload({})).toBe(false);
			expect(isMemberWrapPayload({ ...valid, v: 2 })).toBe(false);
			expect(isMemberWrapPayload({ ...valid, alg: "other" })).toBe(false);
			expect(isMemberWrapPayload({ ...valid, recipientPubB64: 123 })).toBe(false);
		});

		it("listWraps skips non-conforming entries (forward-compat guard)", () => {
			const { doc, id } = freshEntity();
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			const wrap = wrapDekForRecipient(dek, device.publicKey, id);
			const arr = getWrapsArray(doc);
			doc.transact(() => {
				arr.push([wrap]);
				// A future schema bump that lands on an older client must not
				// crash the codec — entries with unknown shapes are skipped.
				arr.push([{ v: 999, junk: true } as unknown as MemberWrapPayload]);
			});
			const list = listWraps(doc);
			expect(list).toHaveLength(1);
			expect(list[0]?.recipientPubB64).toBe(wrap.recipientPubB64);
		});

		it("appended wraps survive Y.snapshot/Y.encodeStateVector exchange", () => {
			const { doc, id } = freshEntity();
			const device = generateDeviceX25519();
			const dek = generateSymmetricKey();
			appendWrap(doc, wrapDekForRecipient(dek, device.publicKey, id));

			const replica = new Y.Doc();
			const sv = Y.encodeStateVector(replica);
			const diff = Y.encodeStateAsUpdate(doc, sv);
			Y.applyUpdate(replica, diff);

			expect(listWraps(replica)).toHaveLength(1);
		});
	});
});
