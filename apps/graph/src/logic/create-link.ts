/**
 * Drag-to-create-link logic (9.13.11) — the pure half of the canvas
 * gesture per §Interaction
 * ("Drag from a node's edge handle to another node → Create a typed link.
 * Picks the link type from a fancy-menus popover.").
 *
 * The "edge handle" is the node's rim: a press that lands inside the pick
 * slop but *outside* the painted disc starts a link drag instead of a move
 * drag; Alt/Option-drag from anywhere on the node does the same (the
 * accessible, zoom-independent path). The created link is a first-class
 * **PropertyReference**: picking a type writes the target's id into an
 * `entityRef` property on the source via `entities.update`, and the
 * shell's catalog-driven ref derivation projects the edge — the same
 * channel every other property-made link uses (no parallel link store).
 *
 * Pure + DOM-free: drag-kind classification, applicable-def filtering, and
 * the next-value computation live here so the controller's pointer wiring
 * stays a thin shell.
 */

import {
	type Cardinality,
	type LabeledValue,
	type PropertyDef,
	ValueType,
	isMultiValued,
} from "@brainstorm-os/sdk-types";

/** What a pointer-down on a node means for the gesture that follows. */
export enum NodeDragKind {
	Move = "move",
	Link = "link",
}

/** Classify a node press: rim (outside the painted disc but inside the
 *  pick slop) or Alt/Option starts a link drag; the disc body moves the
 *  node. `distPx` / `radiusPx` are client-space (already zoom-scaled). */
export function detectDragKind(input: {
	distPx: number;
	radiusPx: number;
	altKey: boolean;
}): NodeDragKind {
	if (input.altKey) return NodeDragKind.Link;
	if (input.distPx > input.radiusPx) return NodeDragKind.Link;
	return NodeDragKind.Move;
}

/** The vault-catalog defs that can type a link to `targetType`: `entityRef`
 *  defs whose `allowedTypes` is absent/empty (any target) or contains the
 *  type. Sorted by name for a stable menu. */
export function applicableLinkDefs(
	defs: ReadonlyArray<PropertyDef>,
	targetType: string,
): PropertyDef[] {
	return defs
		.filter((def) => {
			if (def.valueType !== ValueType.EntityRef) return false;
			const allowed = def.allowedTypes;
			if (!allowed || allowed.length === 0) return true;
			return allowed.includes(targetType);
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Compute the patch value that adds `targetId` to `def` on top of
 *  `currentValue`. Scalar defs overwrite; multi-valued defs append (deduped,
 *  capped at `count.max`). Returns null when the write would be a no-op
 *  (already linked / multi value at capacity). */
export function nextRefValue(
	def: PropertyDef,
	currentValue: unknown,
	targetId: string,
): string | LabeledValue<string>[] | null {
	if (!isMultiValued(def.count)) {
		return currentValue === targetId ? null : targetId;
	}
	const existing: LabeledValue<string>[] = Array.isArray(currentValue)
		? currentValue.filter(
				(v): v is LabeledValue<string> =>
					typeof v === "object" && v !== null && typeof (v as { value?: unknown }).value === "string",
			)
		: typeof currentValue === "string" && currentValue.length > 0
			? [{ value: currentValue }]
			: [];
	if (existing.some((v) => v.value === targetId)) return null;
	const max = (def.count as Cardinality).max;
	if (existing.length >= max) return null;
	return [...existing, { value: targetId }];
}

/** The generic fallback def offered when the catalog has no `entityRef`
 *  def for the target type — ensured idempotently (mirrors Tasks'
 *  assignee-def ensure) so the shell's ref derivation can project the
 *  edge. Multi-valued: "related to" is naturally many-to-many. */
export const RELATED_TO_DEF: PropertyDef = {
	key: "related",
	name: "Related to",
	icon: null,
	valueType: ValueType.EntityRef,
	count: { min: 0, max: 50 },
};
