/**
 * The React surface: `useYDoc`, `useYMap`, `useYText`, `useYXmlFragment`,
 * `useAwareness`. These are *the* way React touches Yjs (per
 *  §State management) and are deliberately
 * read-only — mutations go through the SDK's `entities.update`.
 *
 * Each hook is a thin `useSyncExternalStore` binding over a pure `YStore`
 * from `./stores` / `./awareness`; all batching/stability logic lives
 * there so it can be tested without a renderer.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { type AwarenessLike, type AwarenessSnapshot, awarenessStore } from "./awareness";
import { type YDocHandle, type YDocResolver, useOptionalYDocResolver } from "./provider";
import type { YDocResolverApi } from "./resolver";
import {
	yDocStore,
	yMapKeyStore,
	yMapStore,
	yTextStore,
	yXmlFragmentStore,
	yXmlTextStore,
} from "./stores";
import type { YStore } from "./subscription";

function useStoreValue<T>(store: YStore<T>): T {
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function useResolvedDoc(target: Y.Doc | string): {
	doc: Y.Doc;
	loaded: Promise<void> | undefined;
	applyPending: (() => Promise<void>) | undefined;
} {
	const resolver = useOptionalYDocResolver();
	// `resolver(target)` is IMPURE — it takes a refcount on the entity's replica
	// and mutates the resolver's live-entry map. React may invoke a `useMemo`
	// factory more times than its result is committed (StrictMode double-render,
	// a concurrent render that's thrown away), and each extra call would take an
	// unmatched refcount. Those leaked refs pin the entry in the live map, so a
	// later reopen REUSES the already-populated doc instead of reviving a fresh
	// one — and a new `@lexical/yjs` binding on a full doc gets zero observeDeep
	// events and renders BLANK (the "previously-opened entry opens blank on the
	// second visit" bug; refs were observed climbing 9→14 in the field). Dedupe
	// the acquisition through a ref so repeated factory runs for the same
	// (resolver, target) reuse the single handle, releasing any superseded one.
	const acquiredRef = useRef<{
		resolver: YDocResolver;
		target: string;
		handle: YDocHandle;
	} | null>(null);
	const handle = useMemo<YDocHandle | null>(() => {
		if (typeof target !== "string") return null;
		if (!resolver) {
			throw new Error(
				"react-yjs: useYDoc(entityId) needs a <YDocProvider>. The SDK installs the entity→doc resolver at Stage 9.3 (Block Protocol + entities service); until then pass a Y.Doc directly.",
			);
		}
		const prev = acquiredRef.current;
		if (prev && prev.resolver === resolver && prev.target === target) return prev.handle;
		prev?.handle.release();
		const acquired = resolver(target);
		acquiredRef.current = { resolver, target, handle: acquired };
		return acquired;
	}, [resolver, target]);

	useEffect(() => {
		return () => {
			handle?.release();
			if (acquiredRef.current?.handle === handle) acquiredRef.current = null;
		};
	}, [handle]);

	if (typeof target !== "string") return { doc: target, loaded: undefined, applyPending: undefined };
	const h = handle as YDocHandle;
	return { doc: h.doc, loaded: h.loaded, applyPending: h.applyPending };
}

/**
 * Blank-render recovery gap (F-236). When an editor bound to an entity's
 * Y.Doc renders no content while the doc HAS content (an apply/observeDeep
 * race that lost a seeded / cold-reopened body), the cure is NOT a same-id
 * key bump: `useYDoc` resolves the replica during render but releases it in
 * an effect cleanup, so a key bump re-resolves (returning the SAME populated
 * doc, ref still held) before the old editor's cleanup runs — the entry never
 * reaches refs 0, never gets retained/revived, and the new binding observes a
 * full doc with zero `observeDeep` events → permanently blank.
 *
 * Instead the caller renders an explicit unmount GAP: render `null` while
 * `gapped` is true (one frame), which fully releases the old replica
 * (refs → 0 → the resolver retains it), then remount so the resolver revives
 * it into a FRESH doc whose snapshot re-applies after the new binding's
 * `observeDeep` — the path that reliably hydrates. Keep a stable
 * `key={resetKey}` on the editor so a genuine target switch still fully
 * remounts. Wire the returned `onRecoverBlank` / `onRecoverReset` into the
 * editor's blank-recovery plugin.
 *
 * `resetKey` (the entity id) resets the per-target attempt budget + any
 * in-flight gap on a switch; `maxAttempts` caps retries so a genuinely
 * unhydratable doc can't loop.
 */
export function useBlankRecoveryGap(
	resetKey: string,
	maxAttempts = 2,
): { gapped: boolean; onRecoverBlank: () => void; onRecoverReset: () => void } {
	const [gapped, setGapped] = useState(false);
	const attemptsRef = useRef(0);

	// Reset the recovery budget + any in-flight gap when the target switches.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the intended trigger.
	useEffect(() => {
		attemptsRef.current = 0;
		setGapped(false);
	}, [resetKey]);

	// While gapped, the caller unmounts the editor subtree (its replica
	// released this commit); flip back next frame so the resolver revives a
	// fresh doc on remount.
	useEffect(() => {
		if (!gapped) return;
		const raf = requestAnimationFrame(() => setGapped(false));
		return () => cancelAnimationFrame(raf);
	}, [gapped]);

	const onRecoverBlank = useCallback(() => {
		if (attemptsRef.current >= maxAttempts) return;
		attemptsRef.current += 1;
		setGapped(true);
	}, [maxAttempts]);
	const onRecoverReset = useCallback(() => {
		attemptsRef.current = 0;
	}, []);

	return { gapped, onRecoverBlank, onRecoverReset };
}

