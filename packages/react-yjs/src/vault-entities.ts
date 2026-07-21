/**
 * Vault entity-list reactivity — the framework-free core shared by the
 * React `useVaultEntities` hook and the DOM-app store factories here. Keeps
 * the version-aware short-circuit (`vaultSnapshotEquals`) and the
 * `onChange`-wiring in one place so neither host re-implements it.
 *
 * `createVaultListStore` / `createVaultEntitiesStore` are the imperative
 * twins of `useVaultEntities`: a DOM app drives them via
 * `store.subscribe(render)` + `store.getSnapshot()`, and crucially never
 * touches `vaultEntities.onChange` itself (the reactivity gate forbids
 * that) — the wiring lives in here.
 */

import type {
	VaultEntitiesService,
	VaultEntitiesSnapshot,
	VaultEntity,
	VaultEntityLink,
} from "@brainstorm-os/sdk-types";
import { type QueryStore, createQueryStore } from "./query-store";

/** The only part of the vault service `createVaultListStore` touches — the
 *  coarse change channel. Deliberately structural and maximally permissive
 *  (optional method, optional `unsubscribe`, allows a `void`/`undefined`
 *  return) so EVERY app's own `window.brainstorm.services.vaultEntities` type
 *  — many declare only the slice they use, with varied `onChange`/`Subscription`
 *  shapes — is assignable without a cast. A source whose `onChange` is absent
 *  just never invalidates (loads once). */
export type VaultChangeSource = {
	onChange?(listener: () => void): { unsubscribe?: () => void } | undefined;
};

/** Stable empty snapshot — the loading state and the null-service fallback.
 *  A shared reference so `getSnapshot()` identity is steady. */
export const EMPTY_VAULT_SNAPSHOT: VaultEntitiesSnapshot = { entities: [], links: [] };

/** Order-independent version fingerprint for an entity: its mutable state
 *  collapses to `updatedAt`/`deletedAt` (the storage worker bumps
 *  `updatedAt` on every write), so two snapshots with the same id→version
 *  map are equal even though `list()` returns fresh objects each call. */
function entityVersion(e: VaultEntity): string {
	return `${e.updatedAt}:${e.deletedAt ?? ""}`;
}

function linkVersion(l: VaultEntityLink): string {
	return `${l.sourceEntityId}>${l.destEntityId}:${l.linkType}:${l.deletedAt ?? ""}`;
}

function listEquals<T extends { id: string }>(
	a: readonly T[],
	b: readonly T[],
	version: (x: T) => string,
): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	const seen = new Map<string, string>();
	for (const x of a) seen.set(x.id, version(x));
	for (const x of b) {
		if (seen.get(x.id) !== version(x)) return false;
	}
	return true;
}

/** Structural equality for vault snapshots, by id + version — so a coarse
 *  `onChange` that didn't touch this app's entities is a no-op re-render. */
export function vaultSnapshotEquals(a: VaultEntitiesSnapshot, b: VaultEntitiesSnapshot): boolean {
	if (a === b) return true;
	return (
		listEquals(a.entities, b.entities, entityVersion) && listEquals(a.links, b.links, linkVersion)
	);
}

export type VaultListStoreOptions<T> = {
	/** The vault service whose coarse `onChange` drives reloads. `null`
	 *  (runtime not ready) → the store loads once and never invalidates. */
	service: VaultChangeSource | null | undefined;
	/** How to fetch the snapshot when the signal fires — `service.list()`,
	 *  or a repository's `listAll()` keyed off the same signal. */
	load: () => Promise<T>;
	initial: T;
	equals?: (a: T, b: T) => boolean;
	coalesceMs?: number;
	onError?: (error: unknown) => void;
};

/**
 * Imperative twin of `useVaultEntities` for DOM apps: a `QueryStore` whose
 * invalidation is wired to the vault's coarse `onChange`. The app calls
 * `store.subscribe(render)` and reads `store.getSnapshot()` — it passes the
 * `service` in but never calls `.onChange` itself.
 */
export function createVaultListStore<T>(opts: VaultListStoreOptions<T>): QueryStore<T> {
	const { service } = opts;
	return createQueryStore<T>({
		initial: opts.initial,
		load: opts.load,
		subscribe: (onInvalidate) => {
			const sub = service?.onChange?.(onInvalidate);
			return () => sub?.unsubscribe?.();
		},
		...(opts.equals ? { equals: opts.equals } : {}),
		...(opts.coalesceMs !== undefined ? { coalesceMs: opts.coalesceMs } : {}),
		...(opts.onError ? { onError: opts.onError } : {}),
	});
}

/**
 * The common case of `createVaultListStore`: a live `{entities, links}`
 * snapshot store sourced from `service.list()`, short-circuited by
 * `vaultSnapshotEquals`. The DOM twin of `useVaultEntities`.
 */
export function createVaultEntitiesStore(
	service: VaultEntitiesService | null | undefined,
	opts: { coalesceMs?: number; onError?: (error: unknown) => void } = {},
): QueryStore<VaultEntitiesSnapshot> {
	return createVaultListStore<VaultEntitiesSnapshot>({
		service,
		load: () => (service ? service.list() : Promise.resolve(EMPTY_VAULT_SNAPSHOT)),
		initial: EMPTY_VAULT_SNAPSHOT,
		equals: vaultSnapshotEquals,
		...(opts.coalesceMs !== undefined ? { coalesceMs: opts.coalesceMs } : {}),
		...(opts.onError ? { onError: opts.onError } : {}),
	});
}
