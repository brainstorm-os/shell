import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { describe, expect, it, vi } from "vitest";
import { InstallOrigin, OFFICIAL_CATALOG_ID } from "../apps/install-provenance";
import type { InstallResult } from "../apps/installer";
import { CatalogClient, InMemoryCatalogCache } from "./catalog-client";
import type { CatalogIndex } from "./catalog-wire-types";
import { InstallEngine, type InstallEngineDeps, InstallOutcome } from "./install-engine";

const BUNDLE_BYTES = new Uint8Array([1, 2, 3, 4]);
const GOOD_SHA = "f".repeat(64);

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
				channels: { stable: "1.5.0" },
				versions: {
					"1.5.0": {
						manifestUrl: "https://cdn.test/notes/manifest.json",
						bundleUrl: "https://cdn.test/notes/io.brainstorm.notes-1.5.0.brainstorm",
						sha256: GOOD_SHA,
						signature: "sig-b64",
						sdk: "1",
						minShell: "1.0.0",
					},
				},
				firstParty: true,
			},
		],
	};
}

/** A CatalogClient whose cache already holds `index()` (no fetch needed). */
function seededCatalog(): CatalogClient {
	const cache = new InMemoryCatalogCache();
	cache.save(index());
	return new CatalogClient({
		fetchIndexJson: async () => ({}),
		trustedKeys: new Map(),
		cache,
	});
}

type Overrides = Partial<Omit<InstallEngineDeps, "catalog">> & { catalog?: CatalogClient };

function makeEngine(overrides: Overrides = {}): {
	engine: InstallEngine;
	installSpy: ReturnType<typeof vi.fn>;
} {
	const installSpy = vi.fn(
		async (): Promise<InstallResult> => ({
			ok: true,
			app: {
				id: "io.brainstorm.notes",
				version: "1.5.0",
				// biome-ignore lint/suspicious/noExplicitAny: test stub of the installer result
				manifest: {} as any,
				bundleDir: "/tmp/unpacked",
				bundleSha256: GOOD_SHA,
				installedAt: 1,
				// biome-ignore lint/suspicious/noExplicitAny: test stub of the installer result
				signature: {} as any,
			},
			capabilities: { granted: [], alreadyGranted: [] },
		}),
	);
	const engine = new InstallEngine({
		catalog: overrides.catalog ?? seededCatalog(),
		// biome-ignore lint/suspicious/noExplicitAny: only `install` is exercised here
		installer: { install: installSpy } as any,
		download: overrides.download ?? (async () => BUNDLE_BYTES),
		sha256Hex: overrides.sha256Hex ?? (() => GOOD_SHA),
		verifyBundle: overrides.verifyBundle ?? (() => true),
		unpack: overrides.unpack ?? (async () => "/tmp/unpacked"),
		...(overrides.catalogId ? { catalogId: overrides.catalogId } : {}),
	});
	return { engine, installSpy };
}

