/**
 * PRES-2 (design [74](../../../../../docs/data/74-presence-transport.md)) —
 * the MAIN-side presence bridge.
 *
 * An app's presence `AwarenessLike` lives in the sandbox renderer (a light
 * state map — PRES-1). The `AwarenessBroadcaster` (10.6) speaks the real
 * `y-protocols` awareness protocol on the DEK-sealed relay. This manager sits
 * between them: per entity it owns a **proxy `y-protocols` Awareness** the
 * broadcaster tracks, and it ferries:
 *
 *   renderer publish ─setLocal(entity, state)─▶ proxy.local ─▶ broadcaster ─▶ relay
 *   relay ─▶ broadcaster.applyInbound ─▶ proxy remote states ─▶ onChange ─▶ renderer
 *
 * The renderer never touches `y-protocols`; the wire format stays here. The
 * `emit` is injectable (defaults to the broadcaster's relay `emitAwareness`) so
 * two managers can be wired over a loopback in-process — no relay/DEK stack.
 *
 * Presence is display-only: this manager grants nothing, persists nothing, and
 * every inbound state is untrusted (the render side hardens it via
 * `peerFromState`). The capability gate + the sandbox IPC route that drives
 * `setLocal`/`onChange` are PRES-2's broker slice; this is the relay half.
 */

import { Awareness } from "y-protocols/awareness";
import { Doc } from "yjs";
import { AwarenessBroadcaster } from "./awareness-broadcaster";
import type { PipelineContext } from "./envelope-pipeline";

/** One tracked entity's proxy awareness + its doc (clientID source). */
type Proxy = { doc: Doc; awareness: Awareness };

export type PresenceManagerOptions = {
	/** The live relay pipeline the broadcaster seals + sends awareness through. */
	pipeline: PipelineContext;
	/** Override the relay emit (tests / loopback). Defaults to the broadcaster's
	 *  `emitAwareness(entityId, update, pipeline)`. */
	emit?: (entityId: string, awarenessUpdate: Uint8Array) => Promise<void>;
};

export class PresenceManager {
	readonly #broadcaster: AwarenessBroadcaster;
	readonly #byEntity = new Map<string, Proxy>();
	#disposed = false;

	constructor(opts: PresenceManagerOptions) {
		this.#broadcaster = new AwarenessBroadcaster({
			pipeline: opts.pipeline,
			awarenessByEntity: () => {
				const map = new Map<string, Awareness>();
				for (const [id, p] of this.#byEntity) map.set(id, p.awareness);
				return map;
			},
			...(opts.emit ? { emit: opts.emit } : {}),
		});
	}

	#ensure(entityId: string): Proxy {
		let proxy = this.#byEntity.get(entityId);
		if (!proxy) {
			const doc = new Doc();
			const awareness = new Awareness(doc);
			proxy = { doc, awareness };
			this.#byEntity.set(entityId, proxy);
			this.#broadcaster.track(entityId, awareness);
		}
		return proxy;
	}

	/** Publish THIS device's presence state for `entityId` (from the renderer),
	 *  or `null` to clear it. Broadcast to peers over the relay (debounced). */
	setLocal(entityId: string, state: Record<string, unknown> | null): void {
		if (this.#disposed) return;
		this.#ensure(entityId).awareness.setLocalState(state);
	}

	/** Apply an inbound awareness update (a relay frame the LiveSyncEngine routed
	 *  here) into the entity's proxy — the origin marker stops a re-broadcast. */
	applyInbound(entityId: string, awarenessUpdate: Uint8Array): void {
		if (this.#disposed) return;
		this.#ensure(entityId);
		this.#broadcaster.applyInbound(awarenessUpdate, entityId);
	}

	/** The peer states for `entityId` (every tracked client EXCEPT our own proxy)
	 *  — what the IPC route pushes to the renderer for `awarenessToPeers`. */
	remoteStates(entityId: string): Map<number, Record<string, unknown>> {
		const proxy = this.#byEntity.get(entityId);
		const out = new Map<number, Record<string, unknown>>();
		if (!proxy) return out;
		for (const [clientId, state] of proxy.awareness.getStates()) {
			if (clientId !== proxy.doc.clientID) out.set(clientId, state as Record<string, unknown>);
		}
		return out;
	}

	/** Subscribe to peer changes for `entityId` (relay inbound / heartbeat GC) so
	 *  the IPC route can push a fresh peer set to the renderer. Returns unsubscribe. */
	onChange(entityId: string, handler: () => void): () => void {
		const proxy = this.#ensure(entityId);
		proxy.awareness.on("change", handler);
		return () => proxy.awareness.off("change", handler);
	}

	/** Stop tracking `entityId` (the app closed the surface) — broadcasts a final
	 *  null so peers drop us immediately. */
	untrack(entityId: string): void {
		const proxy = this.#byEntity.get(entityId);
		if (!proxy) return;
		this.#broadcaster.untrack(entityId);
		proxy.awareness.destroy();
		proxy.doc.destroy();
		this.#byEntity.delete(entityId);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#broadcaster.dispose();
		for (const proxy of this.#byEntity.values()) {
			proxy.awareness.destroy();
			proxy.doc.destroy();
		}
		this.#byEntity.clear();
	}
}
