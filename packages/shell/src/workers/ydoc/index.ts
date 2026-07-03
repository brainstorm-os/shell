/**
 * Yjs worker — resolves OQ-18: canonical Y.Docs live in this dedicated
 * `utilityProcess`, not the main process. Per
 * §Roles, isolating the CRDT runtime keeps the main loop's perf budget
 * intact even under heavy concurrent editing.
 *
 * Stage 3 surface (one service: `ydoc`):
 *
 *   ydoc.load(entityId)
 *     → loads the doc from disk via YDocStore, caches the Y.Doc in-process,
 *       returns a snapshot (base64 of `Y.encodeStateAsUpdate`).
 *
 *   ydoc.applyUpdate(entityId, updateB64)
 *     → applies the update to the in-process replica, appends to the tail
 *       on disk, compacts opportunistically when the file grows past the
 *       threshold.
 *
 *   ydoc.snapshot(entityId)
 *     → returns the current full-state snapshot (base64).
 *
 *   ydoc.close(entityId)
 *     → flushes any pending state and drops the in-memory replica.
 *
 *   ydoc.recover(entityId)
 *     → load + report tail-truncation status. Stage 3.10 (recovery pass)
 *       sweeps this across known entity ids on shell startup.
 *
 * Streaming updates (renderer-replica → worker) arrive in Stage 4 with the
 * broker enforcement story; for now the load/apply/snapshot surface is
 * what the main process needs.
 */

import { Buffer } from "node:buffer";
import { join } from "node:path";
import { ENTITY_PROPS_MAP_NAME, type EntityDocLink } from "@brainstorm/sdk-types";
import * as Y from "yjs";
import type { Envelope, EnvelopeReply } from "../../ipc/envelope";
import { makeErrorReply, makeOkReply, validateEnvelope } from "../../ipc/envelope";
import {
	readEntityDocProjection,
	writeEntityLinks,
	writeEntityProps,
} from "../../main/entities/entity-doc-codec";
import { assertSafeEntityId } from "../../main/storage/entity-id";
import { YDocStore } from "../../main/storage/ydoc-store";
import { installWorkerProcessGuards, wireParentPort } from "../worker-runtime";

// Stage 10.3a — the wraps schema lives on the entity's Y.Doc at
// `getMap(ENTITY_META_TOP).get(ENTITY_WRAPS_KEY)`. The worker keeps the
// keys hard-coded (matching `main/credentials/member-wraps.ts`) so it
// never imports the credentials module — HPKE primitives stay
// crypto-free of this worker bundle.
const WORKER_ENTITY_META_TOP = "brainstorm.meta";
const WORKER_ENTITY_WRAPS_KEY = "wraps";

type WorkerMemberWrap = {
	v: 1;
	alg: string;
	recipientPubB64: string;
	encB64: string;
	ctB64: string;
};

function isWorkerMemberWrap(value: unknown): value is WorkerMemberWrap {
	if (!value || typeof value !== "object") return false;
	const w = value as Partial<WorkerMemberWrap>;
	return (
		w.v === 1 &&
		typeof w.alg === "string" &&
		typeof w.recipientPubB64 === "string" &&
		typeof w.encB64 === "string" &&
		typeof w.ctB64 === "string"
	);
}

/** Asset-B1 — key in the entity meta map for the re-homed asset-DEK wraps
 *  (a Y.Map keyed by assetId). Sibling of the member-wraps array. */
const WORKER_ENTITY_ASSET_DEKS_KEY = "assetDeks";

/** Asset-B4 — key in the entity meta map for the chunk manifests (a Y.Map
 *  keyed by assetId, value = the opaque `AssetChunkManifest` JSON). Unlike the
 *  asset-DEK wraps this is NOT separately sealed — it's plain metadata (chunk
 *  ciphertext-hashes + sizes) that inherits the Y.Doc's own transport
 *  encryption; opening the chunks still needs the asset DEK in `assetDeks`. */
const WORKER_ENTITY_ASSET_MANIFESTS_KEY = "assetManifests";

/** Worker-side shape of a re-homed asset-DEK wrap — the opaque `SealedSecret`
 *  envelope produced on main by `sealAssetDekUnderEntity`. The worker stores it
 *  verbatim and validates only the shape; all crypto stays on the main side. */
type WorkerSealedSecret = { v: 1; nonceB64: string; ciphertextB64: string };

