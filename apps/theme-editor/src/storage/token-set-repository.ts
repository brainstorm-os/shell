/**
 * TokenSet/v1 entity load/save — the persistence half of the 9.9.2 token
 * grid. Routes through `services.entities`; the pure
 * `tokenSetToProperties` / `propertiesToTokenSet` mappers are extracted so
 * the round-trip + defensive decode are testable without a DOM.
 */

import {
	EMPTY_TOKEN_SET,
	type TokenSetAppearance,
	type TokenSetDef,
	isTokenSetAppearance,
	isValidTokenSet,
	resolveTokenOverrides,
} from "@brainstorm-os/sdk-types";
import type { EntitiesService, EntityRecord } from "./runtime";

const TOKEN_SET_TYPE = "brainstorm/TokenSet/v1";

export function tokenSetToProperties(def: TokenSetDef): Record<string, unknown> {
	return {
		name: def.name,
		appearance: def.appearance,
		overrides: { ...def.overrides },
	};
}

/**
 * Rebuild a `TokenSetDef` from an entity's `properties`, defensively —
 * a malformed bag degrades to the empty default per field, and the
 * overrides are run through `resolveTokenOverrides` so an unknown/blank
 * token never reaches the grid.
 */
export function propertiesToTokenSet(
	props: Record<string, unknown> | null | undefined,
): TokenSetDef {
	const p = props ?? {};
	const name =
		typeof p.name === "string" && p.name.trim().length > 0 ? p.name : EMPTY_TOKEN_SET.name;
	const appearance = isTokenSetAppearance(p.appearance)
		? (p.appearance as TokenSetAppearance)
		: EMPTY_TOKEN_SET.appearance;
	const overrides = resolveTokenOverrides({
		name,
		appearance,
		overrides: (p.overrides as Record<string, string>) ?? {},
	});
	return { name, appearance, overrides };
}

export type LoadedTokenSet = { id: string; def: TokenSetDef } | null;

export async function loadTokenSet(
	entities: EntitiesService | null | undefined,
	id: string,
): Promise<LoadedTokenSet> {
	if (!entities) return null;
	const record = await entities.get(id);
	return record ? { id: record.id, def: propertiesToTokenSet(record.properties) } : null;
}

/**
 * Persist a `TokenSetDef` — update when `id` exists, else create.
 * Validates structurally before writing. Returns the saved record, or
 * `null` outside the shell.
 */
export async function saveTokenSet(
	entities: EntitiesService | null | undefined,
	def: TokenSetDef,
	id?: string,
): Promise<EntityRecord | null> {
	if (!entities) return null;
	if (!isValidTokenSet(def))
		throw new Error("theme-editor: refusing to save an invalid TokenSet/v1");
	const props = tokenSetToProperties(def);
	if (id) {
		const existing = await entities.get(id);
		if (existing) return entities.update(id, props);
	}
	return entities.create(TOKEN_SET_TYPE, props, id);
}
