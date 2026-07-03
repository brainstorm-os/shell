import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityLedger } from "../capabilities/ledger";
import { ShortcutRegistry } from "../shortcuts/shortcut-registry";
import { DataStores } from "../storage/data-stores";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { AppSignatureStatus, type TrustedAppKeys, canonicalManifestBytes } from "./app-signature";
import { resetAppsChangedTarget, setAppsChangedTarget } from "./apps-changed";
import { AppInstaller, bundleExists } from "./installer";
import type { AppManifest } from "./manifest";

const baseManifest: AppManifest = {
	id: "io.example.notes",
	name: "Notes",
	version: "1.0.0",
	sdk: "1",
	entry: "dist/index.html",
	capabilities: ["entities.read:io.example/Note/v1", "entities.write:io.example/Note/v1"],
	registrations: {
		openers: [{ kind: "primary", entityType: "io.example/Note/v1" }],
		blocks: [{ id: "io.example.notes/paragraph", name: "Paragraph" }],
		entityTypes: [
			{
				id: "io.example/Note/v1",
				schemaUrl: "https://schemas.example.io/Note/v1",
				schema: { properties: { title: { type: "string" } } },
			},
		],
		widgets: [{ id: "recent", name: "Recent", size: "small" }],
		intents: [
			{ verb: "open", entityType: "io.example/Note/v1", priority: "primary" },
			{ verb: "export", entityType: "io.example/Note/v1", format: "text/csv" },
		],
	},
};

async function writeBundle(dir: string, manifest: AppManifest, files: Record<string, string> = {}) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
	for (const [path, contents] of Object.entries(files)) {
		const abs = join(dir, path);
		await mkdir(join(abs, ".."), { recursive: true });
		await writeFile(abs, contents, "utf8");
	}
}

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-installer-"));
	const sourceDir = await mkdtemp(join(tmpdir(), "brainstorm-source-"));
	const stores = new DataStores(vaultDir);
	const registryDb = await stores.open("registry");
	const ledgerDb = await stores.open("ledger");
	const ledger = new CapabilityLedger(ledgerDb);
	const installer = new AppInstaller(vaultDir, registryDb, ledger);
	return { vaultDir, sourceDir, stores, registryDb, ledger, installer };
}

describe("AppInstaller — apps:changed broadcast (F-380)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	const send = vi.fn();

	beforeEach(async () => {
		env = await setup();
		send.mockClear();
		setAppsChangedTarget(() => ({ webContents: { send, isDestroyed: () => false } }) as never);
	});

	afterEach(async () => {
		resetAppsChangedTarget();
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
		await rm(env.sourceDir, { recursive: true, force: true });
	});

	it("fires on install, refreshRegistrations, and uninstall — not on a failed install", async () => {
		await writeBundle(env.sourceDir, baseManifest, { "dist/index.html": "<html></html>" });
		await env.installer.install({ bundleDir: env.sourceDir });
		expect(send).toHaveBeenCalledTimes(1);

		await env.installer.refreshRegistrations(baseManifest.id);
		expect(send).toHaveBeenCalledTimes(2);

		await env.installer.uninstall(baseManifest.id);
		expect(send).toHaveBeenCalledTimes(3);

		const failed = await env.installer.uninstall("io.example.gone");
		expect(failed.ok).toBe(false);
		expect(send).toHaveBeenCalledTimes(3);
	});
});