function isWorkerSealedSecret(value: unknown): value is WorkerSealedSecret {
	if (!value || typeof value !== "object") return false;
	const s = value as Partial<WorkerSealedSecret>;
	return s.v === 1 && typeof s.nonceB64 === "string" && typeof s.ciphertextB64 === "string";
}

/** Electron's `process.parentPort` delivers a `MessageEvent`-shaped object to
 *  the 'message' listener — the actual payload lives on `.data`. This is
 *  asymmetric with the parent's `UtilityProcess.on('message', ...)`, which
 *  receives the raw posted value. See electron.d.ts for both signatures. */
type ParentPortMessage = { data: unknown };
type ParentPort = {
	on(event: "message", listener: (event: ParentPortMessage) => void): void;
	postMessage(message: unknown): void;
};

type ProcessWithParentPort = NodeJS.Process & { parentPort?: ParentPort };

/**
 * Per-worker state. One YDocStore per vault path; opened lazily the first
 * time a vault's entity is touched. The worker stays single-vault in v1
 * (one vault per shell window per); the structure here supports
 * multi-vault if/when that lands.
 *
 * Doc cache is LRU-bounded. Eviction is safe because every `applyUpdate`
 * is persisted synchronously via `appendAndMaybeCompact` — an evicted
 * doc carries no in-memory-only state; a future `ensureDoc` reads the
 * full state back from disk. Eviction calls `Y.Doc.destroy()` to free
 * the CRDT's internal structures.
 */
const stores = new Map<string, YDocStore>();

/** Map iteration order in JS is insertion order, so we get LRU semantics
 *  by delete-then-set on every access (the most-recently used key sits
 *  at the tail; eviction pops from the head). Cap is env-overridable for
 *  long-soak tests; 64 is enough headroom for the apps that have the doc
 *  open right now plus a small working set, while bounding RSS growth
 *  over a multi-hour session. */
const DEFAULT_DOC_CACHE_MAX = 64;
const docCacheMax = ((): number => {
	const raw = Number(process.env.BRAINSTORM_YDOC_CACHE_MAX);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DOC_CACHE_MAX;
})();
const docs = new Map<string, Y.Doc>();
const docCacheMaxOverride: { value: number | null } = { value: null };

function storeFor(vaultPath: string): YDocStore {
	const cached = stores.get(vaultPath);
	if (cached) return cached;
	const store = new YDocStore(vaultPath);
	stores.set(vaultPath, store);
	return store;
}

function docKey(vaultPath: string, entityId: string): string {
	return `${vaultPath}::${entityId}`;
}

function touch(key: string, doc: Y.Doc): void {
	docs.delete(key);
	docs.set(key, doc);
}

function currentCap(): number {
	return docCacheMaxOverride.value ?? docCacheMax;
}

function evictIfOverCap(): void {
	while (docs.size > currentCap()) {
		const oldestKey = docs.keys().next().value;
		if (!oldestKey) break;
		const victim = docs.get(oldestKey);
		docs.delete(oldestKey);
		victim?.destroy();
	}
}

async function ensureDoc(
	vaultPath: string,
	entityId: string,
): Promise<{ doc: Y.Doc; truncatedTail: boolean }> {
	const key = docKey(vaultPath, entityId);
	const cached = docs.get(key);
	if (cached) {
		touch(key, cached);
		return { doc: cached, truncatedTail: false };
	}
	const { doc, truncatedTail } = await storeFor(vaultPath).load(entityId);
	docs.set(key, doc);
	evictIfOverCap();
	return { doc, truncatedTail };
}

/** Test seam — pure observation of the LRU's current size. Exported so
 *  the eviction tests don't have to introspect the module-private map. */
export function __ydocCacheSizeForTest(): number {
	return docs.size;
}

/** Test seam — cap override + full clear. Exported so eviction tests can
 *  exercise the policy deterministically at a tiny size without polluting
 *  the production default. Also clears the per-vault `YDocStore` map — each
 *  test mints a fresh `vaultDir`, so without this the map grows unbounded
 *  across the run and pins YDocStore instances forever. */
export function __ydocCacheResetForTest(maxOverride?: number): void {
	for (const doc of docs.values()) doc.destroy();
	docs.clear();
	stores.clear();
	if (typeof maxOverride === "number" && maxOverride > 0) {
		docCacheMaxOverride.value = Math.floor(maxOverride);
	} else {
		docCacheMaxOverride.value = null;
	}
}

