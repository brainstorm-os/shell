/**
 * `createYDocResolver` — the renderer-side Y.Doc replica resolver
 * (Stage 9.3.2). Pure + transport-injected so the refcount / echo-
 * suppression / async-load-into-synchronous-handle logic is exhaustively
 * testable without IPC or React (mirrors how 9.1's subscription core
 * landed before its consumers).
 *
 * Produces a `YDocResolver` compatible with `<YDocProvider>` (9.1): the
 * SDK preload builds a `YDocTransport` over the capability-gated
 * `entities` service (loadDoc/applyDoc/closeDoc) and injects
 * `resolver.resolve` at Stage 9.3.2b. Until then this core stands alone
 * and tested.
 *
 * Sync model (per — the IPC bridge
 * behaves like a Yjs `Provider`): the renderer holds a full replica
 * (OQ-9). `resolve()` is synchronous (the `<YDocProvider>` contract) so
 * it returns an empty `Y.Doc` immediately and hydrates it from the
 * canonical snapshot asynchronously — the 9.1 hooks re-render when the
 * snapshot lands. Local updates are shipped to the canonical side;
 * canonical-applied updates carry `REMOTE_ORIGIN` so the outbound
 * observer never echoes them back. Live inbound cross-window
 * convergence (`transport.onRemote`) is optional and wired at 9.3.2b.
 */

import * as Y from "yjs";
import type { YDocHandle, YDocResolver } from "./provider";

/** Origin tag for updates applied from the canonical side, so the
 *  outbound observer can distinguish them from local edits. */
export const REMOTE_ORIGIN = Symbol("brainstorm-ydoc-remote");

export type YDocTransport = {
	/** Fetch the entity's canonical snapshot (Yjs update bytes), or null
	 *  when the doc is empty / unavailable. */
	load(entityId: string): Promise<Uint8Array | null>;
	/** Ship a local update to the canonical side. The replica is
	 *  authoritative for the renderer per OQ-9, so the caller does not wait
	 *  on the result — but a transport that CAN fail must return a promise
	 *  and reject, never swallow. A Yjs update is an incremental diff: a
	 *  dropped one is a permanent hole in the canonical doc that every later
	 *  update depends on (its structs sit in `pendingStructs` forever and the
	 *  body renders blank). The resolver answers a rejection by re-shipping
	 *  the replica's FULL state, which heals the hole (Yjs apply is
	 *  idempotent). */
	persist(entityId: string, update: Uint8Array): unknown;
	/** Sort a `persist` rejection into "retrying can heal this" and "retrying
	 *  cannot". Without it every rejection is treated as {@link
	 *  PersistFailureKind.Transient}, which is what shipped in 0.13.0 and what
	 *  made merely *opening* an uncreated Journal day fire five full-state
	 *  resends and then report lost edits that never existed (F-490). The
	 *  transport owns this because it is the only layer that knows the
	 *  protocol's error shapes. */
	classifyPersistFailure?(error: unknown): PersistFailureKind;
	/** The last consumer for this entity unmounted — free the canonical
	 *  handle (refcounted by the worker). Must be idempotent. */
	release(entityId: string): void;
	/** Optional inbound: subscribe to canonical-side updates; returns an
	 *  unsubscribe. Absent in 9.3.2 (live cross-window convergence is
	 *  9.3.2b — needs a worker→renderer broadcast). */
	onRemote?(entityId: string, apply: (update: Uint8Array) => void): () => void;
};

export type YDocResolverApi = {
	/** Synchronous, refcounted resolver for `<YDocProvider resolver=…>`. */
	resolve: YDocResolver;
	/** Resolves once the entity's snapshot has been applied (or there was
	 *  none). Used by `getYFragment` / `getYText` which must hand back a
	 *  hydrated fragment. Unknown entity → already-resolved. */
	whenLoaded(entityId: string): Promise<void>;
	/** Detach every replica + observer (renderer teardown). */
	dispose(): void;
};