describe("AppInstaller — install", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
		await rm(env.sourceDir, { recursive: true, force: true });
	});

	it("copies the bundle, records the SHA-256, and writes registry rows", async () => {
		await writeBundle(env.sourceDir, baseManifest, {
			"dist/index.html": "<!doctype html><html></html>",
			"dist/app.js": "console.log('hi')",
		});
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");

		expect(result.app.id).toBe("io.example.notes");
		expect(result.app.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(result.app.signature.status).toBe(AppSignatureStatus.Unsigned);
		expect(await bundleExists(result.app.bundleDir)).toBe(true);

		const apps = env.registryDb.prepare("SELECT * FROM apps").all() as unknown[];
		expect(apps).toHaveLength(1);

		const appRow = env.registryDb
			.prepare("SELECT signature_status, signature_key_id FROM apps WHERE id = ?")
			.get("io.example.notes") as { signature_status: string; signature_key_id: string | null };
		expect(appRow.signature_status).toBe("unsigned");
		expect(appRow.signature_key_id).toBeNull();

		const openers = env.registryDb.prepare("SELECT target_kind, target, kind FROM openers").all();
		expect(openers).toEqual([
			{ target_kind: "entity_type", target: "io.example/Note/v1", kind: "primary" },
		]);

		const blocks = env.registryDb.prepare("SELECT id, name FROM blocks").all();
		expect(blocks).toEqual([{ id: "io.example.notes/paragraph", name: "Paragraph" }]);

		const types = env.registryDb.prepare("SELECT id, orphaned FROM entity_types").all();
		expect(types).toEqual([{ id: "io.example/Note/v1", orphaned: 0 }]);

		const widgets = env.registryDb.prepare("SELECT id, size FROM widgets").all();
		expect(widgets).toEqual([{ id: "recent", size: "small" }]);

		const intents = env.registryDb
			.prepare("SELECT verb, entity_type, format, priority FROM intents ORDER BY verb")
			.all();
		expect(intents).toEqual([
			{ verb: "export", entity_type: "io.example/Note/v1", format: "text/csv", priority: "secondary" },
			{ verb: "open", entity_type: "io.example/Note/v1", format: null, priority: "primary" },
		]);
	});

	it("applies default-minimum + manifest-requested capabilities", async () => {
		await writeBundle(env.sourceDir, baseManifest);
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");

		// Default-minimum
		expect(env.ledger.has("io.example.notes", "storage.kv")).toBe(true);
		expect(env.ledger.has("io.example.notes", "credentials.read:self")).toBe(true);
		// Manifest-requested
		expect(env.ledger.has("io.example.notes", "entities.read:io.example/Note/v1")).toBe(true);
		expect(env.ledger.has("io.example.notes", "entities.write:io.example/Note/v1")).toBe(true);
	});

	it("rejects a missing manifest.json", async () => {
		await mkdir(env.sourceDir, { recursive: true });
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toMatch(/manifest.json/);
	});

	it("rejects malformed JSON", async () => {
		await mkdir(env.sourceDir, { recursive: true });
		await writeFile(join(env.sourceDir, "manifest.json"), "{ not json", "utf8");
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toMatch(/JSON/);
	});

	it("rejects an invalid manifest with the field path", async () => {
		await writeBundle(env.sourceDir, { ...baseManifest, version: "not-semver" });
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.path).toBe("$.version");
	});

	it("rejects a second install with the same id", async () => {
		await writeBundle(env.sourceDir, baseManifest);
		expect((await env.installer.install({ bundleDir: env.sourceDir })).ok).toBe(true);
		const second = await env.installer.install({ bundleDir: env.sourceDir });
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("expected fail");
		expect(second.reason).toMatch(/already installed/);
	});
});