type LoadArgs = { vaultPath: string; entityId: string };
type ApplyArgs = { vaultPath: string; entityId: string; updateB64: string };
type CloseArgs = { vaultPath: string; entityId: string };
type SetStateArgs = {
	vaultPath: string;
	entityId: string;
	props?: Record<string, unknown>;
	links?: EntityDocLink[];
	/** Lazy Y.Doc hydration (Phase 5). The full property set from the
	 *  `entities.db` row, written into the doc's property map ONLY when that
	 *  map is still empty (a seeded / legacy-backfilled entity whose row was
	 *  populated directly, never through the Y.Doc). Seeds the doc to be the
	 *  complete source of truth before the incremental `props` patch lands,
	 *  so a later sync ships the whole object — not just the one edited field.
	 *  Concurrency-safe: an empty doc has no prior CRDT state to conflict
	 *  with; a doc that already carries properties is left untouched. */
	seedProps?: Record<string, unknown>;
};
type InstallWrapArgs = { vaultPath: string; entityId: string; wrap: WorkerMemberWrap };
type InstallAssetDekWrapArgs = {
	vaultPath: string;
	entityId: string;
	assetId: string;
	wrap: WorkerSealedSecret;
};
type InstallAssetManifestArgs = {
	vaultPath: string;
	entityId: string;
	assetId: string;
	/** Opaque `AssetChunkManifest` JSON — validated for shape on main. */
	manifest: Record<string, unknown>;
};
type ReadAssetManifestArgs = { vaultPath: string; entityId: string; assetId: string };
type ListAssetManifestsArgs = { vaultPath: string; entityId: string };

