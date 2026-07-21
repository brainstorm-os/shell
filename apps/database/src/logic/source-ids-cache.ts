/**
 * 9.12.3 (app half) — shell-resolved `ListSource` membership cache.
 *
 * The service half landed first: `vaultEntities.querySource({source})`
 * resolves a saved List's dynamic `source` to its live member id set
 * shell-side (SQL fast paths + the shared `predicate-eval` evaluator).
 * This module is the renderer's adapter: an async refresh fills a
 * per-list id-set cache from the service, and the synchronous render
 * path consults it through `compileMembershipWith` — falling back to
 * the in-memory `evaluateSource` until the shell answer lands (or when
 * the service is absent / rejects the source). Render never awaits.
 *
 * Entries are keyed by list id and stamped with a fingerprint of the
 * source they were resolved FROM, so editing a List's criteria can
 * never serve the previous criteria's ids — a fingerprint miss reads
 * as "not resolved" and the local evaluator covers the gap until the
 * next refresh. A generation counter makes refreshes last-writer-wins:
 * a slow older refresh resolving after a newer one is discarded
 * wholesale instead of clobbering fresher entries.
 */

import type { List, ListSource, SourceQueryResult } from "@brainstorm-os/sdk-types";
import { applyMemberOverrides, evaluateSource } from "./evaluate-source";
import type { InMemoryEntities } from "./in-memory-entities";

export type SourceQueryService = {
	querySource(source: ListSource | null): Promise<SourceQueryResult>;
};

/** Stable identity of a source's *content* (not its object reference) —
 *  the cache must invalidate when the user edits criteria even though
 *  the list id is unchanged. */
export function sourceFingerprint(source: ListSource): string {
	return JSON.stringify(source);
}

type CacheEntry = {
	fingerprint: string;
	ids: ReadonlySet<string>;
};

export type SourceIdsCache = {
	/** Shell-resolved ids for the list's CURRENT source, or `null` when
	 *  unresolved (no refresh yet, source edited since, service rejected
	 *  it, or the list has no source). `null` means "evaluate locally". */
	lookup(list: List): ReadonlySet<string> | null;
	/** Re-resolve every sourced list through the service. Resolves to
	 *  whether any entry materially changed (new ids, dropped list, …) —
	 *  the caller's re-render signal. Service errors / rejected sources
	 *  drop that list's entry (fall back to local evaluation); a thrown
	 *  service never rejects the refresh. */
	refresh(lists: ReadonlyArray<List>, service: SourceQueryService): Promise<boolean>;
	clear(): void;
};

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}

export function createSourceIdsCache(): SourceIdsCache {
	const entries = new Map<string, CacheEntry>();
	let generation = 0;

	return {
		lookup(list: List): ReadonlySet<string> | null {
			if (list.source === null) return null;
			const entry = entries.get(list.id);
			if (!entry) return null;
			if (entry.fingerprint !== sourceFingerprint(list.source)) return null;
			return entry.ids;
		},

		async refresh(lists, service): Promise<boolean> {
			generation += 1;
			const mine = generation;
			const sourced = lists.filter((l) => l.source !== null);

			const resolved = await Promise.all(
				sourced.map(async (list) => {
					try {
						const result = await service.querySource(list.source);
						return { list, result };
					} catch {
						return { list, result: null };
					}
				}),
			);
			// A newer refresh started while this one was in flight — its
			// answers are fresher; discard ours entirely.
			if (mine !== generation) return false;

			let changed = false;
			const liveIds = new Set<string>();
			for (const { list, result } of resolved) {
				liveIds.add(list.id);
				const fingerprint = sourceFingerprint(list.source as ListSource);
				if (result?.ok) {
					const ids: ReadonlySet<string> = new Set(result.ids);
					const prev = entries.get(list.id);
					if (!prev || prev.fingerprint !== fingerprint || !sameIds(prev.ids, ids)) {
						changed = true;
					}
					entries.set(list.id, { fingerprint, ids });
				} else if (entries.delete(list.id)) {
					changed = true;
				}
			}
			for (const id of [...entries.keys()]) {
				if (!liveIds.has(id)) {
					entries.delete(id);
					changed = true;
				}
			}
			return changed;
		},

		clear(): void {
			entries.clear();
		},
	};
}

/** `compileMembership` with an optional shell-resolved source id set:
 *  when `shellSourceIds` is non-null it replaces the in-memory
 *  `evaluateSource` walk (the 9.12.3 read path); member overrides stay
 *  client-side either way — `effective = (source ∪ include) \ exclude`. */
export function compileMembershipWith(
	list: List,
	db: InMemoryEntities,
	shellSourceIds: ReadonlySet<string> | null,
): Set<string> {
	const sourceIds = shellSourceIds ? new Set(shellSourceIds) : evaluateSource(list.source, db);
	return applyMemberOverrides(sourceIds, list.members.include, list.members.exclude);
}
