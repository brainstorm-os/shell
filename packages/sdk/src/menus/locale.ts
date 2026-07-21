/**
 * Canonical English strings for the fancy-menus chrome (filter placeholder,
 * empty / loading states, footer buttons). Follows the SDK i18n convention
 * ([[project_sdk_shared_properties_panel]] / `@brainstorm-os/sdk/i18n`): the
 * English source lives here once; a localised host passes a
 * `Partial<MenuLocale>` of just the keys it translates, merged over these.
 *
 * `LocaleStrings` from the package keys on the same names the runtime reads,
 * so this is a structural match — no adapter mapping needed.
 */

import type { LocaleStrings } from "@react-fancy-menus/core";

export type MenuLocale = Required<
	Pick<
		LocaleStrings,
		"search" | "empty" | "loading" | "add" | "done" | "cancel" | "back" | "close" | "noResults"
	>
>;

export const DEFAULT_MENU_LOCALE: MenuLocale = {
	search: "Search…",
	empty: "Nothing here",
	loading: "Loading…",
	add: "Add",
	done: "Done",
	cancel: "Cancel",
	back: "Back",
	close: "Close",
	noResults: "No results",
};

/** Merge a host's partial translations over the English defaults. */
export function resolveMenuLocale(overrides?: Partial<MenuLocale>): MenuLocale {
	return overrides ? { ...DEFAULT_MENU_LOCALE, ...overrides } : DEFAULT_MENU_LOCALE;
}