export type YDocResolverOptions = {
	/** How many zero-ref replicas to keep live for instant reopen.
	 *
	 *  Apps remount the editor on every navigation (`key={entityId}`), so
	 *  navigating from a note to a sub-page and back releases then
	 *  re-resolves the same entity within a few hundred ms. Destroying the
	 *  replica on the first release is wrong for that flow on two counts:
	 *
	 *   1. Reopen builds a FRESH empty doc and re-applies the snapshot
	 *      asynchronously. The apply can land before — or be observed by a
	 *      binding that registers after — the editor's `observeDeep`, so the
	 *      editor renders blank even though the bytes are on disk (the
	 *      `tests/perf/specs/repro-note-loss.spec.ts` race).
	 *   2. `release()` fires `transport.release()` (→ `closeDoc`) right
	 *      behind a just-shipped fire-and-forget `persist()` (→ `applyDoc`).
	 *      Closing the canonical handle while that write is in flight risks
	 *      dropping the update (the "sub-page link vanishes after reload"
	 *      report).
	 *
	 *  Retaining the released replica's STATE (not the instance — see
	 *  `resolve`) makes reopen seed a fresh doc from memory (instant, no
	 *  IPC reload) and defers `closeDoc` until the entity is genuinely cold
	 *  (evicted past the cap). `0` restores the legacy destroy-on-last-
	 *  release behaviour. */
	retentionCap?: number;
	/** Surfaces a snapshot load/apply failure for an entity. The resolver
	 *  recovers either way — the replica is left empty and local edits still
	 *  ship — but without this hook the failure is invisible: a corrupt or
	 *  unreachable snapshot looks identical to an empty doc. Wire it to a
	 *  logger (and, ideally, a UI affordance) so a doc that silently failed
	 *  to load is distinguishable from a genuinely empty one. */
	onError?(entityId: string, error: unknown): void;
	/** Backoff schedule for the full-state resend that answers a rejected
	 *  `transport.persist` (see `PERSIST_RETRY_DELAYS_MS`). One entry per
	 *  attempt; when the last one fails the loss is reported through
	 *  `onError`. Exposed for tests — production uses the default. */
	persistRetryDelaysMs?: readonly number[];
};

/** Default backoff for the full-state resend. The dominant real cause of a
 *  rejected persist is an entity whose row hasn't committed yet — the Journal
 *  mounts the day editor and emits edits before its implicit `entities.create`
 *  lands, and `entities.applyDoc` answers "not found" until it does. That
 *  window is sub-second; the tail covers a slow disk / busy worker. */
export const PERSIST_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

/** Why the canonical side rejected a `persist`, which decides whether the
 *  full-state resend can ever succeed and whether anything was actually lost. */
export enum PersistFailureKind {
	/** The canonical side is not ready yet (worker starting, disk busy, a row
	 *  mid-create). Re-shipping full state heals it — this is the F-488 case. */
	Transient = "transient",
	/** No entity row exists and none is being created. Retrying cannot invent
	 *  one, and the update was almost certainly an editor's mount scaffold
	 *  rather than authored text, so this is NOT a data loss. */
	EntityMissing = "entity-missing",
	/** The caller may not write this entity. The ledger does not change under
	 *  an open doc, so every resend would be refused identically. */
	Denied = "denied",
}

/** A `persist` the resolver stopped trying to complete. Carries the kind and
 *  the ORIGINAL rejection: 0.13.0 reported a fixed sentence and discarded the
 *  cause, which is why diagnosing F-488 in the real shell needed a separate
 *  probe to recover what the canonical side had actually said. */
export class PersistFailedError extends Error {
	readonly entityId: string;
	readonly kind: PersistFailureKind;
	readonly attempts: number;

	constructor(entityId: string, kind: PersistFailureKind, attempts: number, cause: unknown) {
		super(`ydoc: ${entityId}: ${describePersistFailure(kind, attempts)}: ${describeCause(cause)}`, {
			cause,
		});
		this.name = "PersistFailedError";
		this.entityId = entityId;
		this.kind = kind;
		this.attempts = attempts;
	}
}

function describePersistFailure(kind: PersistFailureKind, attempts: number): string {
	switch (kind) {
		case PersistFailureKind.Denied:
			return "the canonical side refused the write, so these edits cannot be saved";
		case PersistFailureKind.EntityMissing:
			// Deliberately makes no claim about lost edits — see the enum.
			return "no entity row exists, so this document was never persisted";
		default:
			return `${attempts} persist attempts were rejected — local edits are not durable`;
	}
}

function describeCause(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	return String(cause);
}

