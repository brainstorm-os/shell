/**
 * React binding for the auto-hide sidebar mode (7.15) — see `auto-hide.ts`.
 *
 * An app opts in by spreading `panelProps` on its sidebar element, rendering
 * the edge hot-zone from `edgeProps`, driving the sidebar's `inert` /
 * `aria-hidden` from `visible`, and calling `toggle` from its sidebar shortcut
 * while `active`. Everything is inert while the sidebar is open or the user
 * has auto-hide off, so adoption never changes the pinned-open behaviour.
 */

import {
	type FocusEvent,
	type RefCallback,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { attachShortcut } from "../shortcut";
import {
	AUTO_HIDE_SIDEBARS_ATTRIBUTE,
	AutoHideFace,
	createAutoHideController,
	readAutoHideSidebarsPreference,
} from "./auto-hide";
import type { PanelSide } from "./panel-toggle-icon";

const HIDE_CHORD = "Escape";
const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function subscribePreference(onChange: () => void): () => void {
	if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
		return () => undefined;
	}
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: [AUTO_HIDE_SIDEBARS_ATTRIBUTE],
	});
	return () => observer.disconnect();
}

const readPreference = () => readAutoHideSidebarsPreference();
const readPreferenceOnServer = () => false;

/** Live Settings → Appearance → "Auto-hide sidebars" for this renderer. */
export function useAutoHideSidebarsPreference(): boolean {
	return useSyncExternalStore(subscribePreference, readPreference, readPreferenceOnServer);
}

export type UseAutoHidePanelOptions = {
	side: PanelSide;
	/** The app's own collapsed state (its panel toggle is off). */
	collapsed: boolean;
	/** Override the shell preference (tests, an app-level setting). */
	enabled?: boolean;
	revealDelayMs?: number;
	hideDelayMs?: number;
};

export type AutoHidePanelProps = {
	ref?: RefCallback<HTMLElement>;
	"data-bs-autohide"?: AutoHideFace;
	"data-bs-side"?: PanelSide;
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
	onFocus?: () => void;
	onBlur?: (event: FocusEvent<HTMLElement>) => void;
};

export type AutoHideEdgeProps = {
	className: string;
	"data-bs-side": PanelSide;
	"aria-hidden": true;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
};

export type AutoHidePanel = {
	/** Auto-hide governs the panel right now (on, and the panel is collapsed). */
	active: boolean;
	revealed: boolean;
	/** The panel's content is on screen — pinned open, or revealed. Drive the
	 *  panel's `inert` / `aria-hidden` from this so a hidden overlay stays out
	 *  of the tab order and the accessibility tree. */
	visible: boolean;
	panelProps: AutoHidePanelProps;
	/** The edge hot-zone to render beside the panel, or `null` when inactive. */
	edgeProps: AutoHideEdgeProps | null;
	/** Reveal (moving focus in) or hide — the app's sidebar shortcut. */
	toggle: () => void;
	hide: () => void;
};

export function useAutoHidePanel(options: UseAutoHidePanelOptions): AutoHidePanel {
	const preference = useAutoHideSidebarsPreference();
	const active = (options.enabled ?? preference) && options.collapsed;
	const [revealed, setRevealed] = useState(false);
	const panelRef = useRef<HTMLElement | null>(null);
	const focusOnReveal = useRef(false);
	const [controller] = useState(() =>
		createAutoHideController({
			onChange: setRevealed,
			...(options.revealDelayMs !== undefined ? { revealDelayMs: options.revealDelayMs } : {}),
			...(options.hideDelayMs !== undefined ? { hideDelayMs: options.hideDelayMs } : {}),
		}),
	);

	useEffect(() => () => controller.dispose(), [controller]);

	useEffect(() => {
		if (!active) controller.hide();
	}, [active, controller]);

	useEffect(() => {
		if (!revealed || !focusOnReveal.current) return;
		focusOnReveal.current = false;
		panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
	}, [revealed]);

	useEffect(() => {
		const panel = panelRef.current;
		if (!active || !revealed || !panel) return;
		return attachShortcut(panel, HIDE_CHORD, () => controller.hide());
	}, [active, revealed, controller]);

	const setPanel = useCallback<RefCallback<HTMLElement>>((el) => {
		panelRef.current = el;
	}, []);

	const toggle = useCallback(() => {
		if (!controller.revealed) focusOnReveal.current = true;
		controller.toggle();
	}, [controller]);

	const hide = useCallback(() => controller.hide(), [controller]);

	if (!active) {
		return {
			active: false,
			revealed: false,
			visible: !options.collapsed,
			panelProps: { ref: setPanel },
			edgeProps: null,
			toggle,
			hide,
		};
	}

	return {
		active: true,
		revealed,
		visible: revealed,
		panelProps: {
			ref: setPanel,
			"data-bs-autohide": revealed ? AutoHideFace.Revealed : AutoHideFace.Hidden,
			"data-bs-side": options.side,
			onPointerEnter: () => controller.panelEnter(),
			onPointerLeave: () => controller.panelLeave(),
			onFocus: () => controller.focusIn(),
			onBlur: (event) => {
				const next = event.relatedTarget;
				if (next instanceof Node && event.currentTarget.contains(next)) return;
				controller.focusOut();
			},
		},
		edgeProps: {
			className: "bs-autohide-edge",
			"data-bs-side": options.side,
			"aria-hidden": true,
			onPointerEnter: () => controller.edgeEnter(),
			onPointerLeave: () => controller.edgeLeave(),
		},
		toggle,
		hide,
	};
}
