/**
 * `createEmptyState` — the DOM twin of the React `<EmptyState>` (same `.bs-empty-state`
 * markup + `empty-state.css`), for imperative-DOM surfaces that can't mount a React
 * component (e.g. Tasks' surface-view, mid all-apps-React migration). Builds the same
 * glyph + title + hint + optional action so an empty surface looks identical whether the
 * host is React or plain DOM.
 */

import { type IconName, createIconElement } from "../icon";
import { EmptyStateTone, emptyStateClassName } from "./tone";

export type CreateEmptyStateOptions = {
	icon: IconName | `${IconName}`;
	title: string;
	/** Optional second line — what to do about the empty state. */
	hint?: string;
	/** Optional action row (e.g. a `bs-btn` element) below the hint. */
	action?: HTMLElement;
	/** `Hero` (large accent chip, default) vs `Compact` (small dim glyph). */
	tone?: EmptyStateTone;
	/** Extra layout/positioning classes (never re-skin the surface). */
	className?: string;
};

export function createEmptyState(options: CreateEmptyStateOptions): HTMLElement {
	const root = document.createElement("div");
	root.className = emptyStateClassName(options.tone ?? EmptyStateTone.Hero, options.className);

	const glyph = document.createElement("span");
	glyph.className = "bs-empty-state__glyph";
	glyph.setAttribute("aria-hidden", "true");
	glyph.appendChild(createIconElement(options.icon, { size: 28 }));
	root.appendChild(glyph);

	const title = document.createElement("p");
	title.className = "bs-empty-state__title";
	title.textContent = options.title;
	root.appendChild(title);

	if (options.hint) {
		const hint = document.createElement("p");
		hint.className = "bs-empty-state__hint";
		hint.textContent = options.hint;
		root.appendChild(hint);
	}

	if (options.action) {
		const action = document.createElement("div");
		action.className = "bs-empty-state__action";
		action.appendChild(options.action);
		root.appendChild(action);
	}

	return root;
}
