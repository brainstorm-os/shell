/**
 * DevicesStore (Stage 10.5a, OQ-199).
 *
 * Append-only Y.Array of signed `add-device` records under
 * `meta.devices` on the **vault-properties** Y.Doc (a sibling of
 * `dashboard-store.ts`'s `appearance`/`icons`/`widgets` doc — see
 * `vault-properties-store.ts`). Single source of truth at vault level,
 * shared across every paired device via the same sync transport as any
 * other Yjs doc.
 *
 * Record shape (all 32-byte fields base64-encoded):
 *
 *   SignedAddDeviceRecord {
 *     deviceEd25519Pub : b64(32)
 *     deviceX25519Pub  : b64(32)
 *     deviceLabel      : string
 *     addedAt          : number (unix ms)
 *     addedBy          : b64(32)     user-Ed25519 pubkey of the device that
 *                                    signed (always the sovereign user key
 *                                    in v1; the first device self-signs).
 *     revokedAt?       : number      set on `revoke()`; record stays
 *     sig              : b64(64)     ed25519.sign(canonicalJSON(record - sig),
 *                                                 userEd25519Sec)
 *   }
 *
 * Canonical JSON for signing: sort keys alphabetically, omit `sig`, omit
 * `revokedAt` when absent (so the signature is over the *minted* shape,
 * not the post-revoke shape — `revoke()` does NOT re-sign; the signature
 * proves provenance, revocation is a separate append-only state flag).
 *
 * Verification path: read the user-Ed25519 pubkey from `VaultSession` (or
 * an explicit arg in tests) and ed25519-verify over the canonical bytes.
 * `list()` returns deep-cloned arrays (callers can't mutate the live Y.Array
 * by reference).
 *
 * Pure module (no Electron imports) so it's testable under Bun's vitest.
 */

import { ed25519Sign, ed25519Verify } from "@brainstorm-os/native";
import * as Y from "yjs";

export const DEVICES_META_KEY = "devices";
export const DEVICES_META_ROOT = "meta";

export const DEVICE_EDSIG_BYTES = 64;
export const DEVICE_PUB_BYTES = 32;

export type SignedAddDeviceRecord = {
	deviceEd25519Pub: string;
	deviceX25519Pub: string;
	deviceLabel: string;
	addedAt: number;
	addedBy: string;
	revokedAt?: number;
	sig: string;
};

export type AddDeviceInput = Omit<SignedAddDeviceRecord, "sig" | "revokedAt">;

/**
 * Canonical signing bytes for a record. Stable across encoders because we
 * write the keys ourselves in alphabetical order — no `JSON.stringify`
 * ordering surprise.
 */
export function canonicalAddDeviceBytes(record: AddDeviceInput): Uint8Array {
	const ordered = {
		addedAt: record.addedAt,
		addedBy: record.addedBy,
		deviceEd25519Pub: record.deviceEd25519Pub,
		deviceLabel: record.deviceLabel,
		deviceX25519Pub: record.deviceX25519Pub,
	};
	return new TextEncoder().encode(JSON.stringify(ordered));
}

export function signAddDeviceRecord(
	record: AddDeviceInput,
	userEd25519Sec: Uint8Array,
): SignedAddDeviceRecord {
	if (!(userEd25519Sec instanceof Uint8Array) || userEd25519Sec.length !== 32) {
		throw new Error("signAddDeviceRecord: userEd25519Sec must be 32 bytes");
	}
	const sig = ed25519Sign(userEd25519Sec, canonicalAddDeviceBytes(record));
	return { ...record, sig: Buffer.from(sig).toString("base64") };
}

export function verifyAddDeviceRecord(
	record: SignedAddDeviceRecord,
	userEd25519Pub: Uint8Array,
): boolean {
	if (!(userEd25519Pub instanceof Uint8Array) || userEd25519Pub.length !== DEVICE_PUB_BYTES) {
		return false;
	}
	let sig: Uint8Array;
	try {
		sig = new Uint8Array(Buffer.from(record.sig, "base64"));
	} catch {
		return false;
	}
	if (sig.length !== DEVICE_EDSIG_BYTES) return false;
	const { sig: _sig, revokedAt: _r, ...rest } = record;
	return ed25519Verify(userEd25519Pub, canonicalAddDeviceBytes(rest), sig);
}

export type DevicesStoreOptions = {
	/** When `false`, a duplicate add (same deviceEd25519Pub) is rejected.
	 *  When `true` (default), it's idempotent: the existing record is kept
	 *  unchanged and `add()` returns it. */
	idempotent?: boolean;
};

/**
 * Backed by a single Y.Map (`meta`) holding a Y.Array (`devices`) on the
 * vault-properties Y.Doc. Construct via `new DevicesStore(doc, opts)` —
 * the caller owns the Y.Doc lifecycle.
 */
export class DevicesStore {
	private readonly doc: Y.Doc;
	private readonly idempotent: boolean;

	constructor(doc: Y.Doc, opts: DevicesStoreOptions = {}) {
		this.doc = doc;
		this.idempotent = opts.idempotent ?? true;
	}

	private array(): Y.Array<SignedAddDeviceRecord> {
		return DevicesStore.ensureRoot(this.doc);
	}

