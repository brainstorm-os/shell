/**
 * IE-1 — `.bsbundle` round-trip guarantee (doc 45 §Round-trip guarantee).
 *
 * The format's defining test, run in CI:
 *
 *   make-test-vault → export bundle A → import A as a new vault →
 *     export bundle B → compare A and B byte-equivalent
 *                       (ignoring volatile manifest fields: createdAt + vaultId)
 *
 * A regression that breaks this fails the build — it's the load-bearing piece
 * of the data-portability trust story. The seed exercises every section the
 * spine covers: entities with distinct created/updated stamps, rich-text Yjs
 * bodies, a typed link, and a bound binary asset referenced by an entity
 * property.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

let USER_DATA_DIR = "";
vi.mock("electron", () => ({ app: { getPath: () => USER_DATA_DIR } }));

import { AssetKind } from "../assets/asset-types";
import { packBundle, unpackBundle } from "../bundle/bundle-archive";
import { BundleExportScopeKind, BundlePath } from "../bundle/bundle-format";
import { exportVaultBundle } from "../bundle/vault-export";
import { importVaultBundle } from "../bundle/vault-import";
import { __resetAtRestProbeForTests } from "../storage/at-rest-mode";
import { EntitiesRepository } from "../storage/entities-repo";
import { __setSqlcipherDriverForTests } from "../storage/sqlite";
import { closeActiveVaultSession, getActiveVaultSession } from "../vault/session";
import { createVault } from "../vault/vault";

const FIXED_NOW = 1_700_000_000_000;
const AUTHOR = "did:test:author";
const TYPE = "test/Doc/v1";

async function makeBody(
	ydocStore: import("../storage/ydoc-store").YDocStore,
	id: string,
	text: string,
) {
	const doc = new Y.Doc();
	doc.getText("body").insert(0, text);
	await ydocStore.writeSnapshot(id, Y.encodeStateAsUpdate(doc));
	doc.destroy();
}

describe("IE-1 .bsbundle round-trip", () => {
	let workDir = "";

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-bundle-rt-"));
		USER_DATA_DIR = workDir;
		__setSqlcipherDriverForTests(null);
		__resetAtRestProbeForTests();
	});

	afterEach(async () => {
		// Close any session a (possibly-throwing) test left open before removing
		// its dir — an open SQLite handle locks the file on Windows.
		closeActiveVaultSession();
		await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("export → import-as-new-vault → re-export is byte-equivalent", async () => {
		// --- vault A: seed ---
		const pathA = join(workDir, "vault-a");
		await createVault({
			name: "A",
			path: pathA,
			keystore: { forceInsecure: true },
			seedStarterContent: false,
		});
		const sessionA = getActiveVaultSession();
		if (!sessionA) throw new Error("no active session A");

		const dbA = await sessionA.dataStores.open("entities");
		const entitiesA = new EntitiesRepository(dbA);

		const assetStoreA = await sessionA.assetStore();
		const blobBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const { assetId } = await assetStoreA.writeAsset({
			bytes: blobBytes,
			mime: "image/png",
			kind: AssetKind.Cover,
		});
		assetStoreA.markBound(assetId);

		entitiesA.create({
			id: "ent-1",
			type: TYPE,
			properties: { title: "First", coverAssetId: assetId },
			createdBy: AUTHOR,
			now: FIXED_NOW,
			updatedAt: FIXED_NOW + 5000,
			dekId: null,
		});
		entitiesA.create({
			id: "ent-2",
			type: TYPE,
			properties: { title: "Second", tags: ["a", "b"] },
			createdBy: AUTHOR,
			now: FIXED_NOW + 100,
			updatedAt: FIXED_NOW + 100,
			dekId: null,
		});
		entitiesA.putLink({
			id: "link-1",
			sourceEntityId: "ent-1",
			destEntityId: "ent-2",
			linkType: "test/refersTo",
			createdAt: FIXED_NOW + 200,
		});
		await makeBody(sessionA.ydocStore, "ent-1", "Hello rich text body.");
		await makeBody(sessionA.ydocStore, "ent-2", "Another body with content.");

		const bundleA = await exportVaultBundle(sessionA, {
			scope: { kind: BundleExportScopeKind.WholeVault },
			now: FIXED_NOW,
		});
		closeActiveVaultSession();

		// --- vault B: import A, re-export ---
		const pathB = join(workDir, "vault-b");
		await createVault({
			name: "B",
			path: pathB,
			keystore: { forceInsecure: true },
			seedStarterContent: false,
		});
		const sessionB = getActiveVaultSession();
		if (!sessionB) throw new Error("no active session B");

		const report = await importVaultBundle(sessionB, bundleA, {
			now: FIXED_NOW + 999_999,
			importedBy: "did:test:importer",
		});
		expect(report.created).toBe(2);
		expect(report.linksRestored).toBe(1);
		expect(report.assetsWritten).toBe(1);
		expect(report.failed).toEqual([]);

		const bundleB = await exportVaultBundle(sessionB, {
			scope: { kind: BundleExportScopeKind.WholeVault },
			now: FIXED_NOW,
		});
		closeActiveVaultSession();

		// --- compare A and B (byte-equivalent modulo volatile manifest fields) ---
		const a = unpackBundle(bundleA);
		const b = unpackBundle(bundleB);
		expect([...b.keys()].sort()).toEqual([...a.keys()].sort());

		for (const [path, bytesA] of a) {
			if (path === "manifest.json") continue;
			expect(Buffer.from(b.get(path) ?? new Uint8Array()), `mismatch in ${path}`).toEqual(
				Buffer.from(bytesA),
			);
		}

		const dec = (x: Uint8Array | undefined) =>
			JSON.parse(new TextDecoder().decode(x ?? new Uint8Array()));
		const manA = dec(a.get("manifest.json"));
		const manB = dec(b.get("manifest.json"));
		manA.vault.id = "";
		manB.vault.id = "";
		expect(manB).toEqual(manA);
	});

	it("a Types-scoped export carries only the chosen type's entities", async () => {
		const path = join(workDir, "vault-scope");
		await createVault({
			name: "S",
			path,
			keystore: { forceInsecure: true },
			seedStarterContent: false,
		});
		const session = getActiveVaultSession();
		if (!session) throw new Error("no active session");
		const repo = new EntitiesRepository(await session.dataStores.open("entities"));
		repo.create({
			id: "n1",
			type: "x/Note/v1",
			properties: {},
			createdBy: AUTHOR,
			now: FIXED_NOW,
			dekId: null,
		});
		repo.create({
			id: "n2",
			type: "x/Note/v1",
			properties: {},
			createdBy: AUTHOR,
			now: FIXED_NOW,
			dekId: null,
		});
		repo.create({
			id: "t1",
			type: "x/Task/v1",
			properties: {},
			createdBy: AUTHOR,
			now: FIXED_NOW,
			dekId: null,
		});

		const bundle = await exportVaultBundle(session, {
			scope: { kind: BundleExportScopeKind.Types, types: ["x/Note/v1"] },
			now: FIXED_NOW,
		});
		closeActiveVaultSession();

		const files = unpackBundle(bundle);
		const entityPaths = [...files.keys()].filter((p) => p.startsWith("entities/"));
		expect(entityPaths.sort()).toEqual(["entities/x/Note/v1/n1.json", "entities/x/Note/v1/n2.json"]);
		const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
		expect(manifest.counts.entities).toBe(2);
		expect(manifest.scope.kind).toBe(BundleExportScopeKind.Types);
	});

	it("a Subtree-scoped export carries the root plus link-reachable entities only", async () => {
		const path = join(workDir, "vault-subtree");
		await createVault({
			name: "T",
			path,
			keystore: { forceInsecure: true },
			seedStarterContent: false,
		});
		const session = getActiveVaultSession();
		if (!session) throw new Error("no active session");
		const repo = new EntitiesRepository(await session.dataStores.open("entities"));
		for (const id of ["root", "child", "grandchild", "unrelated"]) {
			repo.create({
				id,
				type: "x/Doc/v1",
				properties: {},
				createdBy: AUTHOR,
				now: FIXED_NOW,
				dekId: null,
			});
		}
		repo.putLink({
			id: "l1",
			sourceEntityId: "root",
			destEntityId: "child",
			linkType: "x/has",
			createdAt: FIXED_NOW,
		});
		repo.putLink({
			id: "l2",
			sourceEntityId: "child",
			destEntityId: "grandchild",
			linkType: "x/has",
			createdAt: FIXED_NOW,
		});

		const bundle = await exportVaultBundle(session, {
			scope: { kind: BundleExportScopeKind.Subtree, rootId: "root" },
			now: FIXED_NOW,
		});
		closeActiveVaultSession();

		const files = unpackBundle(bundle);
		const ids = [...files.keys()]
			.filter((p) => p.startsWith("entities/"))
			.map((p) => p.replace(/^entities\/x\/Doc\/v1\//, "").replace(/\.json$/, ""))
			.sort();
		expect(ids).toEqual(["child", "grandchild", "root"]);
	});

	it("import rejects a non-bundle buffer and a missing importedBy", async () => {
		const path = join(workDir, "vault-err");
		await createVault({
			name: "E",
			path,
			keystore: { forceInsecure: true },
			seedStarterContent: false,
		});
		const session = getActiveVaultSession();
		if (!session) throw new Error("no active session");

		await expect(
			importVaultBundle(session, new Uint8Array([9, 9, 9, 9, 9]), { now: FIXED_NOW, importedBy: "x" }),
		).rejects.toThrow(/bad magic/);
		await expect(
			importVaultBundle(session, new Uint8Array([9, 9, 9, 9, 9]), { now: FIXED_NOW, importedBy: "" }),
		).rejects.toThrow(/importedBy/);
		closeActiveVaultSession();
	});

	it("import refuses a bundle whose ids would escape the vault dir (path traversal)", async () => {
		// Source vault with one entity + one bound asset → export a real bundle.
		const srcPath = join(workDir, "vault-src");
		await createVault({
			name: "S",
			path: srcPath,
			keystore: { forceInsecure: true },
			seedStarterContent: false,
		});
		const src = getActiveVaultSession();
		if (!src) throw new Error("no active source session");
		const srcAssets = await src.assetStore();
		const { assetId } = await srcAssets.writeAsset({
			bytes: new Uint8Array([1, 2, 3]),
			mime: "image/png",
			kind: AssetKind.Cover,
		});
		srcAssets.markBound(assetId);
		const srcDb = await src.dataStores.open("entities");
		new EntitiesRepository(srcDb).create({
			id: "ent-1",
			type: TYPE,
			properties: { title: "T", coverAssetId: assetId },
			createdBy: AUTHOR,
			now: FIXED_NOW,
			updatedAt: FIXED_NOW,
			dekId: null,
		});
		const clean = await exportVaultBundle(src, {
			scope: { kind: BundleExportScopeKind.WholeVault },
			now: FIXED_NOW,
		});
		closeActiveVaultSession();

		const dec = new TextDecoder();
		const enc = new TextEncoder();
		const tamper = (
			clean: Uint8Array,
			mutate: (files: Map<string, Uint8Array>) => void,
		): Uint8Array => {
			const files = unpackBundle(clean);
			mutate(files);
			return packBundle(files);
		};
		const targetPath = join(workDir, "vault-tgt");

		// A traversal entity id (becomes a `.ydoc` write path) is refused.
		const evilEntity = tamper(clean, (files) => {
			for (const [path, bytes] of files) {
				if (!path.startsWith(BundlePath.EntitiesDir)) continue;
				const rec = JSON.parse(dec.decode(bytes));
				rec.id = "../../../../tmp/pwned";
				files.set(path, enc.encode(JSON.stringify(rec)));
			}
		});
		// A traversal asset id (becomes a `.enc` blob write path) is refused.
		const evilAsset = tamper(clean, (files) => {
			const manifest = files.get(BundlePath.AssetsManifest);
			if (!manifest) throw new Error("fixture missing assets manifest");
			const tampered = dec
				.decode(manifest)
				.split("\n")
				.filter((l) => l.length > 0)
				.map((l) => {
					const rec = JSON.parse(l);
					rec.assetId = "../../../../tmp/pwned";
					return JSON.stringify(rec);
				})
				.join("\n");
			files.set(BundlePath.AssetsManifest, enc.encode(tampered));
		});

		for (const evil of [evilEntity, evilAsset]) {
			await createVault({
				name: "T",
				path: targetPath,
				keystore: { forceInsecure: true },
				seedStarterContent: false,
			});
			const tgt = getActiveVaultSession();
			if (!tgt) throw new Error("no active target session");
			await expect(importVaultBundle(tgt, evil, { now: FIXED_NOW, importedBy: "x" })).rejects.toThrow(
				/unsafe (entity|asset) id/,
			);
			closeActiveVaultSession();
			await rm(targetPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
				() => {},
			);
		}
	});
});