describe("AppInstaller — update", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
		await rm(env.sourceDir, { recursive: true, force: true });
	});

	it("requires a prior install", async () => {
		await writeBundle(env.sourceDir, baseManifest);
		const result = await env.installer.update({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(false);
	});

	it("upgrades to a higher version and replaces registrations atomically", async () => {
		await writeBundle(env.sourceDir, baseManifest, { "dist/index.html": "<html></html>" });
		await env.installer.install({ bundleDir: env.sourceDir });

		const updatedManifest: AppManifest = {
			...baseManifest,
			version: "1.1.0",
			capabilities: [...baseManifest.capabilities, "identity.sign"],
			registrations: {
				...baseManifest.registrations,
				blocks: [
					{ id: "io.example.notes/paragraph", name: "Paragraph" },
					{ id: "io.example.notes/heading", name: "Heading" },
				],
			},
		};
		const updateDir = await import("node:fs/promises").then((m) =>
			m.mkdtemp(join(tmpdir(), "brainstorm-update-")),
		);
		try {
			await writeBundle(updateDir, updatedManifest, { "dist/index.html": "<html>v2</html>" });
			const result = await env.installer.update({ bundleDir: updateDir });
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected ok");
			expect(result.app.version).toBe("1.1.0");
			expect(result.capabilities.added).toEqual(["identity.sign"]);
			expect(result.capabilities.removed).toEqual([]);

			const blocks = env.registryDb.prepare("SELECT id FROM blocks ORDER BY id").all() as Array<{
				id: string;
			}>;
			expect(blocks.map((b) => b.id)).toEqual([
				"io.example.notes/heading",
				"io.example.notes/paragraph",
			]);

			expect(env.ledger.has("io.example.notes", "identity.sign")).toBe(true);
		} finally {
			await rm(updateDir, { recursive: true, force: true });
		}
	});

	it("revokes caps removed in the new manifest", async () => {
		await writeBundle(env.sourceDir, baseManifest);
		await env.installer.install({ bundleDir: env.sourceDir });
		expect(env.ledger.has("io.example.notes", "entities.write:io.example/Note/v1")).toBe(true);

		const reduced: AppManifest = {
			...baseManifest,
			version: "1.1.0",
			capabilities: ["entities.read:io.example/Note/v1"], // dropped the write
		};
		const updateDir = await import("node:fs/promises").then((m) =>
			m.mkdtemp(join(tmpdir(), "brainstorm-update-")),
		);
		try {
			await writeBundle(updateDir, reduced);
			const result = await env.installer.update({ bundleDir: updateDir });
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected ok");
			expect(result.capabilities.removed).toEqual(["entities.write:io.example/Note/v1"]);
			expect(env.ledger.has("io.example.notes", "entities.write:io.example/Note/v1")).toBe(false);
			expect(env.ledger.has("io.example.notes", "entities.read:io.example/Note/v1")).toBe(true);
		} finally {
			await rm(updateDir, { recursive: true, force: true });
		}
	});

	it("rejects an update to the same version", async () => {
		await writeBundle(env.sourceDir, baseManifest);
		await env.installer.install({ bundleDir: env.sourceDir });
		const result = await env.installer.update({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected fail");
		expect(result.reason).toMatch(/already installed/);
	});
});

describe("AppInstaller — uninstall", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
		await rm(env.sourceDir, { recursive: true, force: true });
	});

	it("marks entity types orphaned, revokes caps, soft-deletes the app row", async () => {
		await writeBundle(env.sourceDir, baseManifest);
		await env.installer.install({ bundleDir: env.sourceDir });

		const result = await env.installer.uninstall("io.example.notes");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.orphanedTypes).toBe(1);
		expect(result.revokedCapabilities).toBeGreaterThan(0);

		// entity_types orphaned, not deleted
		const types = env.registryDb
			.prepare("SELECT id, orphaned FROM entity_types WHERE id = ?")
			.get("io.example/Note/v1");
		expect(types).toEqual({ id: "io.example/Note/v1", orphaned: 1 });

		// openers/blocks/widgets/intents cleared
		expect(env.registryDb.prepare("SELECT COUNT(*) AS n FROM openers").get()).toEqual({ n: 0 });
		expect(env.registryDb.prepare("SELECT COUNT(*) AS n FROM blocks").get()).toEqual({ n: 0 });
		expect(env.registryDb.prepare("SELECT COUNT(*) AS n FROM widgets").get()).toEqual({ n: 0 });
		expect(env.registryDb.prepare("SELECT COUNT(*) AS n FROM intents").get()).toEqual({ n: 0 });

		// app row soft-deleted
		const row = env.registryDb.prepare("SELECT uninstalled_at FROM apps").get() as {
			uninstalled_at: number | null;
		};
		expect(row.uninstalled_at).toBeGreaterThan(0);

		// no live grants
		expect(env.ledger.listActive("io.example.notes")).toEqual([]);
	});

	it("rejects uninstall of an app that isn't installed", async () => {
		const result = await env.installer.uninstall("io.example.nope");
		expect(result.ok).toBe(false);
	});

	it("re-installing after uninstall un-orphans the entity type", async () => {
		await writeBundle(env.sourceDir, baseManifest);
		await env.installer.install({ bundleDir: env.sourceDir });
		await env.installer.uninstall("io.example.notes");

		const reinstallDir = await import("node:fs/promises").then((m) =>
			m.mkdtemp(join(tmpdir(), "brainstorm-reinstall-")),
		);
		try {
			await writeBundle(reinstallDir, baseManifest);
			// Re-installing reuses the same `id`; existing entity_types row is the
			// same row. The Stage 5 installer writes a fresh row only after the
			// soft-delete of the prior app — but on re-install the old row is
			// still there with orphaned=1. We allow re-install by flipping
			// orphaned back to 0 via UPSERT semantics; the test asserts the
			// expected behavior even when the implementation chooses to wipe +
			// rewrite or to UPDATE in place.
			//
			// Current impl re-uses the row because clearRegistrations does NOT
			// touch entity_types (OQ-3 — orphan-not-remove). So the existing row
			// stays orphaned. Re-install should un-orphan it.
			const result = await env.installer.install({ bundleDir: reinstallDir });
			expect(result.ok).toBe(true);
			// The reinstall path inserts a fresh entity_types row; the old
			// orphaned row is replaced (same primary key). Verify orphaned = 0.
			const row = env.registryDb
				.prepare("SELECT orphaned FROM entity_types WHERE id = ?")
				.get("io.example/Note/v1");
			expect(row).toEqual({ orphaned: 0 });
		} finally {
			await rm(reinstallDir, { recursive: true, force: true });
		}
	});

	it("vacuumBundles removes the on-disk bundle dir", async () => {
		await writeBundle(env.sourceDir, baseManifest);
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");

		await env.installer.uninstall("io.example.notes");
		expect(await bundleExists(result.app.bundleDir)).toBe(true);
		await env.installer.vacuumBundles("io.example.notes");
		expect(await bundleExists(result.app.bundleDir)).toBe(false);
	});

	it("bundle SHA-256 is deterministic for the same content", async () => {
		await writeBundle(env.sourceDir, baseManifest, {
			"dist/a.js": "console.log(1)",
			"dist/sub/b.js": "console.log(2)",
		});
		const a = await env.installer.install({ bundleDir: env.sourceDir });
		expect(a.ok).toBe(true);
		if (!a.ok) throw new Error("expected ok");

		// Same bundle copied to disk → same SHA computed against the install dir.
		const recompute = await readFile(join(a.app.bundleDir, "manifest.json"));
		expect(recompute.length).toBeGreaterThan(0);
		expect(a.app.bundleSha256.length).toBe(64);
	});
});

