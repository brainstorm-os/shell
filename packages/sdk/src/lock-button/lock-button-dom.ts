/**
 * The DOM twin of `<LockButton>` — same chrome, same a11y contract, for the
 * apps whose header is still imperative (Database's inspector). Mirrors the
 * `createPanelToggleButton` precedent: React apps import the component, DOM
 * apps import this, and the button is bit-identical either way.
 *
 * It also fixes what the hand-rolled copy got wrong. Database hid its lock
 * button (`hidden = true`) whenever the inspector wasn't showing exactly one
 * record — the vanishing-control anti-pattern the panel-toggle rule already
 * bans: the affordance disappears, so the user never learns it exists, and the
 * reason it can't act disappears with it. Here a control that cannot act says
 * so ({@link LockButtonHandle.setHint}) and stays put.
 */

import { IconName, createIconElement } from "../icon";

/** The two action labels, localised by the host. Which one shows is derived
 *  from the lock state — the label always names what activating DOES. */
export interface LockButtonLabels {
	/** Shown while UNLOCKED (the lock action, e.g. "Lock (read-only)"). */
	lock: string;
	/** Shown while LOCKED (the unlock action, e.g. "Unlock"). */
	unlock: string;
}

export interface LockButtonOptions {
	locked: boolean;
	/** Activation. Receives the lock state AT CLICK TIME, so the host writes
	 *  `lockTogglePatch(locked)` without tracking the state twice. */
	onToggle: (locked: boolean) => void;
	labels: LockButtonLabels;
	/** Explains why the control cannot act right now; disables it and becomes
	 *  its accessible name + native `title`. Absent = live. */
	hint?: string;
}

export interface LockButtonHandle {
	element: HTMLButtonElement;
	/** Repaint for a new lock state (aria-pressed + label + tooltip). */
	render(locked: boolean): void;
	/** Set / clear the disabled explanation. `undefined` restores the live
	 *  action label and re-enables the button. */
	setHint(hint: string | undefined): void;
}

export function createLockButton(opts: LockButtonOptions): LockButtonHandle {
	const element = document.createElement("button");
	element.type = "button";
	element.className = "header-icon-btn bs-lock-button";
	element.append(createIconElement(IconName.Lock));

	let locked = opts.locked;
	let hint = opts.hint;

	const paint = (): void => {
		const action = locked ? opts.labels.unlock : opts.labels.lock;
		const label = hint ?? action;
		element.setAttribute("aria-pressed", String(locked));
		element.setAttribute("aria-label", label);
		element.dataset.bsTooltip = label;
		element.disabled = hint !== undefined;
		// A disabled control fires no pointer events, so the animated
		// `.bs-tooltip` chip can never open — the native `title` is the only
		// explanation that still reaches the user there.
		if (element.disabled) element.title = label;
		else element.removeAttribute("title");
	};

	element.addEventListener("click", () => {
		if (element.disabled) return;
		opts.onToggle(locked);
	});

	paint();

	return {
		element,
		render: (next: boolean): void => {
			locked = next;
			paint();
		},
		setHint: (next: string | undefined): void => {
			hint = next;
			paint();
		},
	};
}