/** Default zero-ref retention. Bounds memory (each retained replica holds a
 *  full Y.Doc) while comfortably covering navigate-away-and-back plus a
 *  handful of recently-visited docs. */
export const DEFAULT_RETENTION_CAP = 16;

type Entry = {
	doc: Y.Doc;
	refs: number;
	loaded: Promise<void>;
	/** Trigger the snapshot apply NOW. Idempotent — subsequent calls return
	 *  the same `loaded` promise. The editor calls this from inside its
	 *  `LocalProvider.connect()`, which `@lexical/react`'s
	 *  `CollaborationPlugin` invokes AFTER it registers the binding's
	 *  `observeDeep`. Applying earlier (when the IPC roundtrip finishes,
	 *  which can land before React mounts the editor) fires the Yjs
	 *  update events into a doc no observer is listening on — Lexical's
	 *  collabNodeMap stays empty, the editor renders blank on reopen
	 *  even though Yjs has the content. See
	 *  `tests/perf/specs/repro-note-loss.spec.ts` for the regression. */
	applyPending: () => Promise<void>;
	/** True once `applyPending()` has completed — the snapshot is in `doc`
	 *  (or there was none). Revive may only seed a fresh replica from this
	 *  one's in-memory state when this holds; otherwise the replica was
	 *  released before it ever hydrated and is still empty, so the canonical
	 *  snapshot must be re-loaded from disk instead. */
	hasApplied: () => boolean;
	/** True while a persist has failed and its full-state resend hasn't
	 *  succeeded yet — i.e. the canonical side is missing part of this
	 *  replica. A revive must carry that debt across (the seed it hands the
	 *  fresh replica is applied as REMOTE, so it would otherwise never ship). */
	hasPendingPersist: () => boolean;
	/** Ship state to the canonical side now — the replica's own full state by
	 *  default, or explicit bytes (a revive ships the seed, because the fresh
	 *  replica hasn't applied it yet: `applyPending` is lazy by design). */
	resend: (state?: Uint8Array) => void;
	detach: () => void;
};

