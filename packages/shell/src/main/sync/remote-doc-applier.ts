/**
 * The `applyRemoteUpdate` half of the live-sync wiring: land a decrypted remote
 * Yjs update in the canonical doc, then tell the rest of the shell that an
 * entity changed.
 *
 * The second half is the reason this is its own unit. A remote update is
 * applied OFF the broker (it must not re-enter the capability-gated
 * `entities.applyDoc` verb, or it would be re-emitted), and the write broadcast
 * that repaints every app's live entity list hangs off the broker wrapper. So a
 * synced row landed in `entities.db` and nothing was told: a teammate's message
 * sat invisible in an open channel until the receiver's own next write happened
 * to refresh the list. Any write that bypasses the broker owes the same signal
 * (the welcome seed and the agent mention runner already pay it).
 */

export type RemoteDocApplierDeps = {
	/** Apply + persist + project into the row. Null while the entities service
	 *  has not bound its remote-apply closure yet. */
	readonly apply: () => ((entityId: string, updateB64: string) => Promise<void>) | null;
	/** The update is in the row: repaint live lists, re-index search. Contained -
	 *  a listener failure never fails the apply. */
	readonly onApplied: (entityId: string) => void;
	/** Attribute the write to its authenticated sender (version history). */
	readonly noteSender?: (entityId: string, senderB64Url: string) => void;
};

export function makeRemoteDocApplier(
	deps: RemoteDocApplierDeps,
): (entityId: string, type: string, update: Uint8Array, senderB64Url?: string) => Promise<void> {
	return async (entityId, _type, update, senderB64Url) => {
		const apply = deps.apply();
		if (!apply) return;
		await apply(entityId, Buffer.from(update).toString("base64"));
		if (senderB64Url) deps.noteSender?.(entityId, senderB64Url);
		try {
			deps.onApplied(entityId);
		} catch (error) {
			console.warn(`[live-sync] post-apply signal failed for ${entityId}:`, error);
		}
	};
}
