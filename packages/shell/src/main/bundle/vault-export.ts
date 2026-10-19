/**
 * Vault → `.bsbundle` export (IE-1).
 *
 * Reads a vault's declarative + rich-text + binary state through the existing
 * repositories and Yjs store and assembles the canonical bundle layout
 * (doc 45 §Bundle format). Pure-ish: the only side effects are reads. The
 * output is a finished `.bsbundle` byte buffer.
 *
 * Scope (OQ-245): whole-vault takeout, a chosen set of types, or an entity
 * subtree (the root plus everything reachable from it through links).
 *
 * What this rung covers: entities, rich-text bodies, typed links, referenced
 * blobs (content-addressed, deduped), and synthesized provenance. Entity-type
 * schemas + app inventory are coupled to the app registry (an entity type FKs
 * the app that introduced it) and round-trip correctly only alongside the app
 * install / pending-install flow (doc 45 §Decision: apps are referenced, not
 * embedded) — that, plus shell-level state (settings / ledger / themes /
 * wallpapers) and streaming/progress, rides the next IE rungs. The bundle
 * format reserves `schemas/` + `apps.json` for them.
 */

import * as Y from "yjs";
import { yieldToEventLoop } from "../import/import-engine";
import { EntitiesRepository, type EntityRow } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";
import { packBundleAsync, preferredCompression } from "./bundle-archive";
import {
	BUNDLE_FORMAT_VERSION,
	type BundleAssetRecord,
	type BundleEntityRecord,
	type BundleExportScope,
	BundleExportScopeKind,
	type BundleLinkRecord,
	type BundleManifest,
	BundlePath,
	type BundleProvenanceRecord,
} from "./bundle-format";
import { canonicalJson, canonicalJsonl } from "./canonical-json";

export type ExportVaultOptions = {
	readonly scope: BundleExportScope;
	/** Wall-clock for the manifest stamp (ms). Injected for determinism. */
	readonly now: number;
	readonly generator?: string;
	/** Background-run plumbing (IE-11): progress over entities + assets. */
	readonly onProgress?: (done: number, total: number) => void;
	/** Aborting returns null — nothing is written, no partial bundle. */
	readonly signal?: AbortSignal;
};

/** Yield cadence — entity bodies load a Y.Doc each; assets read whole
 *  binaries. Both loops must let IPC/paint run during a big export. */
const EXPORT_YIELD_EVERY = 25;

const enc = (s: string) => new TextEncoder().encode(s);

function selectEntities(repo: EntitiesRepository, scope: BundleExportScope): EntityRow[] {
	switch (scope.kind) {
		case BundleExportScopeKind.WholeVault:
			return repo.query({});
		case BundleExportScopeKind.Types:
			return scope.types.length === 0 ? [] : repo.query({ type: [...scope.types] });
		case BundleExportScopeKind.Subtree:
			return subtreeClosure(repo, scope.rootId);
	}
}

/** The root entity plus every entity reachable from it by following outgoing
 *  links transitively (the self-contained-subtree semantics). */
function subtreeClosure(repo: EntitiesRepository, rootId: string): EntityRow[] {
	const root = repo.get(rootId);
	if (!root) return [];
	const seen = new Set<string>([rootId]);
	const out: EntityRow[] = [root];
	let frontier: string[] = [rootId];
	while (frontier.length > 0) {
		const links = repo.linksFromMany(frontier);
		const next: string[] = [];
		for (const link of links) {
			if (seen.has(link.destEntityId)) continue;
			const row = repo.get(link.destEntityId);
			if (!row) continue;
			seen.add(link.destEntityId);
			out.push(row);
			next.push(link.destEntityId);
		}
		frontier = next;
	}
	return out;
}

