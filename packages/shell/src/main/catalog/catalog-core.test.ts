import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { describe, expect, it } from "vitest";
import {
	decodeIndexPayload,
	resolveCatalogVersion,
	validateCatalogIndex,
	validateSignedCatalog,
	verifyEnvelopeSignature,
} from "./catalog-core";
import type { CatalogIndex, CatalogListing } from "./catalog-wire-types";

function sampleListing(overrides: Partial<CatalogListing> = {}): CatalogListing {
	return {
		id: "io.brainstorm.notes",
		kind: "app",
		publisherKey: "ed25519:dev",
		name: "Notes",
		summary: "Rich-text notes.",
		iconUrl: "https://cdn.test/notes/icon.svg",
		channels: { stable: "1.5.0", beta: "1.6.0-beta.2" },
		versions: {
			"1.5.0": {
				manifestUrl: "https://cdn.test/notes/manifest.json",
				bundleUrl: "https://cdn.test/notes/io.brainstorm.notes-1.5.0.brainstorm",
				sha256: "a".repeat(64),
				signature: "sig",
				sdk: "1",
				minShell: "1.0.0",
			},
			"1.6.0-beta.2": {
				manifestUrl: "https://cdn.test/notes/manifest.json",
				bundleUrl: "https://cdn.test/notes/io.brainstorm.notes-1.6.0-beta.2.brainstorm",
				sha256: "b".repeat(64),
				signature: "sig",
				sdk: "1",
				minShell: "1.0.0",
			},
		},
		firstParty: true,
		...overrides,
	};
}

function indexWith(listing: CatalogListing): CatalogIndex {
	return {
		catalogId: "brainstorm-official",
		generatedAt: 1_700_000_000,
		ttlSeconds: 3600,
		listings: [listing],
	};
}

function sampleIndex(): CatalogIndex {
	return indexWith(sampleListing());
}

function encodePayload(index: CatalogIndex): string {
	return Buffer.from(JSON.stringify(index)).toString("base64url");
}

describe("validateSignedCatalog", () => {
	it("accepts a well-formed envelope", () => {
		expect(validateSignedCatalog({ payload: "p", kid: "k", signature: "s" })).toEqual({
			payload: "p",
			kid: "k",
			signature: "s",
		});
	});

	it("rejects missing fields and non-objects", () => {
		expect(validateSignedCatalog({ payload: "p", kid: "k" })).toBeNull();
		expect(validateSignedCatalog({ payload: "", kid: "k", signature: "s" })).toBeNull();
		expect(validateSignedCatalog(null)).toBeNull();
		expect(validateSignedCatalog("nope")).toBeNull();
		expect(validateSignedCatalog([])).toBeNull();
	});
});

describe("validateCatalogIndex / decodeIndexPayload", () => {
	it("round-trips a valid index through base64url", () => {
		const index = sampleIndex();
		const decoded = decodeIndexPayload(encodePayload(index));
		expect(decoded).toEqual(index);
	});

	it("drops optional fields that are absent", () => {
		const bare: CatalogListing = {
			id: "io.brainstorm.bare",
			kind: "app",
			publisherKey: "ed25519:dev",
			name: "Bare",
			channels: { stable: "1.0.0" },
			versions: {
				"1.0.0": {
					manifestUrl: "https://cdn.test/bare/manifest.json",
					bundleUrl: "https://cdn.test/bare/io.brainstorm.bare-1.0.0.brainstorm",
					sha256: "c".repeat(64),
					signature: "",
					sdk: "1",
					minShell: "1.0.0",
				},
			},
			firstParty: true,
		};
		const decoded = decodeIndexPayload(encodePayload(indexWith(bare)));
		expect(decoded?.listings[0]?.summary).toBeUndefined();
		expect(decoded?.listings[0]?.iconUrl).toBeUndefined();
	});

	it("rejects an index with a malformed listing (all-or-nothing)", () => {
		const bad = {
			catalogId: "c",
			generatedAt: 1,
			ttlSeconds: 1,
			listings: [{ id: "x" }],
		};
		expect(validateCatalogIndex(bad)).toBeNull();
	});

	it("rejects non-numeric metadata and missing roster", () => {
		expect(
			validateCatalogIndex({ catalogId: "c", generatedAt: "1", ttlSeconds: 1, listings: [] }),
		).toBeNull();
		expect(validateCatalogIndex({ catalogId: "c", generatedAt: 1, ttlSeconds: 1 })).toBeNull();
	});

	it("returns null on non-base64url or non-JSON payloads", () => {
		expect(decodeIndexPayload("not valid base64url!!")).toBeNull();
		expect(decodeIndexPayload(Buffer.from("{not json").toString("base64url"))).toBeNull();
	});
});

describe("resolveCatalogVersion", () => {
	const index = sampleIndex();

	it("resolves the channel pointer to its version entry", () => {
		const stable = resolveCatalogVersion(index, "io.brainstorm.notes", UpdateChannel.Stable);
		expect(stable?.version).toBe("1.5.0");
		expect(stable?.entry.sha256).toBe("a".repeat(64));
		const beta = resolveCatalogVersion(index, "io.brainstorm.notes", UpdateChannel.Beta);
		expect(beta?.version).toBe("1.6.0-beta.2");
	});

	it("returns null for an unknown listing, unpublished channel, or dangling pointer", () => {
		expect(resolveCatalogVersion(index, "io.brainstorm.absent", UpdateChannel.Stable)).toBeNull();
		const noBeta = indexWith(sampleListing({ channels: { stable: "1.5.0" } }));
		expect(resolveCatalogVersion(noBeta, "io.brainstorm.notes", UpdateChannel.Beta)).toBeNull();
		const dangling = indexWith(sampleListing({ channels: { stable: "9.9.9" } }));
		expect(resolveCatalogVersion(dangling, "io.brainstorm.notes", UpdateChannel.Stable)).toBeNull();
	});
});

describe("verifyEnvelopeSignature", () => {
	it("calls the injected verify over the payload ASCII bytes", () => {
		let seen: { payload: string; sigLen: number } | null = null;
		const ok = verifyEnvelopeSignature(
			{
				payload: "the-payload",
				kid: "k",
				signature: Buffer.from(new Uint8Array(64)).toString("base64url"),
			},
			new Uint8Array(32),
			(_pk, payload, sig) => {
				seen = { payload: new TextDecoder().decode(payload), sigLen: sig.length };
				return true;
			},
		);
		expect(ok).toBe(true);
		expect(seen).toEqual({ payload: "the-payload", sigLen: 64 });
	});

	it("returns false on a malformed base64url signature without calling verify", () => {
		let called = false;
		const ok = verifyEnvelopeSignature(
			{ payload: "p", kid: "k", signature: "not base64url!!" },
			new Uint8Array(32),
			() => {
				called = true;
				return true;
			},
		);
		expect(ok).toBe(false);
		expect(called).toBe(false);
	});
});