const handlers: Record<string, (envelope: Envelope) => Promise<unknown> | unknown> = {
	load: async (envelope) => {
		const args = parseArgs<LoadArgs>(envelope, "load");
		const { doc, truncatedTail } = await ensureDoc(args.vaultPath, args.entityId);
		const snapshot = Y.encodeStateAsUpdate(doc);
		return { snapshotB64: bytesToBase64(snapshot), truncatedTail };
	},
	applyUpdate: async (envelope) => {
		const args = parseArgs<ApplyArgs>(envelope, "applyUpdate");
		const { doc } = await ensureDoc(args.vaultPath, args.entityId);
		const update = base64ToBytes(args.updateB64);
		Y.applyUpdate(doc, update);
		const result = await storeFor(args.vaultPath).appendAndMaybeCompact(args.entityId, update);
		// The Y.Doc is the source of truth; return the derived projection so
		// the entities service can materialise the `entities.db` row from the
		// just-applied doc state. Empty
		// for a doc that carries no property/link roots (e.g. body-only).
		return {
			compacted: result.compacted,
			sizeBytes: result.size,
			projection: readEntityDocProjection(doc),
		};
	},
	snapshot: async (envelope) => {
		const args = parseArgs<LoadArgs>(envelope, "snapshot");
		const { doc } = await ensureDoc(args.vaultPath, args.entityId);
		return { snapshotB64: bytesToBase64(Y.encodeStateAsUpdate(doc)) };
	},
	// Y.Doc-first writes (Phase 2) — mutate the canonical doc's property /
	// link roots directly, then persist. The entities service routes
	// `create`/`update` through here so the Y.Doc is the source of truth and
	// the SQLite row is materialised from the returned projection. Property
	// keys merge (atomic-replace per key); links replace the full set. Both
	// mutations share ONE transaction so a single update is emitted +
	// persisted (Yjs nests the inner `transact`s into the outer one).
	setEntityState: async (envelope) => {
		const args = parseArgs<SetStateArgs>(envelope, "setEntityState");
		const { doc } = await ensureDoc(args.vaultPath, args.entityId);
		let captured: Uint8Array | null = null;
		const capture = (update: Uint8Array): void => {
			captured = update;
		};
		doc.on("update", capture);
		try {
			doc.transact(() => {
				// Lazy hydration (Phase 5): if this doc's property map is still
				// empty it was never written through the Y.Doc (seeded / legacy-
				// backfilled row). Seed it from the row's full property set so
				// the doc becomes the complete source of truth before the
				// incremental patch — otherwise a later sync would ship only the
				// edited field. A doc that already has properties is left alone.
				if (args.seedProps && doc.getMap(ENTITY_PROPS_MAP_NAME).size === 0) {
					writeEntityProps(doc, args.seedProps);
				}
				if (args.props) writeEntityProps(doc, args.props);
				if (args.links) writeEntityLinks(doc, args.links);
			});
		} finally {
			doc.off("update", capture);
		}
		if (captured) {
			await storeFor(args.vaultPath).appendAndMaybeCompact(args.entityId, captured);
		}
		// 10.12 — return the persisted update bytes so the main process can
		// emit this property write through the always-on live-sync engine.
		// `null` when the write produced no diff (idempotent re-write / empty
		// patch) — main skips the emit in that case.
		return {
			projection: readEntityDocProjection(doc),
			updateB64: captured ? bytesToBase64(captured) : null,
		};
	},
	close: async (envelope) => {
		const args = parseArgs<CloseArgs>(envelope, "close");
		const key = docKey(args.vaultPath, args.entityId);
		const victim = docs.get(key);
		docs.delete(key);
		victim?.destroy();
		return { closed: true };
	},
	recover: async (envelope) => {
		const args = parseArgs<LoadArgs>(envelope, "recover");
		const { tailEntries, truncatedTail } = await storeFor(args.vaultPath).load(args.entityId);
		return { tailEntries, truncatedTail };
	},
	// Stage 10.3a — append a pre-built MemberWrapPayload (HPKE on main, no
	// crypto here) to the entity Y.Doc's wraps array, idempotent on the
	// recipient pubkey, and persist the resulting update. The wire-path
	// open side reads this wrap to recover the per-entity DEK on a paired
	// device.
	installWrap: async (envelope) => {
		const args = parseArgs<InstallWrapArgs>(envelope, "installWrap");
		if (!isWorkerMemberWrap(args.wrap)) {
			throw new Error("ydoc.installWrap: invalid wrap payload shape");
		}
		const { doc } = await ensureDoc(args.vaultPath, args.entityId);
		const meta = doc.getMap<unknown>(WORKER_ENTITY_META_TOP);
		// Capture the update emitted by the wrap-install transact so the
		// store-side append/compact path sees exactly that diff (matches
		// the `applyUpdate` handler's invariant: one update per write).
		// The observer is detached in the same tick after `transact`.
		let installUpdate: Uint8Array | null = null;
		const captureUpdate = (update: Uint8Array): void => {
			installUpdate = update;
		};
		doc.on("update", captureUpdate);
		let appended = false;
		try {
			doc.transact(() => {
				if (!(meta.get(WORKER_ENTITY_WRAPS_KEY) instanceof Y.Array)) {
					meta.set(WORKER_ENTITY_WRAPS_KEY, new Y.Array<WorkerMemberWrap>());
				}
				const current = meta.get(WORKER_ENTITY_WRAPS_KEY) as Y.Array<WorkerMemberWrap>;
				for (const entry of current) {
					if (isWorkerMemberWrap(entry) && entry.recipientPubB64 === args.wrap.recipientPubB64) {
						return;
					}
				}
				current.push([args.wrap]);
				appended = true;
			});
		} finally {
			doc.off("update", captureUpdate);
		}
		if (appended && installUpdate) {
			await storeFor(args.vaultPath).appendAndMaybeCompact(args.entityId, installUpdate);
		}
		return { appended };
	},
	// Asset-B1 — set a pre-sealed asset-DEK wrap (sealed under the entity DEK on
	// main; no crypto here) into the entity Y.Doc's `assetDeks` map, keyed by
	// assetId, and persist the resulting update. Idempotent: a wrap already
	// present for that assetId is a no-op (no second update). The re-home wire
	// path reads this back to recover the per-asset DEK on a paired device.
	installAssetDekWrap: async (envelope) => {
		const args = parseArgs<InstallAssetDekWrapArgs>(envelope, "installAssetDekWrap");
		if (typeof args.assetId !== "string" || args.assetId === "") {
			throw new Error("ydoc.installAssetDekWrap: assetId must be a non-empty string");
		}
		if (!isWorkerSealedSecret(args.wrap)) {
			throw new Error("ydoc.installAssetDekWrap: invalid wrap payload shape");
		}
		const { doc } = await ensureDoc(args.vaultPath, args.entityId);
		const meta = doc.getMap<unknown>(WORKER_ENTITY_META_TOP);
		let installUpdate: Uint8Array | null = null;
		const captureUpdate = (update: Uint8Array): void => {
			installUpdate = update;
		};
		doc.on("update", captureUpdate);
		let appended = false;
		try {
			doc.transact(() => {
				if (!(meta.get(WORKER_ENTITY_ASSET_DEKS_KEY) instanceof Y.Map)) {
					meta.set(WORKER_ENTITY_ASSET_DEKS_KEY, new Y.Map<WorkerSealedSecret>());
				}
				const map = meta.get(WORKER_ENTITY_ASSET_DEKS_KEY) as Y.Map<WorkerSealedSecret>;
				if (map.has(args.assetId)) return;
				map.set(args.assetId, args.wrap);
				appended = true;
			});
		} finally {
			doc.off("update", captureUpdate);
		}
		if (appended && installUpdate) {
			await storeFor(args.vaultPath).appendAndMaybeCompact(args.entityId, installUpdate);
		}
		return { appended };
	},
	// Asset-B4 — set the chunk manifest for an asset into the entity Y.Doc's
	// `assetManifests` map, keyed by assetId, and persist the update. Idempotent:
	// a manifest already present for that assetId is a no-op (the asset is
	// immutable, so its manifest never changes). A paired device reads this back
	// to lazily fetch + reassemble the blob from the node.
	installAssetManifest: async (envelope) => {
		const args = parseArgs<InstallAssetManifestArgs>(envelope, "installAssetManifest");
		if (typeof args.assetId !== "string" || args.assetId === "") {
			throw new Error("ydoc.installAssetManifest: assetId must be a non-empty string");
		}
		if (!args.manifest || typeof args.manifest !== "object") {
			throw new Error("ydoc.installAssetManifest: manifest must be an object");
		}
		const { doc } = await ensureDoc(args.vaultPath, args.entityId);
		const meta = doc.getMap<unknown>(WORKER_ENTITY_META_TOP);
		let installUpdate: Uint8Array | null = null;
		const captureUpdate = (update: Uint8Array): void => {
			installUpdate = update;
		};
		doc.on("update", captureUpdate);
		let appended = false;
		try {
			doc.transact(() => {
				if (!(meta.get(WORKER_ENTITY_ASSET_MANIFESTS_KEY) instanceof Y.Map)) {
					meta.set(WORKER_ENTITY_ASSET_MANIFESTS_KEY, new Y.Map<unknown>());
				}
				const map = meta.get(WORKER_ENTITY_ASSET_MANIFESTS_KEY) as Y.Map<unknown>;
				if (map.has(args.assetId)) return;
				map.set(args.assetId, args.manifest);
				appended = true;
			});
		} finally {
			doc.off("update", captureUpdate);
		}
		if (appended && installUpdate) {
			await storeFor(args.vaultPath).appendAndMaybeCompact(args.entityId, installUpdate);
		}
		return { appended };
	},
	// Asset-B4 — read an asset's chunk manifest back from the entity Y.Doc (the
	// lazy-fetch path on a paired device). Returns null if the entity carries no
	// manifest for that assetId.
	readAssetManifest: async (envelope) => {
		const args = parseArgs<ReadAssetManifestArgs>(envelope, "readAssetManifest");
		const { doc } = await ensureDoc(args.vaultPath, args.entityId);
		const meta = doc.getMap<unknown>(WORKER_ENTITY_META_TOP);
		const map = meta.get(WORKER_ENTITY_ASSET_MANIFESTS_KEY);
		if (!(map instanceof Y.Map)) return { manifest: null };
		const manifest = map.get(args.assetId);
		return { manifest: manifest && typeof manifest === "object" ? manifest : null };
	},
	// Asset-B5 — list EVERY (assetId → manifest) pair on the entity Y.Doc, for
	// the cold-device metadata-reconstruction pass after a restore backfill
	// (main validates each manifest; the values are opaque here). Returns []
	// when the entity carries none.
	listAssetManifests: async (envelope) => {
		const args = parseArgs<ListAssetManifestsArgs>(envelope, "listAssetManifests");
		const { doc } = await ensureDoc(args.vaultPath, args.entityId);
		const meta = doc.getMap<unknown>(WORKER_ENTITY_META_TOP);
		const map = meta.get(WORKER_ENTITY_ASSET_MANIFESTS_KEY);
		if (!(map instanceof Y.Map)) return { manifests: [] };
		const manifests: Array<{ assetId: string; manifest: unknown }> = [];
		map.forEach((value, assetId) => {
			if (value && typeof value === "object") manifests.push({ assetId, manifest: value });
		});
		return { manifests };
	},
	// Asset-B4 — read the re-homed asset-DEK wrap back off the entity Y.Doc (the
	// synced-device DEK-recovery path: a device that didn't mint the asset opens
	// the wrap with its entity DEK on main). Returns null if absent. Sibling of
	// `installAssetDekWrap`; no crypto here, the wrap is opaque.
	readAssetDekWrap: async (envelope) => {
		const args = parseArgs<ReadAssetManifestArgs>(envelope, "readAssetDekWrap");
		const { doc } = await ensureDoc(args.vaultPath, args.entityId);
		const meta = doc.getMap<unknown>(WORKER_ENTITY_META_TOP);
		const map = meta.get(WORKER_ENTITY_ASSET_DEKS_KEY);
		if (!(map instanceof Y.Map)) return { wrap: null };
		const wrap = map.get(args.assetId);
		return { wrap: isWorkerSealedSecret(wrap) ? wrap : null };
	},
};

