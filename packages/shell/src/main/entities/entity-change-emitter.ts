/**
 * Post-commit entity-change fan-out (11b.6 deploy residue (b)).
 *
 * The entities service invokes `emit` AFTER a create/update/delete has
 * passed its per-type capability gate and committed; subscribers (today:
 * the `AutomationsHost`'s `EntityEvent` triggers) react to `{verb,
 * entityId, type}` — deliberately no property data, so a subscriber that
 * wants the entity body must fetch it through its own capability-checked
 * path.
 *
 * SECURITY INVARIANTS (this is the seam into a security-critical core
 * file, keep it boring):
 *   - the emitter is fire-and-forget: a throwing listener is isolated and
 *     reported, and can NEVER fail or delay the data path that emitted;
 *   - no emission happens for denied / failed operations (the service
 *     emits only after the authorized write committed);
 *   - the payload carries identifiers only, never property values.
 */

import type { EntityEventVerb } from "@brainstorm-os/sdk-types";

export type EntityChange = {
	verb: EntityEventVerb;
	entityId: string;
	type: string;
};

export type EntityChangeListener = (change: EntityChange) => void;

export class EntityChangeEmitter {
	private readonly listeners = new Set<EntityChangeListener>();

	constructor(private readonly onListenerError?: (error: unknown) => void) {}

	subscribe(listener: EntityChangeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Deliver to every listener; a throw is contained per listener. */
	emit(change: EntityChange): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(change);
			} catch (error) {
				if (this.onListenerError) this.onListenerError(error);
				else console.error("[entities] change listener failed:", error);
			}
		}
	}
}
