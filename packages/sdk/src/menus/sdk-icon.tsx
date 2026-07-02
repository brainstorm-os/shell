/**
 * Bridge an SDK `IconName` into a fancy-menus `IconParam` so menu rows can
 * paint from Brainstorm's full glyph set (and any installed `IconPack/v1`
 * override), not just the handful of glyphs that happen to map onto Phosphor
 * components. The row icon slot wants an `IconComponent`; we wrap the SDK's
 * React `<Icon>` so it renders the same glyph the rest of the app's chrome
 * uses.
 *
 * Memoised per name so the wrapper component identity is stable across menu
 * re-renders (a fresh component each render would remount the icon).
 */

import type { IconComponent, IconParam } from "@react-fancy-menus/core";
import { Icon, type IconName } from "../icon";

/** A no-op icon that reserves a row's leading icon column so labels stay
 *  aligned in a "pick one of N" list where only the selected row shows a
 *  check. Shared by the select / multi-select / anchored menus so none of
 *  them re-declares its own blank. */
export const blankMenuIcon: IconParam = { icon: () => null };

const CACHE = new Map<IconName, IconParam>();

export function sdkMenuIcon(name: IconName): IconParam {
	const cached = CACHE.get(name);
	if (cached) return cached;
	const Glyph: IconComponent = ({ size, className }) => (
		<Icon
			name={name}
			size={typeof size === "number" ? size : 16}
			{...(className ? { className } : {})}
		/>
	);
	const param: IconParam = { icon: Glyph };
	CACHE.set(name, param);
	return param;
}
