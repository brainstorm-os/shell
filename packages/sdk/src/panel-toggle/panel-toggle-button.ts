/**
 * Shared sidebar / inspector toggle BUTTON — the chrome around
 * `panelToggleIcon`. Six first-party apps had hand-rolled copies of the
 * same `<button class="X__nav-toggle"><svg/></button>` + identical 26×26
 * border-strong CSS; whiteboard already drifted to 24×24 transparent-border
 * once and shipped looking different from every other app. Single helper +
 * a single `.bs-panel-toggle` CSS rule (injected by the shell's
 * `app-theme.ts`, matching the `.header-nav__btn` precedent) means a panel
 * toggle in any app is bit-identical chrome with zero per-app surface.
 */

import { type PanelSide, panelToggleIcon } from "./panel-toggle-icon";

/** Localized labels for the open vs closed states. Renderer chooses the
 *  exact wording per app ("Hide source list", "Show properties", …). */
export interface PanelToggleLabels {
	show: string;
	hide: string;
}

export interface PanelToggleButtonOptions {
	side: PanelSide;
	open: boolean;
	onClick: () => void;
	labels: PanelToggleLabels;
	/** Optional ARIA attributes the host wants on the button (e.g.
	 *  `aria-controls="notes-nav"`). Applied verbatim. */
	ariaControls?: string;
	/** Optional disabled flag — Files/Notes disable the inspector toggle
	 *  when no entity is selected. Updates re-paint via `setDisabled`. */
	disabled?: boolean;
	/** Overrides the title / aria-label — used to explain a disabled state
	 *  ("Select a contact first"). Falls back to the show/hide label. The
	 *  React twin's `hint` prop; updates re-paint via `setHint`. */
	hint?: string;
	/** Optional `data-testid` — handy when tests target the toggle by role
	 *  is fragile (multiple toggles per app). */
	testId?: string;
}

export interface PanelToggleButtonHandle {
	element: HTMLButtonElement;
	/** Repaint open-state: aria-pressed + label + the icon SVG. */
	render(open: boolean): void;
	/** Repaint disabled-state. */
	setDisabled(disabled: boolean): void;
	/** Swap the label override (see `hint`) and repaint. */
	setHint(hint: string | undefined): void;
}

/** Build the toggle button + paint its initial state. The host owns the
 *  click target's onClick; this helper owns aria-*, title, the icon, and
 *  the canonical `bs-panel-toggle` class. */
export function createPanelToggleButton(opts: PanelToggleButtonOptions): PanelToggleButtonHandle {
	const element = document.createElement("button");
	element.type = "button";
	element.className = "bs-panel-toggle";
	if (opts.ariaControls) element.setAttribute("aria-controls", opts.ariaControls);
	if (opts.testId) element.dataset.testid = opts.testId;
	element.addEventListener("click", () => {
		if (element.disabled) return;
		opts.onClick();
	});

	let hint = opts.hint;
	let isOpen = opts.open;

	const render = (open: boolean): void => {
		isOpen = open;
		const label = hint ?? (open ? opts.labels.hide : opts.labels.show);
		element.setAttribute("aria-pressed", String(open));
		element.setAttribute("aria-label", label);
		// The animated `.bs-tooltip` chip renders off `data-bs-tooltip`; the
		// native `title` is kept only while disabled (a disabled control fires
		// no pointer events, so the chip can't open to explain itself).
		element.dataset.bsTooltip = label;
		if (element.disabled) element.title = label;
		else element.removeAttribute("title");
		element.replaceChildren(panelToggleIcon(opts.side, open));
	};

	const setDisabled = (disabled: boolean): void => {
		element.disabled = disabled;
		const label = element.getAttribute("aria-label");
		if (disabled && label) element.title = label;
		else element.removeAttribute("title");
	};

	const setHint = (next: string | undefined): void => {
		hint = next;
		render(isOpen);
		setDisabled(element.disabled);
	};

	render(opts.open);
	if (opts.disabled) setDisabled(true);

	return { element, render, setDisabled, setHint };
}
