/**
 * StylePack/v1 entity load/save — the persistence half of the 9.9.4 raw-CSS
 * editor. Routes through `services.entities`; the pure
 * `stylePackToProperties` / `propertiesToStylePack` mappers are extracted so
 * the round-trip + defensive decode are testable without a DOM.
 *
 * `properties.css` holds the authoritative CSS the validators + composite
 * read; `properties.mime` is fixed to `text/css` so the code-editor's
 * `text/css` opener routes to the entity (the cross-app edit handoff).
 */

import {
	EMPTY_STYLE_PACK,
	STYLE_PACK_CSS_MIME,
	STYLE_PACK_TYPE_URL,
	type StylePackDef,
	isStylePackCssSafe,
	resolveStylePack,
} from "@brainstorm-os/sdk-types";
import type { EntitiesService, EntityRecord } from "./runtime";

export function stylePackToProperties(def: StylePackDef): Record<string, unknown> {
	return { name: def.name, css: def.css, mime: STYLE_PACK_CSS_MIME };
}

/**
 * Rebuild a `StylePackDef` from an entity's `properties`, defensively — a
 * malformed bag degrades to the empty default per field and the mime is
 * always normalized (`resolveStylePack`).
 */
export function propertiesToStylePack(
	props: Record<string, unknown> | null | undefined,
): StylePackDef {
	const p = props ?? {};
	const draft: Partial<StylePackDef> = { css: typeof p.css === "string" ? p.css : "" };
	if (typeof p.name === "string") draft.name = p.name;
	return resolveStylePack(draft);
}

export type LoadedStylePack = { id: string; def: StylePackDef } | null;

export async function loadStylePack(
	entities: EntitiesService | null | undefined,
	id: string,
): Promise<LoadedStylePack> {
	if (!entities) return null;
	const record = await entities.get(id);
	return record ? { id: record.id, def: propertiesToStylePack(record.properties) } : null;
}

/**
 * Persist a `StylePackDef` — update when `id` exists, else create. Refuses
 * to write CSS with an error-severity sanitizer finding (script / network /
 * exfil vector); the editor blocks Save with the findings before reaching
 * here, this is the defence-in-depth backstop. Returns the saved record, or
 * `null` outside the shell.
 */
export async function saveStylePack(
	entities: EntitiesService | null | undefined,
	def: StylePackDef,
	id?: string,
): Promise<EntityRecord | null> {
	if (!entities) return null;
	if (!isStylePackCssSafe(def.css))
		throw new Error("theme-editor: refusing to save a StylePack/v1 with unsafe CSS");
	const props = stylePackToProperties(def);
	if (id) {
		const existing = await entities.get(id);
		if (existing) return entities.update(id, props);
	}
	return entities.create(STYLE_PACK_TYPE_URL, props, id);
}

export { EMPTY_STYLE_PACK };
