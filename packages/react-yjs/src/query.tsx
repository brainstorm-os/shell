/**
 * `useLiveEntities` / `useVaultEntities` — the sanctioned way a React app
 * reads a *live entity list* from the vault. The async counterpart to
 * `useYMap`/`useYText` (which bind a single entity's Yjs document body).
 *
 * Before this, every app hand-rolled the same `vaultEntities.onChange →
 * list() → debounce → short-circuit → setState` flow (the notes coalescer,
 * graph/db `scheduleVaultReload`, files fingerprint, bookmarks
 * `refreshFromRepo`) — a private, slightly-different reactivity stack per
 * app. These hooks are a thin `useSyncExternalStore` wrapper over the pure
 * `createQueryStore`, so the batching/short-circuit/teardown logic lives in
 * exactly one tested place.
 *
 * Read-only by contract: mutations go through `entities.update`.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type {
	Subscription,
	VaultEntitiesListQuery,
	VaultEntitiesService,
	VaultEntitiesSnapshot,
} from "./brainstorm-types";
import { createQueryStore } from "./query-store";
import { EMPTY_VAULT_SNAPSHOT, vaultSnapshotEquals } from "./vault-entities";

/** A live-list source: an async `list()` plus an optional coarse change
 *  signal. A repository (`{ listAll }`) or the `VaultEntitiesService`
 *  (`{ list, onChange }`) both adapt to this in one line. */
export type LiveEntitiesSource<T> = {
	list(): Promise<T>;
	onChange?(listener: () => void): Subscription;
};

export type UseLiveEntitiesOptions<T> = {
	/** Value returned before the first load resolves (the loading state).
	 *  Pass a stable reference (a module-level `[]` / constant) so identity
	 *  is steady across renders. */
	initial: T;
	/** Structural short-circuit so an equal-but-new snapshot doesn't
	 *  re-render. Defaults to `Object.is`; for vault snapshots use
	 *  `useVaultEntities`, which supplies `vaultSnapshotEquals`. */
	equals?: (a: T, b: T) => boolean;
	/** Trailing-debounce window (ms). Default 250. */
	coalesceMs?: number;
	/** Surfaced when a reload rejects; the cached snapshot is kept. */
	onError?: (error: unknown) => void;
};

/**
 * Subscribe to a live entity list. Returns the latest snapshot, re-rendering
 * only when it changes under `equals`. The store is created once per mount;
 * a `null`/absent source yields `initial` and rebinds when the source
 * appears (apps mount before the runtime hands over its services).
 */
export function useLiveEntities<T>(
	source: LiveEntitiesSource<T> | null | undefined,
	options: UseLiveEntitiesOptions<T>,
): T {
	// Latest closures live in a ref so the store is built ONCE — a new store
	// each render would re-load and thrash `useSyncExternalStore`. The store's
	// `load`/`subscribe`/`onError` read through the ref to always hit the
	// current source (whose inline object identity changes every render).
	const ref = useRef({ source, options });
	ref.current = { source, options };

	// `initial`/`equals`/`coalesceMs` are captured at creation and treated as
	// stable (every call site passes a constant `initial` and a module-level
	// comparator). Presence of a source is the only thing that forces a rebuild.
	const hasSource = source != null;

	// biome-ignore lint/correctness/useExhaustiveDependencies: store is created once, reads live closures via `ref`; `initial`/`equals`/`coalesceMs` are stable by contract and `hasSource` is an intentional rebuild key, not a body dep.
	const store = useMemo(
		() =>
			createQueryStore<T>({
				initial: options.initial,
				...(options.equals ? { equals: options.equals } : {}),
				...(options.coalesceMs !== undefined ? { coalesceMs: options.coalesceMs } : {}),
				load: () => {
					const src = ref.current.source;
					return src ? src.list() : Promise.resolve(ref.current.options.initial);
				},
				subscribe: (onInvalidate) => {
					const sub = ref.current.source?.onChange?.(onInvalidate);
					return () => sub?.unsubscribe();
				},
				onError: (error) => ref.current.options.onError?.(error),
			}),
		[hasSource],
	);

	useEffect(() => () => store.dispose(), [store]);

	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Live `{ entities, links }` from the vault — the whole-vault entity
 * snapshot every list/graph surface renders from. Wraps `useLiveEntities`
 * with the version-aware `vaultSnapshotEquals`, so the unconditional
 * `onChange` (it fires on *any* write) only re-renders this app when its
 * slice of the vault actually moved.
 */
export function useVaultEntities(
	service: VaultEntitiesService | null | undefined,
	options: {
		coalesceMs?: number;
		onError?: (error: unknown) => void;
		/** Narrow the snapshot server-side where the service supports it (the
		 *  widget bridge does — F-384). Pass a stable reference: a new object
		 *  identity per render re-subscribes the store. */
		query?: VaultEntitiesListQuery;
	} = {},
): VaultEntitiesSnapshot {
	return useLiveEntities<VaultEntitiesSnapshot>(
		service
			? { list: () => service.list(options.query), onChange: (l) => service.onChange(l) }
			: null,
		{
			initial: EMPTY_VAULT_SNAPSHOT,
			equals: vaultSnapshotEquals,
			...(options.coalesceMs !== undefined ? { coalesceMs: options.coalesceMs } : {}),
			...(options.onError ? { onError: options.onError } : {}),
		},
	);
}
