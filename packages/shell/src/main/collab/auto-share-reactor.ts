/**
 * Auto-share reactor (Collab-C5 — collection sharing flow 2, design 71).
 *
 * A per-session listener on the entities-service create chokepoint: when a child
 * entity (a chat Message, a Task) is created locally under an already-SHARED
 * container (its channel / project), cascade the container's membership onto the
 * new child so it syncs to every member — the mechanism that makes a team's
 * GROWING message/task stream follow a one-time channel share.
 *
 * Only LOCAL creates reach here (`entities.create`); a child arriving via sync
 * applies through `LiveSyncEngine.applyRemoteUpdate`, which bypasses the create
 * verb — so receiving a cascaded child never re-triggers a cascade (no fan-out
 * storm). The reactor is fire-and-forget and FULLY self-contains its errors: the
 * change emitter only catches synchronous throws, so an async cascade failure
 * must never escape (it would otherwise be an unhandled rejection on a
 * security-critical path). A cascade that can't reach a member now (offline, or
 * the member's wrapping key not yet replicated) is the engine's deferred
 * re-cascade concern, not a hard failure here.
 */

import { EntityEventVerb } from "@brainstorm/sdk-types";
import type { EntityChange, EntityChangeEmitter } from "../entities/entity-change-emitter";
import { containmentRuleForChild } from "./containment-registry";
import type { SharingEngine } from "./sharing-engine";

export type AutoShareReactorDeps = {
	/** The per-session sharing engine, or null when no vault is open. */
	readonly getEngine: () => SharingEngine | null;
	/** Read a committed entity's properties (to find its container id), or null
	 *  when the row is absent. Capability-free internal read — the create already
	 *  passed its gate. */
	readonly readEntityProperties: (entityId: string) => Promise<Record<string, unknown> | null>;
	readonly onError?: (error: unknown) => void;
};

/**
 * Handle one create: if the created type is a collection child and it names a
 * container, ask the engine to cascade. The engine no-ops when the container is
 * solo (unshared), so this need not pre-check sharedness. Pure but for the
 * injected deps — directly unit-testable.
 */
export async function reactToEntityCreate(
	change: EntityChange,
	deps: AutoShareReactorDeps,
): Promise<void> {
	const rule = containmentRuleForChild(change.type);
	if (!rule) return;
	const props = await deps.readEntityProperties(change.entityId);
	const parentId = props?.[rule.childParentProp];
	if (typeof parentId !== "string" || parentId === "") return;
	const engine = deps.getEngine();
	if (!engine) return;
	await engine.autoShareNewChild(change.entityId, change.type, parentId);
}

/**
 * Subscribe the reactor to `emitter`. Returns the unsubscribe disposer. Each
 * `Create` is dispatched to {@link reactToEntityCreate}; any async failure is
 * routed to `onError` (default: a warn) so it can never escape as an unhandled
 * rejection or stall the change emitter.
 */
export function createAutoShareReactor(
	emitter: EntityChangeEmitter,
	deps: AutoShareReactorDeps,
): () => void {
	return emitter.subscribe((change: EntityChange) => {
		if (change.verb !== EntityEventVerb.Create) return;
		void reactToEntityCreate(change, deps).catch((error) => {
			if (deps.onError) deps.onError(error);
			else
				console.warn(`[auto-share] cascade failed for ${change.entityId}: ${(error as Error).message}`);
		});
	});
}
