/**
 * Typography/v1 entity load/save for the 9.9.3 typography editor. Routes
 * through `services.entities`; the pure `typographyToProperties` /
 * `propertiesToTypography` mappers (defensive decode via the contract's
 * `resolveFontStack`) are testable without a DOM.
 */

import {
	FONT_ROLES,
	type FontStack,
	SYSTEM_TYPOGRAPHY,
	type TypographyDef,
	isTypographyScale,
	isValidTypography,
	resolveFontStack,
} from "@brainstorm-os/sdk-types";
import type { EntitiesService, EntityRecord } from "./runtime";

const TYPOGRAPHY_TYPE = "brainstorm/Typography/v1";

export function typographyToProperties(def: TypographyDef): Record<string, unknown> {
	return {
		name: def.name,
		scale: def.scale,
		fonts: Object.fromEntries(FONT_ROLES.map((role) => [role, { stack: def.fonts[role].stack }])),
	};
}

/** Rebuild a `TypographyDef` defensively — every role resolves through
 *  `resolveFontStack` (never empty), the scale degrades to the system
 *  scale, and a blank name falls back to the system name. */
export function propertiesToTypography(
	props: Record<string, unknown> | null | undefined,
): TypographyDef {
	const p = props ?? {};
	const name =
		typeof p.name === "string" && p.name.trim().length > 0 ? p.name : SYSTEM_TYPOGRAPHY.name;
	const scale = isTypographyScale(p.scale) ? p.scale : SYSTEM_TYPOGRAPHY.scale;
	const raw = p.fonts as TypographyDef["fonts"] | undefined;
	const fonts = Object.fromEntries(
		FONT_ROLES.map((role) => [
			role,
			{ stack: resolveFontStack(raw ? { name, scale, fonts: raw } : null, role) },
		]),
	) as Record<(typeof FONT_ROLES)[number], FontStack>;
	return { name, scale, fonts };
}

export type LoadedTypography = { id: string; def: TypographyDef } | null;

export async function loadTypography(
	entities: EntitiesService | null | undefined,
	id: string,
): Promise<LoadedTypography> {
	if (!entities) return null;
	const record = await entities.get(id);
	return record ? { id: record.id, def: propertiesToTypography(record.properties) } : null;
}

export async function saveTypography(
	entities: EntitiesService | null | undefined,
	def: TypographyDef,
	id?: string,
): Promise<EntityRecord | null> {
	if (!entities) return null;
	if (!isValidTypography(def))
		throw new Error("theme-editor: refusing to save an invalid Typography/v1");
	const props = typographyToProperties(def);
	if (id) {
		const existing = await entities.get(id);
		if (existing) return entities.update(id, props);
	}
	return entities.create(TYPOGRAPHY_TYPE, props, id);
}
