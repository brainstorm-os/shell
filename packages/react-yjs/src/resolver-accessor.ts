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

import {
	PersistFailedError,
	PersistFailureKind,
	type YDocResolverApi,
	type YDocTransport,
	createYDocResolver,
} from "./resolver";

/** Sort an `entities.applyDoc` rejection for the resolver's retry logic.
 *
 *  The broker puts the handler's `error.name` on the wire as the error kind
 *  (`broker.ts` → `{ kind: error.name }`), and `makeSdkError` rebuilds it
 *  renderer-side, so the name survives intact: `entities-service` throws
 *  `Denied` for a missing `entities.write`, and `Invalid` with a "not found"
 *  message while a row has not committed.
 *
 *  Matching the message for the missing-row case is deliberate — `Invalid`
 *  also covers malformed arguments, which a resend genuinely might not fix but
 *  which is not the "nothing was ever created" case either. */
export function classifyPersistFailure(error: unknown): PersistFailureKind {
	if (!(error instanceof Error)) return PersistFailureKind.Transient;
	if (error.name === "Denied" || error.name === "CapabilityDenied") {
		return PersistFailureKind.Denied;
	}
	if (isNotFoundError(error)) return PersistFailureKind.EntityMissing;
	return PersistFailureKind.Transient;
}

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
			persist: (entityId, update) =>
				// Rejections are the resolver's business, not ours. An editor can
				// mount + emit edits before the entity's create commits (a journal
				// day is created lazily on first input) and `entities.applyDoc`
				// answers "not found" until it does. Swallowing that DROPPED the
				// update for good: a Yjs update is a diff, so the next persist does
				// NOT re-carry it — the canonical doc keeps a permanent hole and
				// every later struct that depends on it never integrates, which is
				// how a Journal day rendered a blank body while its denormalised
				// snippet still read "5 words". Surfacing the rejection lets the
				// resolver re-ship the replica's full state, which heals it.
				Promise.resolve(applyDoc(entityId, bytesToB64(update))),
			classifyPersistFailure,
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
				// Two different failures arrive here and 0.13.0 reported both as
				// "failed to load", which is how six *persist* failures per session
				// were logged as load errors (F-490). Say which one happened, and
				// do not shout about a document nobody ever wrote in.
				if (error instanceof PersistFailedError) {
					if (error.kind === PersistFailureKind.EntityMissing) {
						console.debug(`[react-yjs] ${entityId}: nothing to persist`, error.message);
						return;
					}
					console.error(`[react-yjs] failed to persist Y.Doc for entity ${entityId}`, error);
					return;
				}
				// A snapshot load/apply failure leaves an empty replica that still
				// accepts edits, so it's recoverable — but log it so a doc that
				// silently failed to hydrate (corrupt snapshot, IPC/disk error) is
				// visible instead of looking like a genuinely empty entity.
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
