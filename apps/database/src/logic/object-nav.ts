/**
 * Next / previous object (9.12.34). Opening an object from a view (Quick
 * Look, full open, or the inspector) starts a walk over that view's current
 * order; prev / next step it. The order is re-read live on every step, so a
 * sort / filter change or a deleted row never strands the cursor.
 */

/** How the walked object is being shown — stepping re-shows the neighbour
 *  the same way. */
export enum ObjectOpenMode {
	Inspector = "inspector",
	QuickLook = "quick-look",
	Open = "open",
}

export enum ObjectNavDirection {
	Previous = -1,
	Next = 1,
}

/** Shortcut ids for the walk, bound through the SDK shortcut layer. */
export const OBJECT_NAV_SHORTCUTS: Readonly<Record<ObjectNavDirection, string>> = {
	[ObjectNavDirection.Previous]: "Alt+ArrowUp",
	[ObjectNavDirection.Next]: "Alt+ArrowDown",
};

export type ObjectNavContext = { viewId: string; entityId: string; mode: ObjectOpenMode };

export type ObjectNavPosition = {
	index: number;
	total: number;
	hasPrev: boolean;
	hasNext: boolean;
};

export function objectNavPosition(
	context: ObjectNavContext,
	orderedIds: ReadonlyArray<string>,
): ObjectNavPosition | null {
	const index = orderedIds.indexOf(context.entityId);
	if (index < 0) return null;
	return {
		index,
		total: orderedIds.length,
		hasPrev: index > 0,
		hasNext: index < orderedIds.length - 1,
	};
}

/** The neighbour `direction` steps from the context's object, or `null` at
 *  either end (no wrap — the end of a list is a real place). */
export function stepObjectNav(
	context: ObjectNavContext,
	orderedIds: ReadonlyArray<string>,
	direction: ObjectNavDirection,
): ObjectNavContext | null {
	const index = orderedIds.indexOf(context.entityId);
	if (index < 0) return null;
	const nextId = orderedIds[index + direction];
	return nextId === undefined ? null : { ...context, entityId: nextId };
}
