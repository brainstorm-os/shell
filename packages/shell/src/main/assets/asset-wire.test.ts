import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import { MemoryAssetCas } from "./asset-cas";
import { downloadAsset, uploadAsset } from "./asset-transport";
import {
	type AssetRequest,
	AssetWireKind,
	WireAssetCas,
	decodeAssetRequest,
	decodeAssetResponse,
	encodeAssetRequest,
	encodeAssetResponse,
	serveAssetRequest,
} from "./asset-wire";

const HASH = "a".repeat(64);

describe("request codec round-trip", () => {
	it("Has", () => {
		const r = decodeAssetRequest(encodeAssetRequest({ kind: AssetWireKind.Has, hash: HASH }));
		expect(r).toEqual({ kind: AssetWireKind.Has, hash: HASH });
	});
	it("Get", () => {
		const r = decodeAssetRequest(encodeAssetRequest({ kind: AssetWireKind.Get, hash: HASH }));
		expect(r).toEqual({ kind: AssetWireKind.Get, hash: HASH });
	});
	it("Put carries the chunk bytes intact", () => {
		const chunk = new Uint8Array(randomBytes(1000));
		const r = decodeAssetRequest(encodeAssetRequest({ kind: AssetWireKind.Put, hash: HASH, chunk }));
		expect(r.kind).toBe(AssetWireKind.Put);
		if (r.kind === AssetWireKind.Put)
			expect(Buffer.from(r.chunk).equals(Buffer.from(chunk))).toBe(true);
	});
});

describe("response codec round-trip", () => {
	it("Has present/absent", () => {
		expect(
			decodeAssetResponse(encodeAssetResponse({ kind: AssetWireKind.Has, present: true })),
		).toEqual({ kind: AssetWireKind.Has, present: true });
		expect(
			decodeAssetResponse(encodeAssetResponse({ kind: AssetWireKind.Has, present: false })),
		).toEqual({ kind: AssetWireKind.Has, present: false });
	});
	it("Put ok", () => {
		expect(decodeAssetResponse(encodeAssetResponse({ kind: AssetWireKind.Put, ok: true }))).toEqual({
			kind: AssetWireKind.Put,
			ok: true,
		});
	});
	it("Get found/not-found", () => {
		const chunk = new Uint8Array(randomBytes(500));
		const found = decodeAssetResponse(
			encodeAssetResponse({ kind: AssetWireKind.Get, found: true, chunk }),
		);
		expect(found.kind).toBe(AssetWireKind.Get);
		if (found.kind === AssetWireKind.Get && found.found)
			expect(Buffer.from(found.chunk).equals(Buffer.from(chunk))).toBe(true);
		expect(
			decodeAssetResponse(encodeAssetResponse({ kind: AssetWireKind.Get, found: false })),
		).toEqual({ kind: AssetWireKind.Get, found: false });
	});
});

describe("malformed frames are rejected", () => {
	it("rejects a too-short / bad-length / non-JSON / unknown-kind frame", () => {
		expect(() => decodeAssetRequest(new Uint8Array([0, 0]))).toThrow();
		const bad = new Uint8Array(8);
		new DataView(bad.buffer).setUint32(0, 999, false); // header longer than frame
		expect(() => decodeAssetRequest(bad)).toThrow();
		// A response frame decoded as a request is rejected (it has no hash).
		expect(() =>
			decodeAssetRequest(encodeAssetResponse({ kind: AssetWireKind.Put, ok: true })),
		).toThrow();
		// A genuinely-unknown verb is rejected as a bad kind.
		const bogus = encodeAssetRequest({ kind: "bogus", hash: HASH } as unknown as AssetRequest);
		expect(() => decodeAssetRequest(bogus)).toThrow(/bad kind/);
	});
});

describe("WireAssetCas over a loopback node", () => {
	// The transport: hand the request straight to a node-side responder backed
	// by an in-memory CAS — exactly what the WS binding will do (Asset-B3).
	function loopback() {
		const node = new MemoryAssetCas();
		const cas = new WireAssetCas((req) => serveAssetRequest(node, req));
		return { node, cas };
	}

	it("has/put/get round-trips through the wire", async () => {
		const { cas } = loopback();
		const chunk = new Uint8Array(randomBytes(2048));
		const hash = "deadbeef".repeat(8);
		expect(await cas.has(hash)).toBe(false);
		await cas.put(hash, chunk);
		expect(await cas.has(hash)).toBe(true);
		const got = await cas.get(hash);
		expect(got && Buffer.from(got).equals(Buffer.from(chunk))).toBe(true);
		expect(await cas.get("f".repeat(64))).toBeNull();
	});

	it("end-to-end: uploadAsset → wire → downloadAsset reassembles byte-identically", async () => {
		const dek = generateSymmetricKey();
		const { cas } = loopback();
		const plain = new Uint8Array(randomBytes(5 * 16 + 9));
		const { manifest } = await uploadAsset(plain, dek, "asset-e2e", cas, 16);
		const back = await downloadAsset(manifest, dek, cas);
		expect(Buffer.from(back).equals(Buffer.from(plain))).toBe(true);
	});
});
