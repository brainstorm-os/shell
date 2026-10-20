/**
 * Auto-hide mode for a collapsible sidebar (7.15). While the user has the
 * sidebar collapsed and auto-hide is on, the panel is not gone: resting the
 * pointer on its screen edge reveals it as an overlay after a short delay,
 * leaving it hides it again, and the app's sidebar shortcut reveals it from the
 * keyboard (focus moves in; focus leaving hides it). Clicking the panel toggle
 * still pins it open the normal way.
 *
 * This module is the pure state machine — timers injected — so the timing is
 * unit-tested without a DOM; `useAutoHidePanel` is the React binding.
 */

/** Root attribute the shell stamps on every renderer while Settings →
 *  Appearance → "Auto-hide sidebars" is on. Mirrors the shell's
 *  `DisplayAttribute.AutoHideSidebars` (the SDK can't import the tokens
 *  package; a shell test pins the two together). */
export const AUTO_HIDE_SIDEBARS_ATTRIBUTE = "data-bs-autohide-sidebars";

/** `data-bs-autohide` on the panel while auto-hide is active. */
export enum AutoHideFace {
	Hidden = "hidden",
	Revealed = "revealed",
}

export const AUTO_HIDE_REVEAL_DELAY_MS = 180;
export const AUTO_HIDE_HIDE_DELAY_MS = 320;

export type AutoHideTimers = {
	set: (fn: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
};

const defaultTimers: AutoHideTimers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type AutoHideControllerOptions = {
	onChange: (revealed: boolean) => void;
	revealDelayMs?: number;
	hideDelayMs?: number;
	timers?: AutoHideTimers;
};

export type AutoHideController = {
	readonly revealed: boolean;
	/** Pointer entered the edge hot-zone — reveal after the delay. */
	edgeEnter(): void;
	/** Pointer left the hot-zone before the delay elapsed — cancel. */
	edgeLeave(): void;
	panelEnter(): void;
	panelLeave(): void;
	/** Focus moved inside the revealed panel (keyboard path). */
	focusIn(): void;
	/** Focus left the panel — hide unless the pointer is over it. */
	focusOut(): void;
	/** The sidebar shortcut: reveal now, or hide if already revealed. */
	toggle(): void;
	/** Hide immediately (Escape, a pick that should dismiss). */
	hide(): void;
	dispose(): void;
};

export function createAutoHideController(options: AutoHideControllerOptions): AutoHideController {
	const timers = options.timers ?? defaultTimers;
	const revealDelay = options.revealDelayMs ?? AUTO_HIDE_REVEAL_DELAY_MS;
	const hideDelay = options.hideDelayMs ?? AUTO_HIDE_HIDE_DELAY_MS;
	let revealed = false;
	let pointerInside = false;
	let focusInside = false;
	let pending: unknown = null;

	const cancel = () => {
		if (pending !== null) timers.clear(pending);
		pending = null;
	};
	const set = (next: boolean) => {
		cancel();
		if (next === revealed) return;
		revealed = next;
		options.onChange(next);
	};
	const schedule = (next: boolean, ms: number) => {
		cancel();
		pending = timers.set(() => {
			pending = null;
			set(next);
		}, ms);
	};

	return {
		get revealed() {
			return revealed;
		},
		edgeEnter() {
			if (!revealed) schedule(true, revealDelay);
		},
		edgeLeave() {
			if (!revealed) cancel();
		},
		panelEnter() {
			pointerInside = true;
			if (revealed) cancel();
		},
		panelLeave() {
			pointerInside = false;
			if (revealed && !focusInside) schedule(false, hideDelay);
		},
		focusIn() {
			focusInside = true;
			if (revealed) cancel();
		},
		focusOut() {
			focusInside = false;
			if (revealed && !pointerInside) schedule(false, hideDelay);
		},
		toggle() {
			set(!revealed);
		},
		hide() {
			pointerInside = false;
			focusInside = false;
			set(false);
		},
		dispose() {
			cancel();
		},
	};
}

/** True while the shell has auto-hide sidebars switched on for this renderer. */
export function readAutoHideSidebarsPreference(root: Element | null = documentRoot()): boolean {
	return root?.hasAttribute(AUTO_HIDE_SIDEBARS_ATTRIBUTE) ?? false;
}

function documentRoot(): Element | null {
	return typeof document === "undefined" ? null : document.documentElement;
}
