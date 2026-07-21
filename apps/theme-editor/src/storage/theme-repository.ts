/**
 * Theme/v1 entity load/save — the minimal end-to-end persistence path
 * for the 9.9.1 scaffold (the grid/picker editors land in 9.9.2+).
 * Routes everything through `services.entities` (never storage SQL); the
 * pure `themeToProperties` / `propertiesToTheme` mappers are extracted so
 * the round-trip is testable without a DOM or a live shell.
 */

import {
	DEFAULT_THEME_COMPOSITE,
	type ThemeComponentRef,
	type ThemeDef,
	type TokenSetAppearance,
	isTokenSetAppearance,
	isValidTheme,
	resolveThemeRef,
} from "@brainstorm-os/sdk-types";
import type { VaultEntity } from "@brainstorm-os/sdk-types";
import type { EntitiesService, EntityRecord } from "./runtime";

const THEME_TYPE = "brainstorm/Theme/v1";

/** Project the saved `Theme/v1` entities out of a whole-vault snapshot —
 *  the pure derivation the live theme-selector list runs on (the snapshot
 *  itself flows through `@brainstorm-os/react-yjs` `useVaultEntities`). A blank
 *  name falls back to the entity id. */
export function themesFromSnapshot(entities: ReadonlyArray<VaultEntity>): SavedTheme[] {
	return entities
		.filter((e) => e.type === THEME_TYPE && e.deletedAt === null)
		.map((e) => ({
			id: e.id,
			name:
				typeof e.properties.name === "string" && e.properties.name.trim().length > 0
					? e.properties.name
					: e.id,
		}));
}

/** Map a `ThemeDef` to the entity `properties` bag. */
export function themeToProperties(def: ThemeDef): Record<string, unknown> {
	const props: Record<string, unknown> = {
		name: def.name,
		appearance: def.appearance,
		tokenSet: def.tokenSet,
		iconPack: def.iconPack,
		typography: def.typography,
	};
	if (def.stylePack !== undefined) props.stylePack = def.stylePack;
	return props;
}

/**
 * Rebuild a `ThemeDef` from an entity's `properties`, defensively — a
 * malformed/partial bag degrades to the default composite per field so a
 * loaded theme is never half-broken. The optional `stylePack` is carried
 * only when it's a structurally valid reference.
 */
export function propertiesToTheme(props: Record<string, unknown> | null | undefined): ThemeDef {
	const p = props ?? {};
	const name =
		typeof p.name === "string" && p.name.trim().length > 0 ? p.name : DEFAULT_THEME_COMPOSITE.name;
	const appearance = isTokenSetAppearance(p.appearance)
		? (p.appearance as TokenSetAppearance)
		: DEFAULT_THEME_COMPOSITE.appearance;
	const theme: ThemeDef = {
		name,
		appearance,
		tokenSet: resolveThemeRef(p.tokenSet as ThemeComponentRef | undefined, "shell/default-light"),
		iconPack: resolveThemeRef(p.iconPack as ThemeComponentRef | undefined, "phosphor"),
		typography: resolveThemeRef(p.typography as ThemeComponentRef | undefined, "system"),
	};
	if (p.stylePack !== undefined) {
		theme.stylePack = resolveThemeRef(
			p.stylePack as ThemeComponentRef | undefined,
			"shell/default-style",
		);
	}
	return theme;
}

export type SavedTheme = { id: string; name: string };

/** Every saved `Theme/v1` entity as `{id, name}`, for the editor's theme
 *  selector. A blank name falls back to the entity id. */
export async function listThemes(
	entities: EntitiesService | null | undefined,
): Promise<SavedTheme[]> {
	if (!entities) return [];
	const records = await entities.query({ type: THEME_TYPE });
	return records.map((r) => ({
		id: r.id,
		name:
			typeof r.properties.name === "string" && r.properties.name.trim().length > 0
				? r.properties.name
				: r.id,
	}));
}

export type LoadedTheme = { id: string; def: ThemeDef } | null;

/**
 * Load the Theme with `id` when given, else the first Theme in the vault.
 * Returns `null` when there is no entities service (preview-drop) or no
 * stored theme — the caller then seeds `DEFAULT_THEME_COMPOSITE`.
 */
export async function loadTheme(
	entities: EntitiesService | null | undefined,
	id?: string,
): Promise<LoadedTheme> {
	if (!entities) return null;
	if (id) {
		const record = await entities.get(id);
		return record ? { id: record.id, def: propertiesToTheme(record.properties) } : null;
	}
	const all = await entities.query({ type: THEME_TYPE });
	const first = all[0];
	return first ? { id: first.id, def: propertiesToTheme(first.properties) } : null;
}

/**
 * Persist a `ThemeDef` — update when `id` is supplied and the entity
 * exists, else create. Validates structurally before writing (a Theme
 * with a broken reference never reaches the vault). Returns the saved
 * record, or `null` outside the shell.
 */
export async function saveTheme(
	entities: EntitiesService | null | undefined,
	def: ThemeDef,
	id?: string,
): Promise<EntityRecord | null> {
	if (!entities) return null;
	if (!isValidTheme(def))
		throw new Error("theme-editor: refusing to save a structurally invalid Theme/v1");
	const props = themeToProperties(def);
	if (id) {
		const existing = await entities.get(id);
		if (existing) return entities.update(id, props);
	}
	return entities.create(THEME_TYPE, props, id);
}