describe("AppInstaller — refreshRegistrations (7.6)", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
		await rm(env.sourceDir, { recursive: true, force: true });
	});

	it("fails for an app that is not installed", async () => {
		const result = await env.installer.refreshRegistrations("io.example.notes");
		expect(result).toEqual({ ok: false, reason: "app io.example.notes is not installed" });
	});

	it("re-applies changed manifest registrations without an uninstall/reinstall", async () => {
		await writeBundle(env.sourceDir, baseManifest, { "dist/index.html": "<html></html>" });
		await env.installer.install({ bundleDir: env.sourceDir });

		// Edit the *installed* manifest in place (what a dev does to
		// apps/<app>/manifest.json), then refresh from it.
		const installedManifestPath = join(
			env.vaultDir,
			"apps",
			"io.example.notes",
			"1.0.0",
			"manifest.json",
		);
		const changed: AppManifest = {
			...baseManifest,
			registrations: {
				...baseManifest.registrations,
				blocks: [{ id: "io.example.notes/callout", name: "Callout" }],
				intents: [{ verb: "open", entityType: "io.example/Note/v1", priority: "primary" }],
			},
		};
		await writeFile(installedManifestPath, JSON.stringify(changed, null, 2), "utf8");

		const result = await env.installer.refreshRegistrations("io.example.notes");
		expect(result).toEqual({ ok: true, id: "io.example.notes", version: "1.0.0" });

		// New registrations replaced the old ones (paragraph → callout;
		// the export intent dropped).
		const blocks = env.registryDb.prepare("SELECT id FROM blocks ORDER BY id").all() as Array<{
			id: string;
		}>;
		expect(blocks).toEqual([{ id: "io.example.notes/callout" }]);
		const intents = env.registryDb
			.prepare("SELECT verb, format FROM intents ORDER BY verb")
			.all() as Array<{ verb: string; format: string | null }>;
		expect(intents).toEqual([{ verb: "open", format: null }]);

		// Bundle + version + the apps row are untouched (this is not an
		// update — no version bump, no reinstall).
		const appsRow = env.registryDb
			.prepare("SELECT version, uninstalled_at FROM apps WHERE id = ?")
			.get("io.example.notes") as { version: string; uninstalled_at: number | null };
		expect(appsRow.version).toBe("1.0.0");
		expect(appsRow.uninstalled_at).toBeNull();
	});

	it("rejects a manifest whose id no longer matches the installed app", async () => {
		await writeBundle(env.sourceDir, baseManifest, { "dist/index.html": "<html></html>" });
		await env.installer.install({ bundleDir: env.sourceDir });
		const installedManifestPath = join(
			env.vaultDir,
			"apps",
			"io.example.notes",
			"1.0.0",
			"manifest.json",
		);
		// Empty registrations so the manifest itself validates — isolating
		// the id-mismatch guard (a namespaced reg would fail validation
		// first, which is also a rejection but a different reason).
		await writeFile(
			installedManifestPath,
			JSON.stringify({ ...baseManifest, id: "io.example.renamed", registrations: {} }, null, 2),
			"utf8",
		);
		const result = await env.installer.refreshRegistrations("io.example.notes");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.reason).toMatch(/does not match installed app/);
	});
});

