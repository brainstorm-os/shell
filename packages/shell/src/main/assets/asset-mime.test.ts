import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import {
	DEFAULT_ASSET_MIME,
	normalizeManifestMime,
	parseAssetChunkManifest,
	sealAssetChunks,
} from "./asset-chunks";

const ASSET = "asset-mime-1";
const CHUNK = 16;

describe("normalizeManifestMime", () => {
	it("maps absent/undefined/null to the inert default", () => {
		expect(normalizeManifestMime(undefined)).toBe(DEFAULT_ASSET_MIME);
		expect(normalizeManifestMime(null)).toBe(DEFAULT_ASSET_MIME);
		expect(DEFAULT_ASSET_MIME).toBe("application/octet-stream");
	});

	it("passes a valid token through lower-cased", () => {
		expect(normalizeManifestMime("image/png")).toBe("image/png");
		expect(normalizeManifestMime("application/pdf")).toBe("application/pdf");
		expect(normalizeManifestMime("image/svg+xml")).toBe("image/svg+xml");
		expect(normalizeManifestMime("IMAGE/PNG")).toBe("image/png");
	});

	it("rejects non-string values", () => {
		expect(normalizeManifestMime(42)).toBeNull();
		expect(normalizeManifestMime({})).toBeNull();
		expect(normalizeManifestMime(["image/png"])).toBeNull();
	});

	it("rejects header-injection / non-token payloads", () => {
		expect(normalizeManifestMime("image/png\r\nX-Evil: 1")).toBeNull();
		expect(normalizeManifestMime("image/png\nfoo")).toBeNull();
		expect(normalizeManifestMime("text/html; charset=utf-8")).toBeNull();
		expect(normalizeManifestMime("image/ png")).toBeNull();
		expect(normalizeManifestMime("image/png ")).toBeNull();
	});

	it("rejects tokens without a type/subtype slash", () => {
		expect(normalizeManifestMime("imagepng")).toBeNull();
		expect(normalizeManifestMime("image")).toBeNull();
	});

	it("rejects the empty string", () => {
		expect(normalizeManifestMime("")).toBeNull();
	});

	it("rejects an over-long type or subtype (> 63 chars)", () => {
		expect(normalizeManifestMime(`${"a".repeat(64)}/png`)).toBeNull();
		expect(normalizeManifestMime(`image/${"b".repeat(64)}`)).toBeNull();
	});
});

describe("parseAssetChunkManifest mime handling", () => {
	function baseManifest() {
		const dek = generateSymmetricKey();
		const { manifest } = sealAssetChunks(
			new Uint8Array(randomBytes(2 * CHUNK + 1)),
			dek,
			ASSET,
			"IMAGE/PNG",
			CHUNK,
		);
		return JSON.parse(JSON.stringify(manifest));
	}

	it("parses a valid manifest and preserves the lower-cased mime", () => {
		const parsed = parseAssetChunkManifest(baseManifest());
		expect(parsed).not.toBeNull();
		expect(parsed?.mime).toBe("image/png");
	});

	it("rejects the whole manifest on a header-injection mime", () => {
		const m = baseManifest();
		m.mime = "image/png\r\nEvil:1";
		expect(parseAssetChunkManifest(m)).toBeNull();
	});

	it("accepts a pre-mime manifest and defaults its mime (backward-compat)", () => {
		const { mime: _dropped, ...m } = baseManifest();
		expect("mime" in m).toBe(false);
		const parsed = parseAssetChunkManifest(m);
		expect(parsed).not.toBeNull();
		expect(parsed?.mime).toBe(DEFAULT_ASSET_MIME);
	});
});