/**
 * Subscribe to an entity's Y.Doc (by id, via the injected resolver) or to
 * a Y.Doc passed directly. Re-renders on any update to the doc; returns
 * the doc so the caller can read sub-structures (typically through the
 * other hooks).
 */
export function useYDoc(target: Y.Doc | string): Y.Doc {
	const { doc } = useResolvedDoc(target);
	const store = useMemo(() => yDocStore(doc), [doc]);
	useStoreValue(store);
	return doc;
}

/**
 * Resolves the doc AND returns the resolver's `loaded` promise that
 * fires once the on-disk snapshot has been merged into the replica.
 * Consumers that bootstrap content (an editor seeder, a one-shot
 * migration) MUST wait for this before writing — otherwise the
 * still-empty replica accepts the bootstrap content, the snapshot lands
 * later via `Y.applyUpdate`, and the CRDT keeps BOTH inserts.
 * For `useYDoc(doc)` the promise is `undefined` (caller already has a
 * fully-resolved doc).
 */
export function useYDocLoaded(target: Y.Doc | string): Promise<void> | undefined {
	const { loaded } = useResolvedDoc(target);
	return loaded;
}

/**
 * Returns the apply trigger for the entity's pending snapshot. Editors
 * call this inside their binding's `connect()` so `Y.applyUpdate` fires
 * AFTER `@lexical/yjs`'s `observeDeep` has been registered. Without this
 * sequencing, the snapshot's Yjs update events fire into a doc whose
 * binding isn't yet listening and the editor renders blank on reopen
 * (regression repro: `tests/perf/specs/repro-note-loss.spec.ts`).
 */
export function useYDocApplyPending(target: Y.Doc | string): (() => Promise<void>) | undefined {
	const { applyPending } = useResolvedDoc(target);
	return applyPending;
}

export function useYText(text: Y.Text): string {
	const store = useMemo(() => yTextStore(text), [text]);
	return useStoreValue(store);
}

export function useYMap<V>(map: Y.Map<V>): ReadonlyMap<string, V>;
export function useYMap<V>(map: Y.Map<V>, key: string): V | undefined;
export function useYMap<V>(map: Y.Map<V>, key?: string): ReadonlyMap<string, V> | V | undefined {
	// The two builders produce disjoint snapshot types; the public
	// overloads above keep callers type-safe, so widening the internal
	// store to the union is sound.
	const store = useMemo<YStore<ReadonlyMap<string, V> | V | undefined>>(
		() =>
			(key === undefined ? yMapStore(map) : yMapKeyStore(map, key)) as YStore<
				ReadonlyMap<string, V> | V | undefined
			>,
		[map, key],
	);
	return useStoreValue(store);
}

/**
 * Change-signal for a rich-text fragment. Lexical (via `@lexical/yjs`)
 * binds to the fragment itself; this hook just forces a re-render when
 * the fragment changes. The returned number is an opaque monotonic
 * version — compare across renders, don't interpret.
 */
export function useYXmlFragment(fragment: Y.XmlFragment): number {
	const store = useMemo(() => yXmlFragmentStore(fragment), [fragment]);
	return useStoreValue(store);
}

/**
 * Change-signal for an `Y.XmlText` — the rich-text body root. Like
 * `useYXmlFragment`, Lexical (via `@lexical/yjs`) binds to the text itself;
 * this hook only forces a re-render when it changes. The returned number is
 * an opaque monotonic version — compare across renders, don't interpret.
 */
export function useYXmlText(text: Y.XmlText): number {
	const store = useMemo(() => yXmlTextStore(text), [text]);
	return useStoreValue(store);
}

export type UseAwarenessResult = AwarenessSnapshot & {
	setLocalState(state: Record<string, unknown> | null): void;
	setLocalStateField(field: string, value: unknown): void;
};

export function useAwareness(awareness: AwarenessLike): UseAwarenessResult {
	const store = useMemo(() => awarenessStore(awareness), [awareness]);
	const snapshot = useStoreValue(store);
	return {
		...snapshot,
		setLocalState: (state) => awareness.setLocalState(state),
		setLocalStateField: (field, value) => awareness.setLocalStateField(field, value),
	};
}

/**
 * 3.12 / F-491 — true when this entity's canonical document is missing content
 * permanently: an update it depends on never reached disk, so part of what was
 * written is gone and is NOT recoverable.
 *
 * Subscribes rather than reading once, because the load that discovers the
 * damage resolves AFTER the first render — a component that only read
 * `isDamaged` would paint the doc as ordinary-empty and never correct itself,
 * which is the exact failure this exists to end. Pass the resolver API from
 * the app's `getYDocResolverApi()`; `null` (no doc surface, e.g. the preview
 * harness) reports healthy rather than throwing.
 */
export function useYDocDamaged(api: YDocResolverApi | null, entityId: string): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (!api) return () => undefined;
			return api.subscribeDamaged((changed) => {
				if (changed === entityId) onChange();
			});
		},
		[api, entityId],
	);
	const getSnapshot = useCallback(() => api?.isDamaged(entityId) ?? false, [api, entityId]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
