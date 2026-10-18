/**
 * Split view state machine (6.14). Pure — the window container owns one of
 * these per OS window and re-lays out its views from it after every event.
 *
 * Vocabulary: the PRIMARY pane is the container's active strip tab (the
 * container's own app); the SIDE pane is the one opened "to the side" and may
 * be a different app. They are two separate renderers; this module only tracks
 * which is where, which has focus, and how wide each is.
 */

import {
	SPLIT_DEFAULT_RATIO,
	type SplitStep,
	clampSplitRatio,
	stepSplitRatio,
} from "./split-layout";

export enum SplitPane {
	Primary = "primary",
	Side = "side",
}

/** Which pane sits on the left. A side pane opens to the right. */
export enum SplitOrder {
	PrimaryFirst = "primary-first",
	SideFirst = "side-first",
}

export type SplitState = {
	open: boolean;
	order: SplitOrder;
	focused: SplitPane;
	/** The PRIMARY pane's share of the usable width. Stored per pane rather
	 *  than per side so a swap moves the panes without resizing them, and so a
	 *  re-opened split in the same window comes back at the width the user
	 *  last dragged it to. */
	primaryRatio: number;
};

export const INITIAL_SPLIT_STATE: SplitState = {
	open: false,
	order: SplitOrder.PrimaryFirst,
	focused: SplitPane.Primary,
	primaryRatio: SPLIT_DEFAULT_RATIO,
};

export enum SplitEventKind {
	OpenSide = "open-side",
	CloseSide = "close-side",
	/** The primary pane's last tab closed and the side pane took its place. */
	PromoteSide = "promote-side",
	Swap = "swap",
	Focus = "focus",
	FocusOther = "focus-other",
	/** Divider dragged: `leftRatio` is the LEFT pane's share. */
	SetLeftRatio = "set-left-ratio",
	Step = "step",
}

export type SplitEvent =
	| { kind: SplitEventKind.OpenSide }
	| { kind: SplitEventKind.CloseSide }
	| { kind: SplitEventKind.PromoteSide }
	| { kind: SplitEventKind.Swap }
	| { kind: SplitEventKind.Focus; pane: SplitPane }
	| { kind: SplitEventKind.FocusOther }
	| { kind: SplitEventKind.SetLeftRatio; leftRatio: number; width: number }
	| { kind: SplitEventKind.Step; step: SplitStep; width: number };

export function leftRatioOf(state: SplitState): number {
	return state.order === SplitOrder.PrimaryFirst ? state.primaryRatio : 1 - state.primaryRatio;
}

function withLeftRatio(state: SplitState, leftRatio: number): SplitState {
	const primaryRatio = state.order === SplitOrder.PrimaryFirst ? leftRatio : 1 - leftRatio;
	return primaryRatio === state.primaryRatio ? state : { ...state, primaryRatio };
}

export function reduceSplit(state: SplitState, event: SplitEvent): SplitState {
	switch (event.kind) {
		case SplitEventKind.OpenSide:
			return { ...state, open: true, order: SplitOrder.PrimaryFirst, focused: SplitPane.Side };
		case SplitEventKind.CloseSide:
		case SplitEventKind.PromoteSide:
			if (!state.open) return state;
			return { ...state, open: false, order: SplitOrder.PrimaryFirst, focused: SplitPane.Primary };
		case SplitEventKind.Swap:
			if (!state.open) return state;
			return {
				...state,
				order: state.order === SplitOrder.PrimaryFirst ? SplitOrder.SideFirst : SplitOrder.PrimaryFirst,
			};
		case SplitEventKind.Focus: {
			const focused = state.open ? event.pane : SplitPane.Primary;
			return focused === state.focused ? state : { ...state, focused };
		}
		case SplitEventKind.FocusOther:
			if (!state.open) return state;
			return {
				...state,
				focused: state.focused === SplitPane.Primary ? SplitPane.Side : SplitPane.Primary,
			};
		case SplitEventKind.SetLeftRatio:
			if (!state.open) return state;
			return withLeftRatio(state, clampSplitRatio(event.leftRatio, event.width));
		case SplitEventKind.Step:
			if (!state.open) return state;
			return withLeftRatio(state, stepSplitRatio(leftRatioOf(state), event.step, event.width));
	}
}
