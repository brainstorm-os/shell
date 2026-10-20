/**
 * Split-view shortcut actions (6.14), run in the main process against the
 * window whose renderer had focus when the chord fired. The shortcut setup
 * hands every `routesToWindow` registry id here; a `false` return means
 * "nothing to act on" and lets the chord fall through to the app.
 */

import { entityIdFromRoute } from "@brainstorm-os/protocol/route";
import type { LaunchContext } from "@brainstorm-os/sdk-types";
import { SplitShortcut } from "../shortcuts/split-shortcut";
import { SplitStep } from "../window/split-layout";
import type { WindowContainer } from "./window-container";

export type SplitActionDeps = {
	/** The window hosting a renderer — a strip tab OR a side pane. */
	containerFor: (webContentsId: number) => WindowContainer | null;
	/** Open a launch beside the container's active tab (async; fire-and-forget
	 *  from a keystroke). */
	openSide: (containerId: string, appId: string, launch: LaunchContext) => void;
};

export function isSplitShortcut(id: string): id is SplitShortcut {
	return (Object.values(SplitShortcut) as string[]).includes(id);
}

/** The launch that re-opens what a pane shows: its entity, else a fresh view. */
export function launchForRoute(route: string | null): LaunchContext {
	const entityId = route ? entityIdFromRoute(route) : null;
	return entityId ? { reason: "open-entity", entityId } : { reason: "fresh" };
}

export function runSplitShortcut(
	id: SplitShortcut,
	webContentsId: number,
	deps: SplitActionDeps,
): boolean {
	const container = deps.containerFor(webContentsId);
	if (!container) return false;
	switch (id) {
		case SplitShortcut.Open: {
			// Already split: the chord moves to the side pane rather than
			// replacing it, so a repeated press never discards a view.
			if (container.sidePane()) return container.focusSidePane();
			const pane = container.tabByWebContents(webContentsId);
			if (!pane) return false;
			deps.openSide(container.id, pane.appId, launchForRoute(pane.route));
			return true;
		}
		case SplitShortcut.FocusOther:
			return container.focusOtherPane();
		case SplitShortcut.Swap:
			return container.swapPanes();
		case SplitShortcut.DividerLeft:
			return container.stepSplit(SplitStep.Left);
		case SplitShortcut.DividerRight:
			return container.stepSplit(SplitStep.Right);
	}
}
