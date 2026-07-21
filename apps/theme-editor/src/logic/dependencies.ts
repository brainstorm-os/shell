/**
 * Theme dependency resolution (9.9.5). A composite `Theme/v1` references
 * its components by id; an entity-kind reference whose entity isn't in the
 * vault is a **missing dependency** (doc 40 §Install protocol — a
 * composite referencing an uninstalled component prompts the user). The
 * editor surfaces these and offers to reset the slot to its builtin
 * default (the editor authors; the shell install flow is what fetches
 * component bytes — out of the editor's scope).
 *
 * Pure: the slot enumeration + missing-set computation + per-slot builtin
 * fallback are tested without a vault.
 */

import {
	BUILTIN_ICON_PACK,
	BUILTIN_TOKEN_SET,
	BUILTIN_TYPOGRAPHY,
	type ThemeComponentRef,
	type ThemeDef,
	ThemeRefKind,
} from "@brainstorm-os/sdk-types";

export enum ThemeSlot {
	TokenSet = "tokenSet",
	IconPack = "iconPack",
	Typography = "typography",
	StylePack = "stylePack",
}

export type ThemeDependency = { slot: ThemeSlot; entityId: string };

/** Every entity-kind component reference in the theme (builtins need no
 *  install, so they're not dependencies). */
export function themeEntityDependencies(theme: ThemeDef): ThemeDependency[] {
	const slots: Array<[ThemeSlot, ThemeComponentRef | undefined]> = [
		[ThemeSlot.TokenSet, theme.tokenSet],
		[ThemeSlot.IconPack, theme.iconPack],
		[ThemeSlot.Typography, theme.typography],
		[ThemeSlot.StylePack, theme.stylePack],
	];
	const out: ThemeDependency[] = [];
	for (const [slot, ref] of slots) {
		if (ref && ref.kind === ThemeRefKind.Entity) out.push({ slot, entityId: ref.entityId });
	}
	return out;
}

/** The dependencies whose entity isn't present in the vault. */
export function missingDependencies(
	deps: ReadonlyArray<ThemeDependency>,
	presentIds: ReadonlySet<string>,
): ThemeDependency[] {
	return deps.filter((d) => !presentIds.has(d.entityId));
}

/** The builtin reference a slot resets to — or `null` for the optional
 *  StylePack slot, whose reset removes the reference entirely. */
export function builtinFallbackRef(slot: ThemeSlot): ThemeComponentRef | null {
	switch (slot) {
		case ThemeSlot.TokenSet:
			return { kind: ThemeRefKind.Builtin, name: BUILTIN_TOKEN_SET };
		case ThemeSlot.IconPack:
			return { kind: ThemeRefKind.Builtin, name: BUILTIN_ICON_PACK };
		case ThemeSlot.Typography:
			return { kind: ThemeRefKind.Builtin, name: BUILTIN_TYPOGRAPHY };
		case ThemeSlot.StylePack:
			return null;
	}
}