function parseArgs<T>(envelope: Envelope, methodName: string): T {
	const arg = envelope.args[0];
	if (!arg || typeof arg !== "object") {
		throw new Error(`ydoc.${methodName}: missing argument object`);
	}
	// Defense-in-depth: this worker is the single persistence funnel
	// (`storeFor(...).appendAndMaybeCompact(entityId, …)` → `YDocStore.pathFor`
	// → `mkdir`/`writeFile`). Reject a path-traversing id here too, so a future
	// caller that forgets the service-boundary guard still can't escape the
	// vault docs dir. Every handler's args carry `entityId`.
	const candidate = (arg as { entityId?: unknown }).entityId;
	if (candidate !== undefined) {
		assertSafeEntityId(candidate);
	}
	return arg as T;
}

export async function handleYDocEnvelope(raw: unknown): Promise<EnvelopeReply> {
	const validation = validateEnvelope(raw);
	if (!validation.ok) {
		return makeErrorReply(messageIdOrFallback(raw), {
			kind: "Invalid",
			message: validation.reason,
		});
	}
	const envelope = validation.envelope;
	if (envelope.service !== "ydoc") {
		return makeErrorReply(envelope.msg, {
			kind: "Invalid",
			message: `wrong service routed to ydoc worker: ${envelope.service}`,
		});
	}
	const handler = handlers[envelope.method];
	if (!handler) {
		return makeErrorReply(envelope.msg, {
			kind: "Unavailable",
			message: `ydoc method not implemented: ${envelope.method}`,
			method: envelope.method,
		});
	}
	try {
		const value = await handler(envelope);
		return makeOkReply(envelope.msg, value);
	} catch (error) {
		return makeErrorReply(envelope.msg, errorPayload(error));
	}
}

