/**
 * Pending entity-link queue (DND-6 — the "Link to note…" keyboard twin).
 *
 * The pointer flow drops an object into the OPEN note's editor; the keyboard
 * twin picks a TARGET note from a list, which may not be mounted yet. This
 * module is the hand-off seam: the picker queues the reference(s) under the
 * target note's id and opens the note; the editor's `PendingEntityLinkPlugin`
 * drains the queue once the note's Y.Doc has loaded and appends the same
 * `MentionNode` blocks the drop path would (one transaction, one undo step).
 *
 * Module-level on purpose (mirrors the imperative menu singletons): exactly
 * one Notes renderer, and the queue must survive the editor remount that the
 * `key={noteId}` note-switch performs. A listener registered for a note id
 * fires on every enqueue for that id, so a twin targeting the ALREADY-open
 * note inserts immediately instead of waiting for a remount.
 */

export type PendingEntityLink = {
	entityId: string;
	entityType: string;
	label: string;
};

const queues = new Map<string, PendingEntityLink[]>();
const listeners = new Map<string, Set<() => void>>();

/** Queue references to append into `noteId` and notify its listeners. */
export function queuePendingEntityLinks(noteId: string, items: readonly PendingEntityLink[]): void {
	if (items.length === 0) return;
	const queue = queues.get(noteId) ?? [];
	queue.push(...items);
	queues.set(noteId, queue);
	for (const listener of listeners.get(noteId) ?? []) listener();
}

/** Take (and clear) everything queued for `noteId`. */
export function drainPendingEntityLinks(noteId: string): PendingEntityLink[] {
	const queue = queues.get(noteId) ?? [];
	queues.delete(noteId);
	return queue;
}

/** Register a drain trigger for `noteId`; returns the unsubscribe. */
export function onPendingEntityLinks(noteId: string, listener: () => void): () => void {
	const set = listeners.get(noteId) ?? new Set();
	set.add(listener);
	listeners.set(noteId, set);
	return () => {
		set.delete(listener);
		if (set.size === 0) listeners.delete(noteId);
	};
}

/** Test-only: drop all queues + listeners. */
export function _resetPendingEntityLinksForTests(): void {
	queues.clear();
	listeners.clear();
}