describe("InstallEngine", () => {
	it("downloads, verifies, unpacks, and installs with Catalog provenance", async () => {
		const { engine, installSpy } = makeEngine();
		const result = await engine.install("io.brainstorm.notes", UpdateChannel.Stable);
		expect(result).toEqual({
			outcome: InstallOutcome.Installed,
			appId: "io.brainstorm.notes",
			version: "1.5.0",
		});
		expect(installSpy).toHaveBeenCalledOnce();
		const arg = installSpy.mock.calls[0]?.[0];
		expect(arg.bundleDir).toBe("/tmp/unpacked");
		expect(arg.provenance).toEqual({
			origin: InstallOrigin.Catalog,
			catalogId: OFFICIAL_CATALOG_ID,
			channel: UpdateChannel.Stable,
			publisherKey: "ed25519:notes-pub",
			catalogVersion: "1.5.0",
		});
	});

	it("returns NotInCatalog for an unknown id or unpublished channel", async () => {
		const { engine, installSpy } = makeEngine();
		expect((await engine.install("io.acme.absent", UpdateChannel.Stable)).outcome).toBe(
			InstallOutcome.NotInCatalog,
		);
		expect((await engine.install("io.brainstorm.notes", UpdateChannel.Beta)).outcome).toBe(
			InstallOutcome.NotInCatalog,
		);
		expect(installSpy).not.toHaveBeenCalled();
	});

	it("fails closed on a download error", async () => {
		const { engine, installSpy } = makeEngine({
			download: async () => {
				throw new Error("offline");
			},
		});
		const result = await engine.install("io.brainstorm.notes", UpdateChannel.Stable);
		expect(result.outcome).toBe(InstallOutcome.DownloadFailed);
		expect(installSpy).not.toHaveBeenCalled();
	});

	it("rejects a bundle whose sha256 doesn't match the catalog entry", async () => {
		const verifyBundle = vi.fn(() => true);
		const { engine, installSpy } = makeEngine({ sha256Hex: () => "a".repeat(64), verifyBundle });
		const result = await engine.install("io.brainstorm.notes", UpdateChannel.Stable);
		expect(result.outcome).toBe(InstallOutcome.IntegrityFailed);
		// Integrity is checked before authenticity — verify never runs on a bad hash.
		expect(verifyBundle).not.toHaveBeenCalled();
		expect(installSpy).not.toHaveBeenCalled();
	});

	it("rejects a bundle whose signature doesn't verify", async () => {
		const { engine, installSpy } = makeEngine({ verifyBundle: () => false });
		const result = await engine.install("io.brainstorm.notes", UpdateChannel.Stable);
		expect(result.outcome).toBe(InstallOutcome.SignatureFailed);
		expect(installSpy).not.toHaveBeenCalled();
	});

	it("passes the verified hash + entry signature + publisher key to verifyBundle", async () => {
		const verifyBundle = vi.fn(() => true);
		const { engine } = makeEngine({ verifyBundle });
		await engine.install("io.brainstorm.notes", UpdateChannel.Stable);
		expect(verifyBundle).toHaveBeenCalledWith(GOOD_SHA, "sig-b64", "ed25519:notes-pub");
	});

	it("refuses to install an unsigned bundle (empty signature) without calling verify", async () => {
		// A catalog may list a not-yet-signed dev version; you can never install one.
		const cache = new InMemoryCatalogCache();
		const idx = index();
		const entry = idx.listings[0]?.versions["1.5.0"];
		if (entry) entry.signature = "";
		cache.save(idx);
		const catalog = new CatalogClient({
			fetchIndexJson: async () => ({}),
			trustedKeys: new Map(),
			cache,
		});
		const verifyBundle = vi.fn(() => true);
		const { engine, installSpy } = makeEngine({ catalog, verifyBundle });
		const result = await engine.install("io.brainstorm.notes", UpdateChannel.Stable);
		expect(result.outcome).toBe(InstallOutcome.SignatureFailed);
		expect(verifyBundle).not.toHaveBeenCalled();
		expect(installSpy).not.toHaveBeenCalled();
	});

	it("fails closed on an unpack error", async () => {
		const { engine, installSpy } = makeEngine({
			unpack: async () => {
				throw new Error("corrupt archive");
			},
		});
		const result = await engine.install("io.brainstorm.notes", UpdateChannel.Stable);
		expect(result.outcome).toBe(InstallOutcome.UnpackFailed);
		expect(installSpy).not.toHaveBeenCalled();
	});

	it("surfaces an installer rejection as InstallFailed", async () => {
		const { engine } = makeEngine();
		// Re-make with an installer that rejects.
		const failing = new InstallEngine({
			catalog: seededCatalog(),
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			installer: { install: async () => ({ ok: false, reason: "already installed" }) } as any,
			download: async () => BUNDLE_BYTES,
			sha256Hex: () => GOOD_SHA,
			verifyBundle: () => true,
			unpack: async () => "/tmp/unpacked",
		});
		void engine;
		const result = await failing.install("io.brainstorm.notes", UpdateChannel.Stable);
		expect(result).toEqual({ outcome: InstallOutcome.InstallFailed, reason: "already installed" });
	});
});
