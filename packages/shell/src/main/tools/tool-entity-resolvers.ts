/**
 * The two questions `tools.call` asks the entity store, answered from the
 * store and never from the caller (Tool-4 / Tool-8, doc 78):
 *
 *   - **what type is this object, really?** — an `entityRef` argument's
 *     `allowedTypes` is checked against this, so a caller cannot hand a tool
 *     the id of an object whose type it was never granted;
 *   - **is it read-only?** — a tool that writes or proposes a write is refused
 *     before the provider sees the id.
 *
 * Lifted out of `main/index.ts` so the in-process pipeline test runs the SAME
 * closures production does (Tool-10): a hand-copied resolver in a test proves
 * the copy.
 */

import { isLockedProperties } from "@brainstorm-os/sdk/entity-lock";

/** The slice of `EntitiesRepository` these resolvers read. */
export type ToolEntityReader = {
	get(id: string): { type: string; properties?: unknown } | null | undefined;
};

export type ToolEntityResolvers = {
	resolveEntityType: (entityId: string) => Promise<string | null>;
	resolveEntityLocked: (entityId: string) => Promise<boolean>;
};

export function makeToolEntityResolvers(
	getRepo: () => Promise<ToolEntityReader | null>,
): ToolEntityResolvers {
	return {
		resolveEntityType: async (entityId) => {
			const repo = await getRepo();
			return repo?.get(entityId)?.type ?? null;
		},
		// Fails CLOSED: no store, or no such row, reads as locked. "We could not
		// tell" and "it is editable" are not the same answer.
		resolveEntityLocked: async (entityId) => {
			const repo = await getRepo();
			const row = repo?.get(entityId);
			if (!row) return true;
			return isLockedProperties(row.properties as Record<string, unknown> | undefined);
		},
	};
}
