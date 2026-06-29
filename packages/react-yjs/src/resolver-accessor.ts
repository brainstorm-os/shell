/**
 * Memoised renderer-side resolver accessor — the singleton wrapper every
 * Yjs-backed app (Notes, Journal, Code Editor, Tasks) built around
 * `createYDocResolver`.
 *
 * `contextBridge.exposeInMainWorld` structured-clones values across the
 * preload→renderer boundary and a Y.Doc can't survive that clone, so the
 * resolver core runs in the renderer over IPC-cloneable primitives:
 * `services.entities.loadDoc / applyDoc / closeDoc` (base64 strings) and
 * `ydoc.onRemote(entityId, cb)`. Pass your runtime getter; get back a
 * memoised `() => YDocResolverApi | null` that returns null (so the app can
 * degrade to an in-memory / read-only fallback) until the shell exposes a
 * doc surface — e.g. the `vite preview` / Playwright harness drops.
 */

import { type YDocResolverApi, type YDocTransport, createYDocResolver } from "./resolver";

/** A `loadDoc` rejection for an entity whose Y.Doc isn't persisted yet (the
 *  renderer mounted the editor before the create committed). Benign — distinct
 *  from a corrupt/failed hydrate, which the resolver should still surface. */
function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && /not found/i.test(error.message);
}

/** The doc slice of the entities service the resolver needs. Methods are
 *  optional so a runtime that only conditionally exposes them still
 *  type-checks; the accessor guards their presence at call time. */
export type EntitiesDocApi = {
	loadDoc?: (entityId: string) => Promise<{ snapshotB64?: string | null }>;
	applyDoc?: (entityId: string, updateB64: string) => unknown;
	closeDoc?: (entityId: string) => unknown;
};

/** The inbound-subscription slice of the `ydoc` bridge. `onRemote` may
 *  return a bare unsubscribe function or an `{ unsubscribe }` object — both
 *  are normalised. */
export type YDocRemoteBridge = {
	onRemote(
		entityId: string,
		apply: (updateB64: string) => void,
	): (() => void) | { unsubscribe?: () => void };
};

export type YDocResolverRuntime = {
	services?: { entities?: EntitiesDocApi } | null;
	ydoc?: YDocRemoteBridge;
};

/**
 * Build a memoised `getYDocResolverApi`. The first call that finds a usable
 * runtime constructs the resolver and caches it; subsequent calls return the
 * same instance. Returns null until (and unless) the runtime exposes both
 * the entities doc methods and the `ydoc` bridge.
 */
export function createYDocResolverAccessor(
	getRuntime: () => YDocResolverRuntime | null,
): () => YDocResolverApi | null {
	let cached: YDocResolverApi | null = null;
	return () => {
		if (cached) return cached;
		const rt = getRuntime();
		if (!rt) return null;
		const entities = rt.services?.entities;
		const ydoc = rt.ydoc;
		if (!entities?.loadDoc || !entities.applyDoc || !entities.closeDoc || !ydoc) return null;
		const loadDoc = entities.loadDoc.bind(entities);
		const applyDoc = entities.applyDoc.bind(entities);
		const closeDoc = entities.closeDoc.bind(entities);
		const transport: YDocTransport = {
			load: async (entityId) => {
				try {
					const { snapshotB64 } = await loadDoc(entityId);
					return snapshotB64 ? b64ToBytes(snapshotB64) : null;
				} catch (error) {
					// A freshly-created entity may not have a persisted Y.Doc yet —
					// the renderer can mount the editor before the create commits.
					// That "not found" is benign (empty replica → first persist
					// creates it); only re-throw genuine failures so they still
					// reach `onError`.
					if (isNotFoundError(error)) return null;
					throw error;
				}
			},
			persist: (entityId, update) => {
				// Symmetric with `load`: an editor can mount + emit edits before the
				// entity's create commits (e.g. a journal day created lazily on first
				// input). Persisting to a not-yet-created entity is benign — drop it
				// rather than surface an unhandled rejection; the next persist after
				// the create carries the full CRDT state. Genuine failures still throw.
				void Promise.resolve(applyDoc(entityId, bytesToB64(update))).catch((error) => {
					if (isNotFoundError(error)) return;
					throw error;
				});
			},
			release: (entityId) => {
				void closeDoc(entityId);
			},
			onRemote: (entityId, apply) => {
				const sub = ydoc.onRemote(entityId, (updateB64) => {
					apply(b64ToBytes(updateB64));
				});
				// The bridge accepts either an unsubscribe function or an
				// `{ unsubscribe }` object — normalise to the former.
				if (typeof sub === "function") return sub;
				return () => {
					sub.unsubscribe?.();
				};
			},
		};
		cached = createYDocResolver(transport, {
			onError: (entityId, error) => {
				// Renderer-side: a snapshot load/apply failure leaves an empty
				// replica that still accepts edits, so it's recoverable — but
				// log it so a doc that silently failed to hydrate (corrupt
				// snapshot, IPC/disk error) is visible instead of looking like
				// a genuinely empty entity.
				console.error(`[react-yjs] failed to load Y.Doc for entity ${entityId}`, error);
			},
		});
		return cached;
	};
}

export function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}
