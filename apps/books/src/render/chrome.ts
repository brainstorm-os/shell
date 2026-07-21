/**
 * Shared reader chrome — the footer nav bar + control-button helper + page
 * chords used by BOTH reading surfaces (the reflow reader and the 9.21.5
 * PDF reader). Extracted at copy two per the DRY rule so the two modes
 * cannot drift apart visually or in keyboard behaviour.
 */

import { IconName, createIconElement } from "@brainstorm-os/sdk/icon";
import { t } from "../i18n";

/** Shortcut ids mirror the renderer-side chord registry (per the keyboard
 *  convention). The app self-scopes these to the reader window. */
export enum ReaderChord {
	Next = "ArrowRight",
	Prev = "ArrowLeft",
	Larger = "CmdOrCtrl+=",
	Smaller = "CmdOrCtrl+-",
	Highlights = "CmdOrCtrl+Shift+H",
}

export type ReaderFooter = {
	footer: HTMLElement;
	prev: HTMLButtonElement;
	next: HTMLButtonElement;
	status: HTMLElement;
	progress: HTMLElement;
};

export function buildReaderFooter(): ReaderFooter {
	const footer = document.createElement("footer");
	footer.className = "books__footer";

	const prev = controlButton(
		"books__nav-btn",
		t("reader.prevPage"),
		createIconElement(IconName.CaretLeft, { size: 16 }),
	);
	const status = document.createElement("span");
	status.className = "books__status";
	const progress = document.createElement("span");
	progress.className = "books__progress";
	const next = controlButton(
		"books__nav-btn",
		t("reader.nextPage"),
		createIconElement(IconName.CaretRight, { size: 16 }),
	);
	const info = document.createElement("div");
	info.className = "books__footer-info";
	info.append(status, progress);
	footer.append(prev, info, next);
	return { footer, prev, next, status, progress };
}

export function controlButton(
	className: string,
	label: string,
	glyph: string | Node,
): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = className;
	btn.setAttribute("aria-label", label);
	btn.setAttribute("data-bs-tooltip", label);
	if (typeof glyph === "string") {
		btn.textContent = glyph;
	} else {
		btn.append(glyph);
	}
	return btn;
}

/** A settings-panel row: a label on the left, the control(s) appended by the
 *  caller on the right. `modifier` switches to the stacked layout (label above
 *  a full-width control group). Shared by the reflow typography panel and the
 *  PDF view panel so the two settings surfaces read identically. */
export function labelledRow(label: string, modifier?: string): HTMLElement {
	const row = document.createElement("div");
	row.className = modifier ? `books__type-row books__type-row--${modifier}` : "books__type-row";
	const labelEl = document.createElement("span");
	labelEl.className = "books__type-label";
	labelEl.textContent = label;
	row.append(labelEl);
	return row;
}

/** A −/value/+ numeric stepper row (font size, line spacing, page width, PDF
 *  zoom). `testId` tags the live value cell so specs can read it back. */
export function stepperRow(
	label: string,
	value: string,
	onDown: () => void,
	onUp: () => void,
	testId: string,
): HTMLElement {
	const row = labelledRow(label);
	const stepper = document.createElement("div");
	stepper.className = "books__type-stepper";
	const down = controlButton(
		"books__type-step",
		t("typography.decrease", { label }),
		createIconElement(IconName.Minus, { size: 16 }),
	);
	const valueEl = document.createElement("span");
	valueEl.className = "books__type-value";
	valueEl.dataset.testid = testId;
	valueEl.textContent = value;
	const up = controlButton(
		"books__type-step",
		t("typography.increase", { label }),
		createIconElement(IconName.Plus, { size: 16 }),
	);
	down.addEventListener("click", onDown);
	up.addEventListener("click", onUp);
	stepper.append(down, valueEl, up);
	row.append(stepper);
	return row;
}