export function createYDocResolver(
	transport: YDocTransport,
	options: YDocResolverOptions = {},
): YDocResolverApi {
	const retentionCap = options.retentionCap ?? DEFAULT_RETENTION_CAP;
	const reportError = options.onError ?? (() => {});
	const retryDelays =
		options.persistRetryDelaysMs && options.persistRetryDelaysMs.length > 0
			? options.persistRetryDelaysMs
			: PERSIST_RETRY_DELAYS_MS;
	const entries = new Map<string, Entry>();
	// Zero-ref entries kept live for instant reopen, in least-recently-
	// released order (insertion order = LRU; re-resolving deletes the key so
	// a later re-release re-appends it as most-recent). Eviction past the cap
	// is the ONLY place a retained replica is torn down.
	const retained = new Map<string, Entry>();
	let disposed = false;

	function tearDown(entityId: string, entry: Entry): void {
		entry.detach();
		transport.release(entityId);
	}

	function evictRetainedOverCap(): void {
		while (retained.size > retentionCap) {
			const oldest = retained.keys().next().value;
			if (oldest === undefined) break;
			const victim = retained.get(oldest);
			retained.delete(oldest);
			if (victim) tearDown(oldest, victim);
		}
	}

	function open(entityId: string, seedState?: Uint8Array): Entry {
		const doc = new Y.Doc();

		// Full-state resend after a rejected persist. A Yjs update is a diff,
		// so a dropped one is NOT re-carried by the next update — the canonical
		// doc keeps a permanent hole and every struct that depends on it sits in
		// `pendingStructs` forever, which is exactly how a Journal day rendered
		// an empty body while its denormalised snippet still read "5 words".
		// `Y.encodeStateAsUpdate(doc)` carries everything and Yjs apply is
		// idempotent, so one successful resend heals any number of drops.
		let detached = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let retryAttempt = 0;
		let lastFailure: { kind: PersistFailureKind; cause: unknown } | null = null;

		const classify = (error: unknown): PersistFailureKind =>
			transport.classifyPersistFailure?.(error) ?? PersistFailureKind.Transient;

		const giveUp = (kind: PersistFailureKind, cause: unknown, attempts: number): void => {
			lastFailure = null;
			reportError(entityId, new PersistFailedError(entityId, kind, attempts, cause));
		};

		const onPersistRejected = (error: unknown): void => {
			const kind = classify(error);
			lastFailure = { kind, cause: error };
			// A refusal is not a race. The ledger does not change under an open
			// doc, so every resend would be refused identically — retrying only
			// re-ships the whole document at a boundary that has already said no.
			if (kind === PersistFailureKind.Denied) {
				giveUp(kind, error, 1);
				return;
			}
			scheduleResend();
		};

		const scheduleResend = (): void => {
			if (detached || retryTimer !== null) return;
			if (retryAttempt >= retryDelays.length) {
				const failure = lastFailure;
				if (failure) giveUp(failure.kind, failure.cause, retryDelays.length);
				return;
			}
			const delay = retryDelays[retryAttempt] ?? 0;
			retryAttempt += 1;
			retryTimer = setTimeout(() => {
				retryTimer = null;
				if (detached) return;
				shipUpdate(Y.encodeStateAsUpdate(doc));
			}, delay);
		};
		const shipUpdate = (update: Uint8Array): void => {
			// `persist` is typed `unknown` so a fire-and-forget (void-returning)
			// transport still satisfies it; only a thenable can report a failure.
			const result = transport.persist(entityId, update);
			if (!isThenable(result)) return;
			void result.then(() => {
				retryAttempt = 0;
				lastFailure = null;
			}, onPersistRejected);
		};

		const onUpdate = (update: Uint8Array, origin: unknown): void => {
			if (origin === REMOTE_ORIGIN) return; // canonical-applied — don't echo
			shipUpdate(update);
		};
		doc.on("update", onUpdate);

		const offRemote = transport.onRemote?.(entityId, (update) => {
			Y.applyUpdate(doc, update, REMOTE_ORIGIN);
		});

		// Revival seeds the snapshot from the just-released replica's
		// in-memory state instead of re-loading over IPC (instant, and the
		// canonical handle was never closed). The bytes still flow through the
		// SAME lazy `applyPending` path as a disk load, so they land AFTER the
		// editor binding's `observeDeep` — a fresh doc fires the Yjs events
		// that populate Lexical. Reusing the retained doc *instance* instead
		// would leave a fresh binding observing an already-populated doc that
		// emits no events → blank editor (the navigate-back regression).
		const loadedBytes: Promise<Uint8Array | null> =
			seedState !== undefined
				? Promise.resolve(seedState)
				: transport.load(entityId).catch((err) => {
						reportError(entityId, err);
						return null;
					});

		// Lazy apply: hold the snapshot until `applyPending()` is called from
		// inside the editor's binding wiring (see Entry.applyPending docs
		// above for the race this guards against). `loaded` is the public
		// "snapshot is in the doc" gate; it resolves the first time
		// applyPending() completes. The resolver-level `whenLoaded(entityId)`
		// accessor (below) triggers `applyPending()` on the entry so
		// non-editor callers (the Notes body-migration scan) don't have to
		// know about the dual API.
		// `loaded` is a deferred — it resolves the first time `applyPending()`
		// runs (whoever triggers the apply: the editor's LocalProvider,
		// the resolver-level `whenLoaded(id)` accessor for non-editor
		// callers, etc.). Awaiting `loaded` BEFORE anyone triggers apply
		// blocks indefinitely — by design — so a missing editor binding is
		// detectable as a hang rather than silently rendering blank.
		let resolveLoaded: () => void = () => {};
		const loaded = new Promise<void>((res) => {
			resolveLoaded = res;
		});
		let applyPromise: Promise<void> | null = null;
		let applied = false;
		const applyPending = (): Promise<void> => {
			if (applyPromise) return applyPromise;
			applyPromise = (async () => {
				try {
					const snapshot = await loadedBytes;
					if (snapshot && snapshot.length > 0) Y.applyUpdate(doc, snapshot, REMOTE_ORIGIN);
				} catch (err) {
					// A corrupt / half-written snapshot must not strand the
					// editor: `Y.applyUpdate` throwing here previously left
					// `loaded` unsettled forever (the LocalProvider awaits it)
					// and cached a rejected `applyPromise` so retries couldn't
					// recover. Report it and fall through — the replica stays
					// empty but live, so local edits still ship and the user
					// can keep working rather than facing a frozen surface.
					reportError(entityId, err);
				} finally {
					applied = true;
					resolveLoaded();
				}
			})();
			return applyPromise;
		};

		return {
			doc,
			refs: 0,
			loaded,
			applyPending,
			hasApplied: () => applied,
			hasPendingPersist: () => retryAttempt > 0,
			resend: (state) => shipUpdate(state ?? Y.encodeStateAsUpdate(doc)),
			detach: () => {
				detached = true;
				if (retryTimer !== null) {
					clearTimeout(retryTimer);
					retryTimer = null;
					// Teardown cancels the heal. If the canonical side was still
					// missing real content, saying nothing here is how a loss
					// becomes invisible — the failure mode this whole path exists
					// to end. EntityMissing is exempt: no row was ever created, so
					// the update was a mount scaffold and nothing was lost.
					const failure = lastFailure;
					if (failure && failure.kind !== PersistFailureKind.EntityMissing) {
						giveUp(failure.kind, failure.cause, retryAttempt);
					}
				}
				doc.off("update", onUpdate);
				offRemote?.();
				doc.destroy();
			},
		};
	}

	const resolve: YDocResolver = (entityId: string): YDocHandle => {
		let entry = entries.get(entityId);
		if (!entry) {
			// Revive from a retained replica when one is live: seed a fresh doc
			// from its in-memory state (no IPC reload, canonical never closed)
			// and discard the old instance. A fresh doc is required so the new
			// editor binding's `observeDeep` receives the seed as Yjs events —
			// reusing the populated instance directly renders blank.
			const kept = retained.get(entityId);
			if (kept) {
				retained.delete(entityId);
				// Only seed from the retained replica's in-memory state when it
				// actually hydrated. A replica released before its `applyPending()`
				// ran is still EMPTY — seeding from it (and skipping the disk load,
				// as `open(seed)` does) would render a blank doc and never re-read
				// the canonical snapshot. In that case fall back to a normal open
				// so `transport.load` runs.
				const seed = kept.hasApplied() ? Y.encodeStateAsUpdate(kept.doc) : undefined;
				// The seed is applied as REMOTE (never echoed back to the
				// canonical side), so a replica that still owed the canonical
				// side an update would silently lose that debt across the
				// revive. Carry it over and re-ship from the fresh replica.
				// Snapshot the debt BEFORE detaching. `seed` is undefined when the
				// replica never hydrated, but it can still hold local edits the
				// canonical side never took, so the owed state has to come from the
				// replica's own doc rather than from `seed` (0.13.0 keyed the
				// re-ship on `seed` and silently dropped the debt on that branch).
				const owedState = kept.hasPendingPersist() ? Y.encodeStateAsUpdate(kept.doc) : undefined;
				kept.detach(); // destroy the old replica WITHOUT closing canonical
				entry = open(entityId, seed);
				if (owedState) entry.resend(owedState);
			} else {
				entry = open(entityId);
			}
			entries.set(entityId, entry);
		}
		entry.refs += 1;

		let released = false;
		const entryRef = entry;
		return {
			doc: entry.doc,
			loaded: entry.loaded,
			applyPending: () => entryRef.applyPending(),
			release: () => {
				if (released) return; // per-handle idempotent
				released = true;
				const current = entries.get(entityId);
				if (!current) return;
				current.refs -= 1;
				if (current.refs > 0) return;
				entries.delete(entityId);
				if (retentionCap <= 0) {
					tearDown(entityId, current);
					return;
				}
				// Keep the live, already-observed replica for instant reopen.
				// `transport.release()` (→ closeDoc) is deferred until eviction
				// so it can't race a just-shipped persist on navigate-away.
				retained.set(entityId, current);
				evictRetainedOverCap();
			},
		};
	};

	return {
		resolve,
		// External-caller convenience: triggers the apply AND waits for it.
		// Used by migration paths that don't go through the editor's
		// LocalProvider (which has its own apply trigger inside connect()).
		whenLoaded: (entityId: string) => {
			const entry = entries.get(entityId) ?? retained.get(entityId);
			if (!entry) return Promise.resolve();
			return entry.applyPending();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			for (const [id, entry] of entries) tearDown(id, entry);
			entries.clear();
			for (const [id, entry] of retained) tearDown(id, entry);
			retained.clear();
		},
	};
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PromiseLike<unknown>).then === "function"
	);
}
