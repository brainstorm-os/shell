import { describe, expect, it, vi } from "vitest";
import { UpdateChannel } from "../../shared/update-wire-types";
import { InstallOrigin, OFFICIAL_CATALOG_ID } from "../apps/install-provenance";
import type { UpdateResult } from "../apps/installer";
import { CatalogClient, InMemoryCatalogCache } from "./catalog-client";
import type { CatalogIndex } from "./catalog-wire-types";
import {
	UpdateClassification,
	UpdateEngine,
	type UpdateEngineDeps,
	UpdateOutcome,
} from "./update-engine";
import type { InstalledForUpdate } from "./update-planning";

const NEW_SHA = "f".repeat(64);

function entry(version: string) {
	return {
		manifestUrl: `https://cdn.test/notes/manifest-${version}.json`,
		bundleUrl: `https://cdn.test/notes/io.brainstorm.notes-${version}.brainstorm`,
		sha256: NEW_SHA,
		signature: "sig-b64",
		sdk: "1",
		minShell: "1.0.0",
	};
}

function index(): CatalogIndex {
	return {
		catalogId: OFFICIAL_CATALOG_ID,
		generatedAt: 1,
		ttlSeconds: 3600,
		listings: [
			{
				id: "io.brainstorm.notes",
				kind: "app",
				publisherKey: "ed25519:notes-pub",
				name: "Notes",
				channels: { stable: "1.6.0" },
				versions: { "1.6.0": entry("1.6.0") },
				firstParty: true,
			},
		],
	};
}

function seededCatalog(idx: CatalogIndex | null = index()): CatalogClient {
	const cache = new InMemoryCatalogCache();
	if (idx) cache.save(idx);
	return new CatalogClient({ fetchIndexJson: async () => ({}), trustedKeys: new Map(), cache });
}

const INSTALLED: InstalledForUpdate = {
	id: "io.brainstorm.notes",
	version: "1.5.0",
	channel: UpdateChannel.Stable,
	catalogTracked: true,
	publisherKey: "ed25519:notes-pub",
};

type Over = Partial<Omit<UpdateEngineDeps, "catalog">> & { catalog?: CatalogClient };

function makeEngine(over: Over = {}): {
	engine: UpdateEngine;
	updateSpy: ReturnType<typeof vi.fn>;
} {
	const updateSpy = vi.fn(
		async (): Promise<UpdateResult> => ({
			ok: true,
			app: {
				id: "io.brainstorm.notes",
				version: "1.6.0",
				// biome-ignore lint/suspicious/noExplicitAny: test stub of the installer result
				manifest: {} as any,
				bundleDir: "/tmp/unpacked",
				bundleSha256: NEW_SHA,
				installedAt: 1,
				// biome-ignore lint/suspicious/noExplicitAny: test stub of the installer result
				signature: {} as any,
			},
			capabilities: { added: [], removed: [], unchanged: [] },
		}),
	);
	const engine = new UpdateEngine({
		catalog: over.catalog ?? seededCatalog(),
		// biome-ignore lint/suspicious/noExplicitAny: only `update` is exercised
		installer: { update: updateSpy } as any,
		listInstalled: over.listInstalled ?? (() => [INSTALLED]),
		installedCapabilities: over.installedCapabilities ?? (() => ["storage.kv"]),
		fetchCapabilities: over.fetchCapabilities ?? (async () => ["storage.kv"]),
		autoUpdate: over.autoUpdate ?? (() => true),
		download: over.download ?? (async () => new Uint8Array([1, 2, 3])),
		sha256Hex: over.sha256Hex ?? (() => NEW_SHA),
		verifyBundle: over.verifyBundle ?? (() => true),
		unpack: over.unpack ?? (async () => "/tmp/unpacked"),
	});
	return { engine, updateSpy };
}

