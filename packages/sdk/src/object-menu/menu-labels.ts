/**
 * Object-menu **chrome** strings — the renderer-only labels layered on top
 * of the headless `ObjectMenuLabels` (open / pin / unpin / remove, which
 * label the *items*). These label the *shell* around them: the menu's
 * `aria-label` region and the visible ⋯ overflow trigger.
 *
 * Same labels-injection convention as `@brainstorm/sdk/i18n`
 * (`common-labels.ts`) and `popover-labels.ts`: a host passes nothing for
 * the canonical English; a localised host passes a `Partial<…Labels>` of
 * just the keys it translates (merged over the defaults). No bare strings
 * live inside the renderer — it reads everything from a merged object.
 */

import { DEFAULT_OBJECT_MENU_LABELS, type ObjectMenuLabels } from "./object-menu";

/** The renderer's full label surface = the headless item labels plus the
 *  two chrome strings the popup itself needs. */
export type ObjectMenuChromeLabels = ObjectMenuLabels & {
	/** `aria-label` for the `role="menu"` container. */
	menuRegion: string;
	/** `aria-label` / tooltip for the visible ⋯ overflow trigger. */
	moreActions: string;
	/** The "Add to collection…" item that opens the collection picker. */
	addToCollection: string;
	/** `aria-label` for the collection picker `role="menu"` container. */
	collectionsRegion: string;
	/** Disabled-row text when the vault has no user Collections yet. */
	noCollections: string;
	/** The action surface (doc 63): section header above the `Share to…`
	 *  contributed-action group. */
	actionGroupShare: string;
	/** Section header above the `Convert / Export` contributed-action group. */
	actionGroupConvert: string;
	/** Section header above the catch-all `Actions` contributed-action group. */
	actionGroupActions: string;
	/** The "More actions…" submenu collecting overflow + quarantined
	 *  (sideloaded) contributions. */
	moreContributedActions: string;
};

export const DEFAULT_OBJECT_MENU_CHROME_LABELS: ObjectMenuChromeLabels = {
	...DEFAULT_OBJECT_MENU_LABELS,
	menuRegion: "Object actions",
	moreActions: "More actions",
	addToCollection: "Add to collection…",
	collectionsRegion: "Collections",
	noCollections: "No collections yet",
	actionGroupShare: "Share to",
	actionGroupConvert: "Convert / Export",
	actionGroupActions: "Actions",
	// Distinct from `moreActions` (the ⋯ trigger's own name) so a screen reader
	// doesn't announce two controls in the same menu identically; still no
	// ellipsis (it opens a submenu, not a dialog).
	moreContributedActions: "More app actions",
};

export function resolveObjectMenuChromeLabels(
	overrides?: Partial<ObjectMenuChromeLabels>,
): ObjectMenuChromeLabels {
	return overrides
		? { ...DEFAULT_OBJECT_MENU_CHROME_LABELS, ...overrides }
		: DEFAULT_OBJECT_MENU_CHROME_LABELS;
}
