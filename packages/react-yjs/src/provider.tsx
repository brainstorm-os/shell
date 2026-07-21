/**
 * `entityId → Y.Doc` resolution boundary.
 *
 * `useYDoc(entityId)` needs a way to turn an entity id into the renderer's
 * replica of that entity's canonical Y.Doc. That replica is owned by the
 * SDK's entities service, which lands at Stage 9.3 (Block Protocol +
 * entities service). Rather than block 9.1 on 9.3, the resolver is
 * injected through context: the SDK provides a real `<YDocProvider>` at
 * 9.3; until then `useYDoc(doc)` (passing a Y.Doc directly) is fully
 * functional and is what `@brainstorm-os/editor` previews (9.2) use.
 *
 * The resolver is synchronous and refcounted: `resolve(entityId)` returns
 * a handle whose `release()` the hook calls on unmount so the entities
 * service can drop idle replicas.
 */

import { type ReactNode, createContext, createElement, useContext } from "react";
import type * as Y from "yjs";

export type YDocHandle = {
	doc: Y.Doc;
	/** Resolves once the canonical snapshot has been applied (or there
	 *  was none). Consumers that bootstrap content into the doc — e.g. an
	 *  editor's "first-attach seeder" — MUST gate their write on this:
	 *  the resolver returns the doc immediately and hydrates async, so a
	 *  sync-on-mount seeder otherwise writes into an empty replica and
	 *  the CRDT merge with the late-arriving snapshot keeps both inserts
	 *  → duplicated content. Optional: a synchronous source (test fake,
	 *  pre-loaded doc) leaves this undefined and the consumer treats it
	 *  as already-resolved.
	 *
	 *  Note: `loaded` only resolves once SOMEONE has triggered the apply
	 *  via `applyPending()` (or the resolver-level `whenLoaded()` shortcut).
	 *  Editors should prefer calling `applyPending()` from inside their
	 *  binding's connect path so the snapshot lands AFTER the binding's
	 *  `observeDeep` is registered — otherwise the Yjs update events fire
	 *  into a void and the editor renders blank. */
	loaded?: Promise<void>;
	/** Trigger the snapshot apply. Idempotent (same promise returned on
	 *  subsequent calls). The editor's LocalProvider calls this inside
	 *  `connect()` — at that point `@lexical/yjs`'s `observeDeep` is
	 *  already registered, so the apply's Yjs events reach the binding. */
	applyPending?(): Promise<void>;
	/** Called when the last consumer unmounts; lets the owner free the
	 *  replica. Must be idempotent. */
	release(): void;
};

export type YDocResolver = (entityId: string) => YDocHandle;

const YDocResolverContext = createContext<YDocResolver | null>(null);

export function YDocProvider(props: {
	resolver: YDocResolver;
	children: ReactNode;
}): ReactNode {
	return createElement(YDocResolverContext.Provider, { value: props.resolver }, props.children);
}

export function useOptionalYDocResolver(): YDocResolver | null {
	return useContext(YDocResolverContext);
}
