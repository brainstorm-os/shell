import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ed25519 } from "../test-support/crypto-test-helpers";
import {
	type AddDeviceInput,
	DevicesStore,
	canonicalAddDeviceBytes,
	signAddDeviceRecord,
	verifyAddDeviceRecord,
} from "./devices-store";

function freshDoc(): Y.Doc {
	const doc = new Y.Doc();
	DevicesStore.ensureRoot(doc);
	return doc;
}

function freshUserPair(): { sec: Uint8Array; pub: Uint8Array } {
	const kp = ed25519.keygen();
	return { sec: new Uint8Array(kp.secretKey), pub: new Uint8Array(kp.publicKey) };
}

function makeInput(overrides: Partial<AddDeviceInput> = {}): AddDeviceInput {
	return {
		deviceEd25519Pub: "device-edpub-base64",
		deviceX25519Pub: "device-xpub-base64",
		deviceLabel: "MacBook",
		addedAt: 1_700_000_000,
		addedBy: "user-pub-base64",
		...overrides,
	};
}

describe("DevicesStore", () => {
	it("add + list round-trip", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		const user = freshUserPair();
		const input = makeInput({ addedBy: Buffer.from(user.pub).toString("base64") });
		const record = signAddDeviceRecord(input, user.sec);
		store.add(record);
		const out = store.list();
		expect(out.length).toBe(1);
		expect(out[0]?.deviceEd25519Pub).toBe(input.deviceEd25519Pub);
		expect(out[0]?.sig).toBe(record.sig);
	});

	it("verify() succeeds for a record signed by the matching user-Ed25519", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		const user = freshUserPair();
		const input = makeInput({ addedBy: Buffer.from(user.pub).toString("base64") });
		const record = signAddDeviceRecord(input, user.sec);
		store.add(record);
		expect(store.verify(record, user.pub)).toBe(true);
	});

	it("verify() rejects a record signed by a different user-Ed25519 (forgery)", () => {
		const userA = freshUserPair();
		const userB = freshUserPair();
		const input = makeInput({ addedBy: Buffer.from(userA.pub).toString("base64") });
		const record = signAddDeviceRecord(input, userA.sec);
		expect(verifyAddDeviceRecord(record, userB.pub)).toBe(false);
	});

	it("verify() rejects a tampered record (canonical-bytes change invalidates sig)", () => {
		const user = freshUserPair();
		const input = makeInput({ addedBy: Buffer.from(user.pub).toString("base64") });
		const record = signAddDeviceRecord(input, user.sec);
		const tampered = { ...record, deviceLabel: "different" };
		expect(verifyAddDeviceRecord(tampered, user.pub)).toBe(false);
	});

	it("revoke() flips revokedAt on the matching record; list shows the post-revoke shape", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		const user = freshUserPair();
		const input = makeInput({ addedBy: Buffer.from(user.pub).toString("base64") });
		store.add(signAddDeviceRecord(input, user.sec));
		expect(store.revoke(input.deviceEd25519Pub, 1_800_000_000)).toBe(true);
		const records = store.list();
		expect(records[0]?.revokedAt).toBe(1_800_000_000);
	});

	it("revoke() on an unknown device returns false", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		expect(store.revoke("missing-pub")).toBe(false);
	});

	it("double-add of the same device is idempotent by default", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		const user = freshUserPair();
		const input = makeInput({ addedBy: Buffer.from(user.pub).toString("base64") });
		const record = signAddDeviceRecord(input, user.sec);
		const first = store.add(record);
		const second = store.add(record);
		expect(first.sig).toBe(second.sig);
		expect(store.list().length).toBe(1);
	});

	it("double-add throws when idempotent:false is requested", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc, { idempotent: false });
		const user = freshUserPair();
		const input = makeInput({ addedBy: Buffer.from(user.pub).toString("base64") });
		const record = signAddDeviceRecord(input, user.sec);
		store.add(record);
		expect(() => store.add(record)).toThrowError(/already exists/);
	});

	it("list() returns deep-cloned values (mutating a clone does not affect the store)", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		const user = freshUserPair();
		store.add(
			signAddDeviceRecord(makeInput({ addedBy: Buffer.from(user.pub).toString("base64") }), user.sec),
		);
		const out = store.list();
		(out[0] as { deviceLabel: string }).deviceLabel = "MUTATED";
		expect(store.list()[0]?.deviceLabel).toBe("MacBook");
	});

	it("canonicalAddDeviceBytes is stable across key-order permutations", () => {
		const input: AddDeviceInput = makeInput();
		const reordered: AddDeviceInput = {
			addedBy: input.addedBy,
			deviceLabel: input.deviceLabel,
			deviceEd25519Pub: input.deviceEd25519Pub,
			deviceX25519Pub: input.deviceX25519Pub,
			addedAt: input.addedAt,
		};
		expect(Buffer.compare(canonicalAddDeviceBytes(input), canonicalAddDeviceBytes(reordered))).toBe(
			0,
		);
	});

	it("isRevoked() returns false for unknown devices + true for revoked devices", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		const user = freshUserPair();
		const pubBase64 = "device-edpub-base64";
		const input = makeInput({
			deviceEd25519Pub: pubBase64,
			addedBy: Buffer.from(user.pub).toString("base64"),
		});
		const record = signAddDeviceRecord(input, user.sec);
		store.add(record);
		// Not yet revoked.
		expect(store.isRevoked(pubBase64)).toBe(false);
		expect(store.isRevoked("never-added")).toBe(false);
		store.revoke(pubBase64, 1_800_000_000);
		expect(store.isRevoked(pubBase64)).toBe(true);
	});

	it("isRevoked() accepts a Uint8Array sender pubkey (the wire-decoded form)", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		const user = freshUserPair();
		// Real 32-byte device-Ed25519 pubkey — encoded to base64 for storage,
		// passed as Uint8Array for the verify path that gets the sender pub
		// before any sig check.
		const devicePub = new Uint8Array(32);
		devicePub.fill(0xab);
		const pubBase64 = Buffer.from(devicePub).toString("base64");
		const input = makeInput({
			deviceEd25519Pub: pubBase64,
			addedBy: Buffer.from(user.pub).toString("base64"),
		});
		const record = signAddDeviceRecord(input, user.sec);
		store.add(record);
		expect(store.isRevoked(devicePub)).toBe(false);
		store.revoke(pubBase64, 1_800_000_000);
		expect(store.isRevoked(devicePub)).toBe(true);
	});

	it("isRevoked() rejects empty / whitespace input", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		expect(store.isRevoked("")).toBe(false);
		expect(store.isRevoked(new Uint8Array(0))).toBe(false);
	});

	it("listActive() drops revoked records but keeps fresh ones", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		const user = freshUserPair();
		const addedBy = Buffer.from(user.pub).toString("base64");
		const r1 = signAddDeviceRecord(makeInput({ deviceEd25519Pub: "dev-A", addedBy }), user.sec);
		const r2 = signAddDeviceRecord(makeInput({ deviceEd25519Pub: "dev-B", addedBy }), user.sec);
		store.add(r1);
		store.add(r2);
		store.revoke("dev-A", 1_800_000_000);
		const active = store.listActive(user.pub);
		expect(active.length).toBe(1);
		expect(active[0]?.deviceEd25519Pub).toBe("dev-B");
		expect(store.list().length).toBe(2); // list() still surfaces both.
	});

	it("listActive() drops a record whose signature does not verify (LAN-2b)", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		const user = freshUserPair();
		const addedBy = Buffer.from(user.pub).toString("base64");
		const good = signAddDeviceRecord(makeInput({ deviceEd25519Pub: "dev-good", addedBy }), user.sec);
		// Signed by SOMEONE ELSE — the shape a forged roster row takes. Before
		// 10.3c this bought LAN admission; now it would be sealed every entity DEK.
		const attacker = freshUserPair();
		const forged = signAddDeviceRecord(
			makeInput({ deviceEd25519Pub: "dev-forged", addedBy }),
			attacker.sec,
		);
		store.add(good);
		store.add(forged);

		const active = store.listActive(user.pub);
		expect(active.map((r) => r.deviceEd25519Pub)).toEqual(["dev-good"]);
		// `list()` stays unfiltered so Settings can still show the bad row to remove.
		expect(store.list().length).toBe(2);
	});

	it("listActive() returns nothing when the verifying key is wrong — fail closed", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		const user = freshUserPair();
		const addedBy = Buffer.from(user.pub).toString("base64");
		store.add(signAddDeviceRecord(makeInput({ deviceEd25519Pub: "dev-A", addedBy }), user.sec));

		expect(store.listActive(freshUserPair().pub)).toEqual([]);
	});

	it("rejects malformed records on add()", () => {
		const doc = freshDoc();
		const store = new DevicesStore(doc);
		expect(() => store.add(null as unknown as never)).toThrowError(/object/);
		expect(() =>
			store.add({
				deviceEd25519Pub: "",
				deviceX25519Pub: "x",
				deviceLabel: "L",
				addedAt: 1,
				addedBy: "b",
				sig: "s",
			} as never),
		).toThrowError(/deviceEd25519Pub/);
		expect(() =>
			store.add({
				deviceEd25519Pub: "a",
				deviceX25519Pub: "b",
				deviceLabel: "L",
				addedAt: Number.NaN,
				addedBy: "b",
				sig: "s",
			} as never),
		).toThrowError(/addedAt/);
	});
});
