import { useSyncExternalStore } from "react";
import {
	type FirstMediaCache,
	type FirstMediaTransport,
	createFirstMediaCache,
} from "../logic/first-media-cache";
import type { EntityRow } from "../logic/in-memory-entities";

let cache: FirstMediaCache = createFirstMediaCache(null);

/** Point the first-media covers at the host's body-doc transport (once, at
 *  boot). Without it every lookup answers "no image". */
export function installFirstMediaTransport(transport: FirstMediaTransport | null): void {
	cache = createFirstMediaCache(transport);
}

const noopSubscribe = (): (() => void) => () => {};

/** The entity's first body image URL for a "first media" cover — `null`
 *  while unresolved or when the body has none. `enabled: false` skips the
 *  load entirely (any other cover mode). */
export function useFirstMedia(entity: EntityRow, enabled: boolean): string | null {
	const current = cache;
	return useSyncExternalStore(enabled ? current.subscribe : noopSubscribe, () =>
		enabled ? (current.read(entity.id, entity.updatedAt) ?? null) : null,
	);
}