describe("UpdateEngine.check", () => {
	it("classifies a no-new-capability update as Auto", async () => {
		const { engine } = makeEngine({
			installedCapabilities: () => ["storage.kv"],
			fetchCapabilities: async () => ["storage.kv"],
		});
		const updates = await engine.check();
		expect(updates).toHaveLength(1);
		expect(updates[0]?.classification).toBe(UpdateClassification.Auto);
		expect(updates[0]?.newCapabilities).toEqual([]);
		expect(updates[0]?.toVersion).toBe("1.6.0");
	});

	it("classifies an update requesting new capabilities as NeedsConsent", async () => {
		const { engine } = makeEngine({
			installedCapabilities: () => ["storage.kv"],
			fetchCapabilities: async () => ["storage.kv", "mail.manage"],
		});
		const updates = await engine.check();
		expect(updates[0]?.classification).toBe(UpdateClassification.NeedsConsent);
		expect(updates[0]?.newCapabilities).toEqual(["mail.manage"]);
	});

	it("conservatively requires consent when the new manifest can't be read", async () => {
		const { engine } = makeEngine({
			fetchCapabilities: async () => {
				throw new Error("manifest fetch failed");
			},
		});
		const updates = await engine.check();
		expect(updates[0]?.classification).toBe(UpdateClassification.NeedsConsent);
	});

	it("stays total when fetchCapabilities resolves a non-array (garbage manifest body)", async () => {
		const { engine } = makeEngine({
			// HTTP 200 with an unexpected body that isn't a capability array.
			// biome-ignore lint/suspicious/noExplicitAny: deliberately wrong shape
			fetchCapabilities: async () => ({}) as any,
		});
		const updates = await engine.check();
		// No throw; conservatively classified NeedsConsent.
		expect(updates[0]?.classification).toBe(UpdateClassification.NeedsConsent);
	});

	it("returns nothing when the catalog index isn't cached yet", async () => {
		const { engine } = makeEngine({ catalog: seededCatalog(null) });
		expect(await engine.check()).toEqual([]);
	});
});

describe("UpdateEngine.applyAuto", () => {
	it("applies Auto updates and skips NeedsConsent ones", async () => {
		const { engine, updateSpy } = makeEngine({
			installedCapabilities: () => ["storage.kv"],
			fetchCapabilities: async () => ["storage.kv"], // no new caps → Auto
		});
		const results = await engine.applyAuto();
		expect(results).toEqual([
			{ id: "io.brainstorm.notes", outcome: UpdateOutcome.Updated, version: "1.6.0" },
		]);
		expect(updateSpy).toHaveBeenCalledOnce();
	});

	it("no-ops when auto-update is off", async () => {
		const { engine, updateSpy } = makeEngine({ autoUpdate: () => false });
		expect(await engine.applyAuto()).toEqual([]);
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("does not auto-apply an update that needs consent", async () => {
		const { engine, updateSpy } = makeEngine({
			installedCapabilities: () => ["storage.kv"],
			fetchCapabilities: async () => ["storage.kv", "mail.manage"],
		});
		expect(await engine.applyAuto()).toEqual([]);
		expect(updateSpy).not.toHaveBeenCalled();
	});
});

describe("UpdateEngine.apply", () => {
	it("acquires, verifies, and updates with bumped catalog provenance", async () => {
		const { engine, updateSpy } = makeEngine();
		const [candidate] = await engine.check();
		if (!candidate) throw new Error("expected an update candidate");
		const result = await engine.apply(candidate);
		expect(result).toEqual({
			id: "io.brainstorm.notes",
			outcome: UpdateOutcome.Updated,
			version: "1.6.0",
		});
		const arg = updateSpy.mock.calls[0]?.[0];
		expect(arg.provenance).toEqual({
			origin: InstallOrigin.Catalog,
			catalogId: OFFICIAL_CATALOG_ID,
			channel: UpdateChannel.Stable,
			publisherKey: "ed25519:notes-pub",
			catalogVersion: "1.6.0",
		});
	});

	it("fails closed on a bad signature without calling update", async () => {
		const { engine, updateSpy } = makeEngine({ verifyBundle: () => false });
		const [candidate] = await engine.check();
		if (!candidate) throw new Error("expected an update candidate");
		const result = await engine.apply(candidate);
		expect(result.outcome).toBe(UpdateOutcome.SignatureFailed);
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("surfaces an installer rejection as UpdateFailed", async () => {
		const { engine } = makeEngine();
		const failing = new UpdateEngine({
			catalog: seededCatalog(),
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			installer: { update: async () => ({ ok: false, reason: "version already installed" }) } as any,
			listInstalled: () => [INSTALLED],
			installedCapabilities: () => ["storage.kv"],
			fetchCapabilities: async () => ["storage.kv"],
			autoUpdate: () => true,
			download: async () => new Uint8Array([1]),
			sha256Hex: () => NEW_SHA,
			verifyBundle: () => true,
			unpack: async () => "/tmp/unpacked",
		});
		void engine;
		const [candidate] = await failing.check();
		if (!candidate) throw new Error("expected an update candidate");
		const result = await failing.apply(candidate);
		expect(result).toEqual({
			id: "io.brainstorm.notes",
			outcome: UpdateOutcome.UpdateFailed,
			reason: "version already installed",
		});
	});
});
