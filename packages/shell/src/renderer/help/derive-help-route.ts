/**
 * Help-2 — derive the contextual help route from the dashboard's focused
 * surface. Pure so the deriver can be unit-tested without rendering.
 *
 * The grammar mirrors `resolveTopicId` in `main/help/help-corpus.ts`:
 *
 *   - `app/<appId>` — a Brainstorm app window is focused; the resolver
 *     looks up the matching `app-<shortAppId>` section.
 *   - `settings/<pane>` — the Settings overlay is open on a specific
 *     pane. The resolver searches for `guide/settings/<pane>` and
 *     falls back to the Settings section's first article.
 *   - `dashboard` — no overlay open, no app window focused. The
 *     resolver returns the corpus home topic.
 *
 * The launcher / window-switcher / vault-switcher / bin / marketplace
 * surfaces don't carry their own help topics yet — they fall through
 * to `dashboard`. Help-2's scope is the three load-bearing surfaces
 * the resolver already understands; broader coverage lands as
 * specific surface-help articles get authored.
 */

import type { WindowEntry } from "@brainstorm-os/protocol/window-types";
import type { SettingsSection } from "../settings/sections";

export type HelpRouteState = {
	/** Settings overlay open. When true, `settingsSection` may pin the
	 *  pane the user is currently looking at. */
	readonly settingsOpen: boolean;
	/** The Settings pane the overlay is currently rendering, if known.
	 *  When omitted, the deriver emits a bare `settings` route which
	 *  the resolver fans out to the section's first article. */
	readonly settingsSection?: SettingsSection | undefined;
	/** Snapshot of the active windows. The deriver picks the one
	 *  whose `focused` flag is true. */
	readonly windows: readonly WindowEntry[];
};

/** Derive the focused-surface help route from the dashboard's state.
 *  Always returns a non-empty string — `dashboard` is the conservative
 *  default the resolver maps to the home topic. */
export function deriveHelpRoute(state: HelpRouteState): string {
	// Settings wins over a focused app window: the Settings overlay is
	// a modal layer on top of the dashboard / app windows, so when it's
	// open the user is most likely reading or editing settings. The
	// pane (when known) narrows further to `settings/<pane>`.
	if (state.settingsOpen) {
		const pane = state.settingsSection;
		return pane ? `settings/${pane}` : "settings";
	}
	const focusedApp = state.windows.find((w) => w.focused);
	if (focusedApp) return `app/${focusedApp.appId}`;
	return "dashboard";
}
