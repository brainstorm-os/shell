/**
 * Pure icon-pack choice list for the picker — the built-in Phosphor pack
 * plus every installed `IconPack/v1` entity — and the resolver that maps
 * the theme's current `iconPack` reference back to the selected choice.
 */

import { BUILTIN_ICON_PACK, type ThemeComponentRef, ThemeRefKind } from "@brainstorm-os/sdk-types";

export const BUILTIN_CHOICE_KEY = "builtin";

export type InstalledPack = { id: string; name: string };

export type IconPackChoice = {
	key: string;
	/** The pack's name (the builtin uses the sentinel; the UI labels it). */
	name: string;
	ref: ThemeComponentRef;
	builtin: boolean;
};

export function iconPackChoices(installed: ReadonlyArray<InstalledPack>): IconPackChoice[] {
	const builtin: IconPackChoice = {
		key: BUILTIN_CHOICE_KEY,
		name: BUILTIN_ICON_PACK,
		ref: { kind: ThemeRefKind.Builtin, name: BUILTIN_ICON_PACK },
		builtin: true,
	};
	const rest = installed.map<IconPackChoice>((p) => ({
		key: p.id,
		name: p.name,
		ref: { kind: ThemeRefKind.Entity, entityId: p.id },
		builtin: false,
	}));
	return [builtin, ...rest];
}

/** The choice key matching the theme's current reference, or the builtin
 *  key when the ref is builtin / unresolved. */
export function selectedChoiceKey(
	choices: ReadonlyArray<IconPackChoice>,
	ref: ThemeComponentRef,
): string {
	if (ref.kind === ThemeRefKind.Entity) {
		const match = choices.find(
			(c) => !c.builtin && c.ref.kind === ThemeRefKind.Entity && c.ref.entityId === ref.entityId,
		);
		return match?.key ?? BUILTIN_CHOICE_KEY;
	}
	return BUILTIN_CHOICE_KEY;
}
