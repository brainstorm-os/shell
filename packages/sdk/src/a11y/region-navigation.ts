/**
 * `@brainstorm-os/sdk/a11y` region-navigation controller — pure F6 / Shift+F6
 * cycling across major panes within one window. NO DOM (KBN-1b binds it).
 * One region per stable shell pane (`RegionId.*`) plus open-string ids for
 * apps that declare their own.
 *
 * Conventions per `61-keyboard-accessibility.md §Tab order — the regions
 * model`: Tab is unconstrained within a region; F6 walks across regions;
 * Shift+F6 walks backward. Both wrap end↔start. Skip-to-content links call
 * `regionFocus` directly with a known id.
 */

import type { RegionId } from "./region-id";

export type RegionEntry = {
	readonly id: RegionId | string;
	readonly label: string;
};

export type RegionState = {
	readonly regions: ReadonlyArray<RegionEntry>;
	readonly activeRegionId: string | null;
};

function indexOf(regions: ReadonlyArray<RegionEntry>, id: string | null): number {
	if (id === null) return -1;
	for (let i = 0; i < regions.length; i++) {
		if ((regions[i] as RegionEntry).id === id) return i;
	}
	return -1;
}

export function regionInit(
	regions: ReadonlyArray<RegionEntry>,
	activeRegionId?: RegionId | string | null,
): RegionState {
	const resolved =
		activeRegionId !== undefined && activeRegionId !== null && indexOf(regions, activeRegionId) >= 0
			? activeRegionId
			: regions.length === 0
				? null
				: (regions[0] as RegionEntry).id;
	return Object.freeze({ regions, activeRegionId: resolved });
}

function withActive(state: RegionState, activeRegionId: string | null): RegionState {
	if (state.activeRegionId === activeRegionId) return state;
	return Object.freeze({ ...state, activeRegionId });
}

export function regionNext(state: RegionState): RegionState {
	if (state.regions.length === 0) return state;
	const idx = indexOf(state.regions, state.activeRegionId);
	const next = idx < 0 ? 0 : (idx + 1) % state.regions.length;
	return withActive(state, (state.regions[next] as RegionEntry).id);
}

export function regionPrevious(state: RegionState): RegionState {
	if (state.regions.length === 0) return state;
	const idx = indexOf(state.regions, state.activeRegionId);
	const len = state.regions.length;
	const next = idx < 0 ? len - 1 : (idx - 1 + len) % len;
	return withActive(state, (state.regions[next] as RegionEntry).id);
}

export function regionFocus(state: RegionState, id: RegionId | string): RegionState {
	if (indexOf(state.regions, id) < 0) return state;
	return withActive(state, id);
}