export async function exportVaultBundle(
	session: VaultSession,
	options: ExportVaultOptions,
): Promise<Uint8Array | null> {
	if (options.signal?.aborted) return null;
	const entitiesDb = await session.dataStores.open("entities");
	const entitiesRepo = new EntitiesRepository(entitiesDb);
	const assetStore = await session.assetStore();

	const rows = selectEntities(entitiesRepo, options.scope).sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	const selectedIds = new Set(rows.map((r) => r.id));

	// Progress total is fixed up front: every entity plus every bound asset
	// (assets outside the scope still tick — the walk visits them either way).
	const boundAssets = assetStore.listBound();
	const total = rows.length + boundAssets.length;
	let done = 0;
	const tick = (): void => {
		done++;
		options.onProgress?.(done, total);
	};

	const files = new Map<string, Uint8Array>();

	// --- entities + rich-text bodies ---
	for (const row of rows) {
		if (options.signal?.aborted) return null;
		const record: BundleEntityRecord = {
			id: row.id,
			type: row.type,
			properties: row.properties,
			createdBy: row.createdBy,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			spaceId: row.spaceId,
		};
		files.set(`${BundlePath.EntitiesDir}${row.type}/${row.id}.json`, enc(canonicalJson(record)));

		const { doc } = await session.ydocStore.load(row.id);
		const state = Y.encodeStateAsUpdate(doc);
		doc.destroy();
		files.set(`${BundlePath.YdocDir}${row.id}.bin`, state);
		tick();
		if (done % EXPORT_YIELD_EVERY === 0) await yieldToEventLoop();
	}

	// --- links (only edges fully inside the exported set) ---
	const linkRecords: BundleLinkRecord[] = entitiesRepo
		.linksFromMany([...selectedIds])
		.filter((l) => selectedIds.has(l.destEntityId))
		.map((l) => ({
			id: l.id,
			sourceEntityId: l.sourceEntityId,
			destEntityId: l.destEntityId,
			linkType: l.linkType,
			createdAt: l.createdAt,
		}))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	files.set(BundlePath.Links, enc(canonicalJsonl(linkRecords)));

	// --- provenance (synthesized: a Brainstorm-sourced takeout; external
	//     lineage + a persistent provenance store ride the migration rungs) ---
	const provenance: BundleProvenanceRecord[] = rows.map((r) => ({
		entityId: r.id,
		source: "brainstorm",
		originalId: r.id,
	}));
	files.set(BundlePath.Provenance, enc(canonicalJsonl(provenance)));

	// --- referenced binary assets (content-addressed, deduped) ---
	const assetRecords: BundleAssetRecord[] = [];
	const scopeBlob = rows.map((r) => JSON.stringify(r.properties)).join(" ");
	for (const meta of boundAssets) {
		if (options.signal?.aborted) return null;
		tick();
		if (done % EXPORT_YIELD_EVERY === 0) await yieldToEventLoop();
		if (!scopeBlob.includes(meta.assetId)) continue;
		const read = await assetStore.readAsset(meta.assetId);
		if (!read) continue;
		files.set(`${BundlePath.BlobsDir}${meta.contentHash}`, read.bytes);
		assetRecords.push({
			assetId: meta.assetId,
			contentHash: meta.contentHash,
			mime: meta.mime,
			kind: meta.kind,
			byteLen: meta.byteLen,
			originUrl: meta.originUrl,
			bound: meta.boundAt !== null,
		});
	}
	assetRecords.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
	files.set(BundlePath.AssetsManifest, enc(canonicalJsonl(assetRecords)));

	// --- manifest ---
	const compression = preferredCompression();
	const manifest: BundleManifest = {
		bundleFormatVersion: BUNDLE_FORMAT_VERSION,
		compression,
		createdAt: new Date(options.now).toISOString(),
		generator: options.generator ?? "@brainstorm-os/shell",
		scope: options.scope,
		vault: { id: session.vaultId, name: null },
		sections: {
			entities: true,
			ydoc: true,
			links: true,
			provenance: true,
			schemas: false,
			blobs: assetRecords.length > 0,
			apps: false,
		},
		counts: {
			entities: rows.length,
			links: linkRecords.length,
			assets: assetRecords.length,
			entityTypes: 0,
			apps: 0,
		},
	};
	files.set(BundlePath.Manifest, enc(canonicalJson(manifest)));

	return await packBundleAsync(files, compression);
}