	/** Initialise the meta.devices Y.Array if absent. Idempotent — returns
	 *  the existing array unchanged. Called lazily inside the store's own
	 *  mutation paths so the doc's first wire-observer run sees the schema
	 *  creation and persists it (the open()-factory pattern in
	 *  vault-properties-store.ts wires observers before any mutations). */
	static ensureRoot(doc: Y.Doc): Y.Array<SignedAddDeviceRecord> {
		const meta = doc.getMap<Y.Array<SignedAddDeviceRecord>>(DEVICES_META_ROOT);
		let arr = meta.get(DEVICES_META_KEY);
		if (!arr) {
			arr = new Y.Array<SignedAddDeviceRecord>();
			meta.set(DEVICES_META_KEY, arr);
		}
		return arr;
	}

	add(record: SignedAddDeviceRecord): SignedAddDeviceRecord {
		validateRecordShape(record);
		const arr = this.readArray();
		const existing = findRecord(arr, record.deviceEd25519Pub);
		if (existing) {
			if (this.idempotent) return existing;
			throw new Error(
				`DevicesStore.add: device ${record.deviceEd25519Pub} already exists (idempotent=false)`,
			);
		}
		this.doc.transact(() => {
			const live = this.array();
			live.push([deepClone(record)]);
		});
		return record;
	}

	revoke(deviceEd25519Pub: string, revokedAt: number = Date.now()): boolean {
		if (typeof deviceEd25519Pub !== "string" || deviceEd25519Pub.length === 0) return false;
		const arr = this.readArray();
		let index = -1;
		for (let i = 0; i < arr.length; i++) {
			const r = arr[i];
			if (r && r.deviceEd25519Pub === deviceEd25519Pub && r.revokedAt === undefined) {
				index = i;
				break;
			}
		}
		if (index < 0) return false;
		const current = arr[index];
		if (!current) return false;
		const next: SignedAddDeviceRecord = { ...current, revokedAt };
		this.doc.transact(() => {
			const live = this.array();
			live.delete(index, 1);
			live.insert(index, [next]);
		});
		return true;
	}

	list(): SignedAddDeviceRecord[] {
		return this.readArray().map(deepClone);
	}

	verify(record: SignedAddDeviceRecord, userEd25519Pub: Uint8Array): boolean {
		return verifyAddDeviceRecord(record, userEd25519Pub);
	}

	/**
	 * Cheap-to-call predicate the envelope-pipeline verifier consults
	 * BEFORE doing sig-verify or AEAD (Stage 10.5c, OQ-203). Returns
	 * `true` iff the device is present in `meta.devices` AND has a
	 * `revokedAt` stamp.
	 *
	 * Accepts either base64 (the on-record form) or raw `Uint8Array`
	 * (the on-wire `senderPub` form — the pipeline holds the decoded
	 * 32-byte sender pubkey before any sig check); the helper handles
	 * both. A device that was never added returns `false` — only an
	 * explicit revoke counts as revoked.
	 */
	isRevoked(deviceEd25519Pub: Uint8Array | string): boolean {
		const key =
			typeof deviceEd25519Pub === "string"
				? deviceEd25519Pub
				: Buffer.from(deviceEd25519Pub).toString("base64");
		if (key.length === 0) return false;
		const arr = this.readArray();
		for (const record of arr) {
			if (record.deviceEd25519Pub === key && record.revokedAt !== undefined) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Stage 10.5c — wrap-skip half of OQ-203. Returns the subset of
	 * `meta.devices` that are NOT revoked, for the wrap-bootstrap
	 * emitter to enumerate as fresh-wrap recipients. v1 does NOT re-wrap
	 * existing entity DEKs to exclude revoked devices — that's a v1.1
	 * rotation operation (the "decoupled access change from key
	 * rotation" decision recorded in OQ-27). The contract here is just:
	 * a fresh wrap for an entity skips a revoked device entirely.
	 */
	listActive(): SignedAddDeviceRecord[] {
		return this.list().filter((r) => r.revokedAt === undefined);
	}

	private readArray(): SignedAddDeviceRecord[] {
		const meta = this.doc.getMap<Y.Array<SignedAddDeviceRecord>>(DEVICES_META_ROOT);
		const arr = meta.get(DEVICES_META_KEY);
		if (!arr) return [];
		return arr.toArray();
	}
}

function findRecord(
	records: readonly SignedAddDeviceRecord[],
	deviceEd25519Pub: string,
): SignedAddDeviceRecord | null {
	for (const r of records) {
		if (r && r.deviceEd25519Pub === deviceEd25519Pub) return r;
	}
	return null;
}

function validateRecordShape(record: SignedAddDeviceRecord): void {
	if (!record || typeof record !== "object") {
		throw new Error("DevicesStore.add: record must be an object");
	}
	if (typeof record.deviceEd25519Pub !== "string" || record.deviceEd25519Pub.length === 0) {
		throw new Error("DevicesStore.add: deviceEd25519Pub must be a non-empty string");
	}
	if (typeof record.deviceX25519Pub !== "string" || record.deviceX25519Pub.length === 0) {
		throw new Error("DevicesStore.add: deviceX25519Pub must be a non-empty string");
	}
	if (typeof record.deviceLabel !== "string") {
		throw new Error("DevicesStore.add: deviceLabel must be a string");
	}
	if (typeof record.addedAt !== "number" || !Number.isFinite(record.addedAt)) {
		throw new Error("DevicesStore.add: addedAt must be a finite number");
	}
	if (typeof record.addedBy !== "string" || record.addedBy.length === 0) {
		throw new Error("DevicesStore.add: addedBy must be a non-empty string");
	}
	if (typeof record.sig !== "string" || record.sig.length === 0) {
		throw new Error("DevicesStore.add: sig must be a non-empty string");
	}
}

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
