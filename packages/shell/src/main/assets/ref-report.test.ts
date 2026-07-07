import { describe, expect, it } from "vitest";
import {
	AssetWireKind,
	decodeAssetRequest,
	encodeAssetRequest,
	encodeAssetResponse,
	refsFrameBytes,
} from "./asset-wire";
import { RefReportOutcome, sendAssetRefReport } from "./ref-report";

const hex = (seed: number): string => seed.toString(16).padStart(64, "0");

/** A manifest `parseAssetChunkManifest` accepts: 2 × 4-byte chunks. */
function manifest(assetId: string, hashes: [string, string]) {
	return {
		v: 1,
		assetId,
		mime: "image/png",
		chunkBytes: 4,
		totalRawLen: 8,
		chunks: [
			{ hash: hashes[0], encLen: 32, rawLen: 4 },
			{ hash: hashes[1], encLen: 32, rawLen: 4 },
		],
	};
}

describe("asset-wire Refs (Asset-B6 lockstep)", () => {
	it("round-trips a refs request and sizes it exactly", () => {
		const hashes = [hex(1), hex(2), hex(3)];
		const frame = encodeAssetRequest({
			kind: AssetWireKind.Refs,
			account: "acct",
			device: "dev-A",
			hashes,
		});
		expect(frame.length).toBe(refsFrameBytes("acct", "dev-A", 3));
		const decoded = decodeAssetRequest(frame);
		expect(decoded).toEqual({
			kind: AssetWireKind.Refs,
			account: "acct",
			device: "dev-A",
			hashes,
		});
	});

	it("round-trips an empty ref-set (a vault with no assets)", () => {
		const frame = encodeAssetRequest({
			kind: AssetWireKind.Refs,
			account: "acct",
			device: "dev-A",
			hashes: [],
		});
		const decoded = decodeAssetRequest(frame);
		expect(decoded.kind === AssetWireKind.Refs && decoded.hashes).toEqual([]);
	});

	it("rejects a non-64-hex ref entry at encode time", () => {
		expect(() =>
			encodeAssetRequest({
				kind: AssetWireKind.Refs,
				account: "acct",
				device: "dev-A",
				hashes: ["ZZ"],
			}),
		).toThrow(/64-hex/);
	});
});

function deps(over: Partial<Parameters<typeof sendAssetRefReport>[0]>) {
	const sent: Uint8Array[] = [];
	const base = {
		listPairs: () => [{ entityId: "e1", assetId: "a1" }],
		readManifest: async () => manifest("a1", [hex(1), hex(2)]),
		send: async (frame: Uint8Array) => {
			sent.push(frame);
			const req = decodeAssetRequest(frame);
			const count = req.kind === AssetWireKind.Refs ? req.hashes.length : 0;
			return encodeAssetResponse({ kind: AssetWireKind.Refs, ok: true, count });
		},
		account: "acct",
		device: "dev-A",
	};
	return { deps: { ...base, ...over }, sent };
}

describe("sendAssetRefReport", () => {
	it("sends the deduped, sorted full set and reports Sent on ack", async () => {
		const { deps: d, sent } = deps({
			listPairs: () => [
				{ entityId: "e1", assetId: "a1" },
				{ entityId: "e2", assetId: "a2" },
			],
			// a2 shares hex(2) with a1 — the set dedupes it.
			readManifest: async (_e, a) =>
				a === "a1" ? manifest("a1", [hex(2), hex(1)]) : manifest("a2", [hex(2), hex(3)]),
		});
		const result = await sendAssetRefReport(d);
		expect(result).toEqual({ outcome: RefReportOutcome.Sent, hashes: 3, pendingManifests: 0 });
		const req = decodeAssetRequest(sent[0] as Uint8Array);
		expect(req.kind === AssetWireKind.Refs && req.hashes).toEqual([hex(1), hex(2), hex(3)]);
	});

	it("skips pairs whose manifest hasn't landed (upload pending)", async () => {
		const { deps: d } = deps({
			listPairs: () => [
				{ entityId: "e1", assetId: "a1" },
				{ entityId: "e2", assetId: "a2" },
			],
			readManifest: async (_e, a) => (a === "a1" ? manifest("a1", [hex(1), hex(2)]) : null),
		});
		const result = await sendAssetRefReport(d);
		expect(result).toEqual({ outcome: RefReportOutcome.Sent, hashes: 2, pendingManifests: 1 });
	});

	it("aborts the whole report when a manifest read throws (never under-reports)", async () => {
		const { deps: d, sent } = deps({
			readManifest: async () => {
				throw new Error("ydoc worker gone");
			},
			log: () => {},
		});
		const result = await sendAssetRefReport(d);
		expect(result.outcome).toBe(RefReportOutcome.Aborted);
		expect(sent).toHaveLength(0);
	});

	it("aborts on an unparseable (non-null) manifest", async () => {
		const { deps: d, sent } = deps({
			readManifest: async () => ({ v: 2, garbage: true }),
			log: () => {},
		});
		const result = await sendAssetRefReport(d);
		expect(result.outcome).toBe(RefReportOutcome.Aborted);
		expect(sent).toHaveLength(0);
	});

	it("refuses to send a set past the frame ceiling (never a partial)", async () => {
		const { deps: d, sent } = deps({
			maxFrameBytes: refsFrameBytes("acct", "dev-A", 1), // room for one hash only
			log: () => {},
		});
		const result = await sendAssetRefReport(d);
		expect(result).toEqual({
			outcome: RefReportOutcome.TooLarge,
			hashes: 2,
			pendingManifests: 0,
		});
		expect(sent).toHaveLength(0);
	});

	it("reports Rejected when the node acks a different count", async () => {
		const { deps: d } = deps({
			send: async () => encodeAssetResponse({ kind: AssetWireKind.Refs, ok: true, count: 999 }),
		});
		const result = await sendAssetRefReport(d);
		expect(result.outcome).toBe(RefReportOutcome.Rejected);
	});

	it("sends an empty full set for a vault with no asset refs", async () => {
		const { deps: d, sent } = deps({ listPairs: () => [] });
		const result = await sendAssetRefReport(d);
		expect(result).toEqual({ outcome: RefReportOutcome.Sent, hashes: 0, pendingManifests: 0 });
		expect(sent).toHaveLength(1);
	});
});
