/**
 * createPopoverElement — the pure-DOM twin of `<Popover>` for plain-DOM
 * apps (the imperative analogue of `picker-host.tsx`, but with zero React).
 * Mounts a dismiss-on-backdrop / dismiss-on-Escape glass overlay into
 * `document.body`, returning a handle so the caller can close it
 * programmatically.
 *
 * Same chrome contract as the React `<Popover>` (header / body / optional
 * footer, the same `popover.css`, the same size + body-padding enums).
 * Escape routes through the shared matcher seam in `./popover-shared` —
 * never a raw inline `e.key`. Strings come from injected labels.
 */

import { createIconElement } from "../icon/create-icon-element";
import { IconName } from "../icon/icon-registry";
import { type PopoverLabels, resolvePopoverLabels } from "./popover-labels";
import {
	DEFAULT_POPOVER_ESCAPE_MATCHER,
	PopoverBodyPadding,
	type PopoverEscapeMatcher,
	PopoverSize,
} from "./popover-shared";
import "./popover.css";

export type CreatePopoverOptions = {
	title: string;
	/** Body content. A node is appended; a string becomes its text. */
	body: Node | string;
	/** Optional footer action row. */
	footer?: Node;
	onClose: () => void;
	size?: PopoverSize;
	/** Drop the size variant's `min-height` so a SHORT body (one field, one
	 *  sentence) sizes the panel to its content instead of holding a fixed
	 *  minimum that leaves a dead gap above the footer. Parity with the shell
	 *  renderer's React `<Popover fitContent>`; the variant's `max-height`
	 *  still caps a long body, which scrolls unchanged. */
	fitContent?: boolean;
	bodyPadding?: PopoverBodyPadding;
	/** Escape predicate, or `null` to leave Escape to the consumer.
	 *  Default: bare-Escape via the shared matcher seam. */
	escapeMatcher?: PopoverEscapeMatcher | null;
	labels?: Partial<PopoverLabels>;
	testId?: string;
};

export type PopoverHandle = {
	/** The mounted dialog root (already in `document.body`). */
	readonly element: HTMLElement;
	/** Unmount + detach the Escape listener. Idempotent. Does NOT call
	 *  `onClose` — the backdrop/Escape paths call `onClose` then this. */
	close(): void;
};

export function createPopoverElement(options: CreatePopoverOptions): PopoverHandle {
	const l = resolvePopoverLabels(options.labels);
	const size = options.size ?? PopoverSize.Medium;
	const bodyPadding = options.bodyPadding ?? PopoverBodyPadding.Compact;
	const escapeMatcher =
		options.escapeMatcher === undefined ? DEFAULT_POPOVER_ESCAPE_MATCHER : options.escapeMatcher;

	const root = document.createElement("div");
	root.className = "bs-popover";
	root.setAttribute("role", "dialog");
	root.setAttribute("aria-modal", "true");
	root.setAttribute("aria-label", options.title || l.region);

	const backdrop = document.createElement("button");
	backdrop.type = "button";
	backdrop.className = "bs-popover__backdrop";
	backdrop.setAttribute("aria-label", l.close);
	backdrop.tabIndex = -1;

	const panel = document.createElement("div");
	panel.className = `bs-popover__panel bs-popover__panel--${size}${
		options.fitContent ? " bs-popover__panel--fit" : ""
	}`;
	if (options.testId) panel.dataset.testid = options.testId;

	const header = document.createElement("header");
	header.className = "bs-popover__header";
	const titleEl = document.createElement("h2");
	titleEl.className = "bs-popover__title";
	titleEl.textContent = options.title;
	const closeBtn = document.createElement("button");
	closeBtn.type = "button";
	closeBtn.className = "bs-popover__close";
	closeBtn.setAttribute("aria-label", l.close);
	closeBtn.appendChild(createIconElement(IconName.Close, { size: 18 }));
	header.append(titleEl, closeBtn);

	const bodyEl = document.createElement("div");
	bodyEl.className = `bs-popover__body bs-popover__body--${bodyPadding}`;
	if (typeof options.body === "string") bodyEl.textContent = options.body;
	else bodyEl.appendChild(options.body);

	panel.append(header, bodyEl);
	if (options.footer) {
		const footerEl = document.createElement("footer");
		footerEl.className = "bs-popover__footer";
		footerEl.appendChild(options.footer);
		panel.appendChild(footerEl);
	}

	root.append(backdrop, panel);

	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		if (escapeMatcher !== null) document.removeEventListener("keydown", onKeyDown, true);
		root.remove();
	};

	const requestClose = (): void => {
		options.onClose();
		close();
	};

	function onKeyDown(event: KeyboardEvent): void {
		if (event.defaultPrevented) return;
		if (escapeMatcher?.(event)) {
			event.preventDefault();
			requestClose();
		}
	}

	backdrop.addEventListener("click", requestClose);
	closeBtn.addEventListener("click", requestClose);
	if (escapeMatcher !== null) document.addEventListener("keydown", onKeyDown, true);

	document.body.appendChild(root);
	return { element: root, close };
}