function messageIdOrFallback(raw: unknown): string {
	if (raw && typeof raw === "object") {
		const m = (raw as { msg?: unknown }).msg;
		if (typeof m === "string" && m.length > 0 && m.length <= 128) return m;
	}
	return "unknown";
}

function errorPayload(error: unknown): { kind: string; message: string } {
	if (error instanceof Error) return { kind: error.name || "Error", message: error.message };
	return { kind: "Error", message: String(error) };
}

function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(encoded: string): Uint8Array {
	return new Uint8Array(Buffer.from(encoded, "base64"));
}

// Unused-import suppression for path helpers — they're imported as part of
// the worker's bundle even though only YDocStore uses them. (Vite tree-shakes
// the build, but explicit unused-import would be a lint warning.)
void join;

/** Unwrap the `MessageEvent` that Electron's `parentPort` delivers to the
 *  child, then route to `handleYDocEnvelope`. Exported so the parent-port
 *  wiring is covered by unit tests — the inline `port.on('message', ...)`
 *  block is not directly reachable from Vitest. */
export function handleParentPortMessage(event: ParentPortMessage): Promise<EnvelopeReply> {
	return handleYDocEnvelope(event.data);
}

installWorkerProcessGuards("ydoc");
wireParentPort("ydoc", handleParentPortMessage, (process as ProcessWithParentPort).parentPort);
