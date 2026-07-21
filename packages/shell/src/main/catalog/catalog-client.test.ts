import { ed25519GetPublicKey, ed25519Sign } from "@brainstorm-os/native";
import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { beforeEach, describe, expect, it } from "vitest";
import {
	CatalogClient,
	CatalogRefreshStatus,
	type CatalogTrustedKeys,
	InMemoryCatalogCache,
} from "./catalog-client";
import type { CatalogIndex, SignedCatalog } from "./catalog-wire-types";

const SEED = new Uint8Array(32).map((_, i) => (i + 3) & 0xff);
const KID = "catalog-k1";

function sampleIndex(): CatalogIndex {
	return {
		catalogId: "brainstorm-official",
		generatedAt: 1_700_000_000,
		ttlSeconds: 3600,
		listings: [
			{
				id: "io.brainstorm.notes",
				kind: "app",
				publisherKey: "ed25519:dev",
				name: "Notes",
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
			},
		],
	};
}

/** Build a real signed envelope (native Ed25519) the client's default verify accepts. */
function signEnvelope(index: CatalogIndex, kid = KID): SignedCatalog {
	const payload = Buffer.from(JSON.stringify(index)).toString("base64url");
	const sig = ed25519Sign(SEED, new TextEncoder().encode(payload));
	return { payload, kid, signature: Buffer.from(sig).toString("base64url") };
}

function trustedKeys(): CatalogTrustedKeys {
	return new Map([[KID, ed25519GetPublicKey(SEED)]]);
}

describe("CatalogClient", () => {
	let cache: InMemoryCatalogCache;
	beforeEach(() => {
		cache = new InMemoryCatalogCache();
	});

	function client(fetchIndexJson: () => Promise<unknown>): CatalogClient {
		return new CatalogClient({ fetchIndexJson, trustedKeys: trustedKeys(), cache });
	}

	it("fetches, verifies, and caches a well-signed index", async () => {
		const envelope = signEnvelope(sampleIndex());
		const c = client(async () => envelope);
		const result = await c.refresh();
		expect(result.status).toBe(CatalogRefreshStatus.Ok);
		expect(result.index?.catalogId).toBe("brainstorm-official");
		expect(c.listings().map((l) => l.id)).toEqual(["io.brainstorm.notes"]);
		expect(c.listing("io.brainstorm.notes")?.name).toBe("Notes");
	});

	it("resolves a listing's version per channel after refresh", async () => {
		const c = client(async () => signEnvelope(sampleIndex()));
		await c.refresh();
		expect(c.resolveVersion("io.brainstorm.notes", UpdateChannel.Stable)?.version).toBe("1.5.0");
		expect(c.resolveVersion("io.brainstorm.notes", UpdateChannel.Beta)?.version).toBe("1.6.0-beta.2");
		expect(c.resolveVersion("io.brainstorm.absent", UpdateChannel.Stable)).toBeNull();
	});

	it("rejects a tampered payload and keeps the last good index", async () => {
		// First a good refresh to seed the cache.
		const good = signEnvelope(sampleIndex());
		const c = client(async () => good);
		await c.refresh();

		// Now serve a tampered payload (signature no longer matches).
		const tampered: SignedCatalog = { ...good, payload: `${good.payload}x` };
		const c2 = new CatalogClient({
			fetchIndexJson: async () => tampered,
			trustedKeys: trustedKeys(),
			cache,
		});
		const result = await c2.refresh();
		expect(result.status).toBe(CatalogRefreshStatus.Unverified);
		// Last good index is preserved.
		expect(result.index?.catalogId).toBe("brainstorm-official");
		expect(c2.listings()).toHaveLength(1);
	});

	it("rejects an index signed under an untrusted kid", async () => {
		const envelope = signEnvelope(sampleIndex(), "unknown-kid");
		const result = await client(async () => envelope).refresh();
		expect(result.status).toBe(CatalogRefreshStatus.Unverified);
		expect(result.index).toBeNull();
	});

	it("is total on a fetch failure — Unavailable, last good kept", async () => {
		// Seed the cache, then a failing fetch must not lose it.
		const c = client(async () => signEnvelope(sampleIndex()));
		await c.refresh();
		const c2 = new CatalogClient({
			fetchIndexJson: async () => {
				throw new Error("offline");
			},
			trustedKeys: trustedKeys(),
			cache,
		});
		const result = await c2.refresh();
		expect(result.status).toBe(CatalogRefreshStatus.Unavailable);
		expect(result.index?.catalogId).toBe("brainstorm-official");
	});

	it("treats a garbage envelope shape as Unavailable", async () => {
		const result = await client(async () => ({ not: "an envelope" })).refresh();
		expect(result.status).toBe(CatalogRefreshStatus.Unavailable);
		expect(result.index).toBeNull();
	});

	it("treats a verified-but-malformed payload as Unverified (never caches it)", async () => {
		// Sign a payload that is valid base64url but not a valid index.
		const payload = Buffer.from(JSON.stringify({ catalogId: "c" })).toString("base64url");
		const sig = ed25519Sign(SEED, new TextEncoder().encode(payload));
		const envelope: SignedCatalog = {
			payload,
			kid: KID,
			signature: Buffer.from(sig).toString("base64url"),
		};
		const result = await client(async () => envelope).refresh();
		expect(result.status).toBe(CatalogRefreshStatus.Unverified);
		expect(cache.load()).toBeNull();
	});
});