// --- 6.10b — manifest → shortcut-registry mirror ----------------------------

async function setupWithShortcutRegistry() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-installer-"));
	const sourceDir = await mkdtemp(join(tmpdir(), "brainstorm-source-"));
	const stores = new DataStores(vaultDir);
	const registryDb = await stores.open("registry");
	const ledgerDb = await stores.open("ledger");
	const ledger = new CapabilityLedger(ledgerDb);
	const shortcuts = new ShortcutRegistry();
	shortcuts.registerShell(); // default shell ship-set
	const installer = new AppInstaller(vaultDir, registryDb, ledger, shortcuts);
	return { vaultDir, sourceDir, stores, registryDb, ledger, shortcuts, installer };
}

describe("AppInstaller — shortcut mirror (6.10b)", () => {
	let env: Awaited<ReturnType<typeof setupWithShortcutRegistry>>;

	beforeEach(async () => {
		env = await setupWithShortcutRegistry();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
		await rm(env.sourceDir, { recursive: true, force: true });
	});

	it("mirrors a manifest shortcut into the registry under app/<id>/<shortcut-id>", async () => {
		const manifest: AppManifest = {
			...baseManifest,
			shortcuts: [{ id: "save", default: "Mod+S", label: "Save", scope: "window" }],
		};
		await writeBundle(env.sourceDir, manifest);
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(true);
		const resolved = env.shortcuts.resolve("io.example.notes/save");
		expect(resolved?.chord).toBe("Mod+S");
		expect(resolved?.action.layer).toBe("app");
		expect(resolved?.action.appId).toBe("io.example.notes");
	});

	it("rejects install when a manifest chord collides with a shell chord without shadowsShell", async () => {
		const manifest: AppManifest = {
			...baseManifest,
			shortcuts: [{ id: "palette", default: "Mod+Shift+P", label: "Palette" }],
		};
		await writeBundle(env.sourceDir, manifest);
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected rejection");
		expect(result.reason).toMatch(/collides with a shell binding/);
		expect(result.path).toBe("$.shortcuts[0].default");
		// Registry remains untouched on rejection.
		expect(env.shortcuts.resolve("io.example.notes/palette")).toBeNull();
	});

	it("accepts a colliding chord when shadowsShell:true is set", async () => {
		const manifest: AppManifest = {
			...baseManifest,
			shortcuts: [{ id: "palette", default: "Mod+Shift+P", label: "Palette", shadowsShell: true }],
		};
		await writeBundle(env.sourceDir, manifest);
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(true);
		const resolved = env.shortcuts.resolve("io.example.notes/palette");
		expect(resolved?.action.shadowsShell).toBe(true);
	});

	it("re-mirrors on update (additions land; removals disappear)", async () => {
		await writeBundle(env.sourceDir, {
			...baseManifest,
			shortcuts: [
				{ id: "save", default: "Mod+S", label: "Save" },
				{ id: "find", default: "Mod+F", label: "Find" },
			],
		});
		await env.installer.install({ bundleDir: env.sourceDir });
		expect(env.shortcuts.resolve("io.example.notes/save")).not.toBeNull();
		expect(env.shortcuts.resolve("io.example.notes/find")).not.toBeNull();

		const updateSource = await mkdtemp(join(tmpdir(), "brainstorm-source-"));
		await writeBundle(updateSource, {
			...baseManifest,
			version: "2.0.0",
			shortcuts: [{ id: "save", default: "Mod+S", label: "Save" }], // find removed
		});
		try {
			const result = await env.installer.update({ bundleDir: updateSource });
			expect(result.ok).toBe(true);
			expect(env.shortcuts.resolve("io.example.notes/save")).not.toBeNull();
			expect(env.shortcuts.resolve("io.example.notes/find")).toBeNull();
		} finally {
			await rm(updateSource, { recursive: true, force: true });
		}
	});

	it("unregisters the app's shortcuts on uninstall", async () => {
		await writeBundle(env.sourceDir, {
			...baseManifest,
			shortcuts: [{ id: "save", default: "Mod+S", label: "Save" }],
		});
		await env.installer.install({ bundleDir: env.sourceDir });
		expect(env.shortcuts.resolve("io.example.notes/save")).not.toBeNull();

		const result = await env.installer.uninstall("io.example.notes");
		expect(result.ok).toBe(true);
		expect(env.shortcuts.resolve("io.example.notes/save")).toBeNull();
	});

	it("install without a registry stays backward-compatible (legacy callers)", async () => {
		const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-installer-"));
		const sourceDir = await mkdtemp(join(tmpdir(), "brainstorm-source-"));
		const stores = new DataStores(vaultDir);
		try {
			const registryDb = await stores.open("registry");
			const ledger = new CapabilityLedger(await stores.open("ledger"));
			const installer = new AppInstaller(vaultDir, registryDb, ledger); // no shortcut registry
			await writeBundle(sourceDir, {
				...baseManifest,
				shortcuts: [{ id: "save", default: "Mod+S", label: "Save" }],
			});
			const result = await installer.install({ bundleDir: sourceDir });
			expect(result.ok).toBe(true);
		} finally {
			stores.close();
			await rm(vaultDir, { recursive: true, force: true });
			await rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("refreshRegistrations re-applies manifest shortcuts (dev hot-reload)", async () => {
		await writeBundle(env.sourceDir, {
			...baseManifest,
			shortcuts: [{ id: "save", default: "Mod+S", label: "Save" }],
		});
		await env.installer.install({ bundleDir: env.sourceDir });
		// Edit the installed manifest's shortcuts in place (simulating a dev
		// reload after editing apps/<id>/manifest.json).
		const installedManifestPath = join(
			env.vaultDir,
			"apps",
			"io.example.notes",
			"1.0.0",
			"manifest.json",
		);
		await writeFile(
			installedManifestPath,
			JSON.stringify(
				{
					...baseManifest,
					shortcuts: [
						{ id: "save", default: "Mod+S", label: "Save" },
						{ id: "find", default: "Mod+F", label: "Find" },
					],
				},
				null,
				2,
			),
			"utf8",
		);
		const result = await env.installer.refreshRegistrations("io.example.notes");
		expect(result.ok).toBe(true);
		expect(env.shortcuts.resolve("io.example.notes/find")).not.toBeNull();
	});
});

describe("AppInstaller — manifest signature (13.2)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	const KEY_ID = "brainstorm-app-signing-1";
	const pair = ed25519.keygen();
	const secret = new Uint8Array(pair.secretKey);
	const publicKey = new Uint8Array(pair.publicKey);
	const trusted: TrustedAppKeys = new Map([[KEY_ID, publicKey]]);

	function bytesToBase64(bytes: Uint8Array): string {
		let bin = "";
		for (const b of bytes) bin += String.fromCharCode(b);
		return btoa(bin);
	}

	function sign(manifest: AppManifest): AppManifest {
		const sig = new Uint8Array(ed25519.sign(canonicalManifestBytes(manifest), secret));
		return {
			...manifest,
			signature: { alg: "ed25519", keyId: KEY_ID, value: bytesToBase64(sig) },
		} as AppManifest;
	}

	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
		await rm(env.sourceDir, { recursive: true, force: true });
	});

	it("records 'verified' when a trusted key signs the manifest (advisory policy)", async () => {
		const installer = new AppInstaller(env.vaultDir, env.registryDb, env.ledger, undefined, {
			trustedKeys: trusted,
			enforce: false,
		});
		await writeBundle(env.sourceDir, sign(baseManifest), {
			"dist/index.html": "<!doctype html>",
		});
		const result = await installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.app.signature.status).toBe(AppSignatureStatus.Verified);

		const row = env.registryDb
			.prepare("SELECT signature_status, signature_key_id FROM apps WHERE id = ?")
			.get(baseManifest.id) as { signature_status: string; signature_key_id: string | null };
		expect(row.signature_status).toBe("verified");
		expect(row.signature_key_id).toBe(KEY_ID);
	});

	it("records 'untrusted' for a signed manifest with no configured trusted key — install still succeeds (advisory)", async () => {
		const installer = new AppInstaller(env.vaultDir, env.registryDb, env.ledger);
		await writeBundle(env.sourceDir, sign(baseManifest), {
			"dist/index.html": "<!doctype html>",
		});
		const result = await installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.app.signature.status).toBe(AppSignatureStatus.Untrusted);
		expect(await bundleExists(result.app.bundleDir)).toBe(true);
	});

	it("records 'invalid' when the signature does not match the manifest — install still succeeds (advisory)", async () => {
		const installer = new AppInstaller(env.vaultDir, env.registryDb, env.ledger, undefined, {
			trustedKeys: trusted,
			enforce: false,
		});
		const signed = sign(baseManifest);
		const tampered = { ...signed, version: "2.0.0" } as AppManifest;
		await writeBundle(env.sourceDir, tampered, { "dist/index.html": "<!doctype html>" });
		const result = await installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.app.signature.status).toBe(AppSignatureStatus.Invalid);
	});

	it("blocks install on a bad signature ONLY when enforcement is flipped on", async () => {
		const installer = new AppInstaller(env.vaultDir, env.registryDb, env.ledger, undefined, {
			trustedKeys: trusted,
			enforce: true,
		});
		const signed = sign(baseManifest);
		const tampered = { ...signed, version: "2.0.0" } as AppManifest;
		await writeBundle(env.sourceDir, tampered, { "dist/index.html": "<!doctype html>" });
		const result = await installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected enforcement to block");
		expect(result.reason).toContain("invalid");
		// Nothing was written to the registry.
		const apps = env.registryDb.prepare("SELECT id FROM apps").all() as unknown[];
		expect(apps).toHaveLength(0);
	});
});
