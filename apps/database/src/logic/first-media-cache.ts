/**
 * First-media cover cache (9.12.31). A gallery set to "first media" needs each
 * card's first body image without mounting an editor: the body Y.Doc is
 * loaded over the `entities.loadDoc` transport, walked once
 * (`firstBodyMediaFromUpdate`), released (`closeDoc`), and the answer cached
 * per entity + `updatedAt` — an edit invalidates it, a re-render never
 * reloads. Loads run a few at a time so a large gallery can't flood the ydoc
 * worker. Only a local `brainstorm:` image becomes a cover; videos and
 * embeds have no local still, so they yield none.
 */

import { type BodyMedia, BodyMediaKind, firstBodyMediaFromUpdate } from "@brainstorm-os/react-yjs";

export type FirstMediaTransport = {
	loadDoc(id: string): Promise<{ snapshotB64: string }>;
	closeDoc(id: string): Promise<void>;
};

const MAX_IN_FLIGHT = 3;
const MAX_ENTRIES = 2000;

export type FirstMediaCache = {
	/** The cached cover URL (`null` = no image), or `undefined` while it has
	 *  not resolved yet — the read also queues the load. */
	read(entityId: string, updatedAt: number): string | null | undefined;
	subscribe(listener: () => void): () => void;
};

export function createFirstMediaCache(
	transport: FirstMediaTransport | null,
	decode: (updateB64: string) => BodyMedia | null = firstBodyMediaFromUpdate,
): FirstMediaCache {
	const results = new Map<string, string | null>();
	const queued: Array<{ key: string; entityId: string }> = [];
	const pending = new Set<string>();
	const listeners = new Set<() => void>();
	let inFlight = 0;

	const keyOf = (entityId: string, updatedAt: number): string => `${entityId}@${updatedAt}`;

	const settle = (key: string, value: string | null): void => {
		pending.delete(key);
		results.set(key, value);
		if (results.size > MAX_ENTRIES) {
			const oldest = results.keys().next().value;
			if (oldest !== undefined) results.delete(oldest);
		}
		for (const l of listeners) l();
	};

	const pump = (): void => {
		if (!transport) return;
		while (inFlight < MAX_IN_FLIGHT && queued.length > 0) {
			const job = queued.shift();
			if (!job) break;
			inFlight += 1;
			transport
				.loadDoc(job.entityId)
				.then(({ snapshotB64 }) => {
					const media = decode(snapshotB64);
					settle(job.key, media?.kind === BodyMediaKind.Image ? media.url : null);
				})
				.catch(() => settle(job.key, null))
				.finally(() => {
					void transport.closeDoc(job.entityId).catch(() => {});
					inFlight -= 1;
					pump();
				});
		}
	};

	return {
		read(entityId, updatedAt) {
			const key = keyOf(entityId, updatedAt);
			if (results.has(key)) return results.get(key) ?? null;
			if (!transport) return null;
			if (!pending.has(key)) {
				pending.add(key);
				queued.push({ key, entityId });
				pump();
			}
			return undefined;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
