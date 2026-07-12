/**
 * PRES-2b — per-session lifecycle for the {@link PresenceRouter} (mirrors
 * `live-sync-wiring`). The router bridges the sandbox presence IPC surface to
 * the always-on {@link LiveSyncEngine}'s awareness path:
 *
 *   outbound  app.publish → router → manager → engine.emitLocalAwareness → relay
 *   inbound   relay → engine.applyRemoteAwareness → router.applyInbound → app push
 *
 * Both directions reach the CURRENT session's objects through module getters
 * (`getLiveSyncEngine` / `getPresenceRouter`), so the engine and router can
 * reference each other without a construction-order cycle — the engine is built
 * first (its `applyRemoteAwareness` hook reads `getPresenceRouter()`), then the
 * router (whose emit reads `getLiveSyncEngine()`). Rebuilt on session activation,
 * disposed on deactivation.
 */

import type { AppWindow } from "../apps/launcher";
import type { PipelineContext } from "./envelope-pipeline";
import { getLiveSyncEngine } from "./live-sync-wiring";
import { PresenceManager } from "./presence-manager";
import { PresenceRouter } from "./presence-router";

let current: PresenceRouter | null = null;

export type PresenceWiringOptions = {
	readonly getAppWindows: () => readonly AppWindow[];
};

/** Dispose any prior router and build a fresh one for the now-active session. */
export function installPresenceRouter(opts: PresenceWiringOptions): PresenceRouter {
	disposePresenceRouter();
	const manager = new PresenceManager({
		// Outbound awareness rides the engine's relay path (port-swap + DEK aware,
		// tracked-shared-entities only), so the broadcaster's own pipeline emit is
		// never used — the injected `emit` overrides it. `pipeline` is required by
		// the type but inert here (see AwarenessBroadcaster: `#pipeline` is read
		// only by the default emit).
		pipeline: {} as PipelineContext,
		emit: async (entityId, update) => {
			await getLiveSyncEngine()?.emitLocalAwareness(entityId, update);
		},
	});
	current = new PresenceRouter({ manager, getAppWindows: opts.getAppWindows });
	return current;
}

/** The router for the active session, or null when no vault is open. */
export function getPresenceRouter(): PresenceRouter | null {
	return current;
}

export function disposePresenceRouter(): void {
	if (!current) return;
	current.dispose();
	current = null;
}
