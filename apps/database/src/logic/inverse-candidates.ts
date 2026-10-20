/**
 * Which existing relations a new Relation may pair with (two-way, 9.12.25).
 *
 * A pair records `inverseOf` on ONE side only (the "New" flow stamps it on
 * the partner, "Existing" on the new def), so filtering out defs that carry
 * their own `inverseOf` is not enough: the unmarked side of X↔Y would stay
 * pickable, and pairing a new Z with Y leaves Y bound twice — the shell's
 * pair resolver then drops BOTH pairs and X↔Y stops syncing silently. A def
 * is paired when it points at a partner OR some other def points at it.
 */

import { ValueType } from "@brainstorm-os/sdk-types";

export type InverseCandidateDef = {
	key: string;
	valueType: string;
	inverseOf?: string | null | undefined;
};

export function pairableInverseCandidates<D extends InverseCandidateDef>(defs: readonly D[]): D[] {
	const pointedAt = new Set<string>();
	for (const d of defs) if (d.inverseOf) pointedAt.add(d.inverseOf);
	return defs.filter(
		(d) => d.valueType === ValueType.EntityRef && !d.inverseOf && !pointedAt.has(d.key),
	);
}
