/**
 * Inline formatting toolbar (9.17.12 rest) — the editing-time control strip
 * for rich runs on a sticky / text node. Mounted by the engine next to the
 * node being edited and torn down with the edit.
 *
 * Every control is a plain toggle button, NOT a popup: a menu would steal
 * focus from the contentEditable and fire its blur-commit. `pointerdown`
 * is prevented on the whole bar for the same reason — clicks act without
 * ever moving focus, so the selection in the editor survives. (Toolbars
 * are explicitly not menus per the fancy-menus migration notes; the
 * pattern mirrors `@brainstorm-os/editor`'s inline toolbar.)
 *
 * Layout: [B I U S] | [colour dots: default + palette] | [size: S M L].
 * Mark buttons reflect the selection via `aria-pressed`; a colour / size
 * button shows pressed when the whole selection carries that explicit
 * value, and clicking a pressed one clears the override back to the node
 * default.
 */

import type { TParams } from "@brainstorm-os/sdk/i18n";
import type { WhiteboardMessageKey } from "../i18n/t";
import type { SelectionStyles } from "../logic/rich-text";
import { TEXT_COLORS, TEXT_SIZES, TextColor, type TextSize, textColorToCss } from "../types/node";
import { RichMark } from "../types/rich-text";
import { WhiteboardIcon, createIcon } from "./icons";
import type { InlineTextEditHandle } from "./text-edit";

export type FormatToolbarT = (key: WhiteboardMessageKey, params?: TParams) => string;

export type FormatToolbarHandle = {
	readonly element: HTMLDivElement;
	/** Reflect the current selection styles on the buttons. */
	setStyles(styles: SelectionStyles): void;
	destroy(): void;
};

const MARK_BUTTONS: ReadonlyArray<{
	mark: RichMark;
	icon: WhiteboardIcon;
	labelKey: WhiteboardMessageKey;
}> = [
	{ mark: RichMark.Bold, icon: WhiteboardIcon.Bold, labelKey: "whiteboard.format.bold" },
	{ mark: RichMark.Italic, icon: WhiteboardIcon.Italic, labelKey: "whiteboard.format.italic" },
	{
		mark: RichMark.Underline,
		icon: WhiteboardIcon.Underline,
		labelKey: "whiteboard.format.underline",
	},
	{ mark: RichMark.Strike, icon: WhiteboardIcon.Strike, labelKey: "whiteboard.format.strike" },
];

const SIZE_LABEL: Readonly<Record<TextSize, WhiteboardMessageKey>> = {
	small: "whiteboard.style.size.small",
	medium: "whiteboard.style.size.medium",
	large: "whiteboard.style.size.large",
};

const SIZE_GLYPH: Readonly<Record<TextSize, string>> = {
	small: "S",
	medium: "M",
	large: "L",
};

export function createFormatToolbar(opts: {
	t: FormatToolbarT;
	editor: InlineTextEditHandle;
}): FormatToolbarHandle {
	const { t, editor } = opts;
	const bar = document.createElement("div");
	bar.className = "whiteboard__format-toolbar";
	// kbn-roles-exempt: imperative DOM toolbar; items are focusable <button>s (Tab+Enter operable).
	bar.setAttribute("role", "toolbar");
	bar.setAttribute("aria-label", t("whiteboard.format.toolbar"));
	// Keep focus (and therefore the selection) in the contentEditable: no
	// toolbar interaction may ever blur the editor.
	bar.addEventListener("pointerdown", (event) => event.preventDefault());

	const markButtons = new Map<RichMark, HTMLButtonElement>();
	for (const def of MARK_BUTTONS) {
		const btn = makeButton(t(def.labelKey));
		btn.classList.add("whiteboard__format-btn");
		btn.appendChild(createIcon(def.icon, { size: 14 }));
		btn.addEventListener("click", () => editor.toggleMark(def.mark));
		markButtons.set(def.mark, btn);
		bar.appendChild(btn);
	}

	bar.appendChild(divider());

	const colorButtons = new Map<TextColor, HTMLButtonElement>();
	for (const color of TEXT_COLORS) {
		const isDefault = color === TextColor.Default;
		const btn = makeButton(t(`whiteboard.style.textColor.${color}`));
		btn.classList.add("whiteboard__format-swatch");
		if (isDefault) btn.classList.add("whiteboard__format-swatch--default");
		const css = textColorToCss(color);
		if (css) btn.style.setProperty("--swatch-color", css);
		btn.addEventListener("click", () => {
			const pressed = btn.getAttribute("aria-pressed") === "true";
			editor.setColor(isDefault || pressed ? null : color);
		});
		colorButtons.set(color, btn);
		bar.appendChild(btn);
	}

	bar.appendChild(divider());

	const sizeButtons = new Map<TextSize, HTMLButtonElement>();
	for (const size of TEXT_SIZES) {
		const btn = makeButton(t(SIZE_LABEL[size]), false);
		btn.classList.add("whiteboard__format-btn", "whiteboard__format-size");
		btn.dataset.size = size;
		btn.textContent = SIZE_GLYPH[size];
		btn.addEventListener("click", () => {
			const pressed = btn.getAttribute("aria-pressed") === "true";
			editor.setSize(pressed ? null : size);
		});
		sizeButtons.set(size, btn);
		bar.appendChild(btn);
	}

	function setStyles(styles: SelectionStyles): void {
		for (const [mark, btn] of markButtons) {
			btn.setAttribute("aria-pressed", String(styles.marks.has(mark)));
		}
		for (const [color, btn] of colorButtons) {
			btn.setAttribute("aria-pressed", String(styles.color === color));
		}
		for (const [size, btn] of sizeButtons) {
			btn.setAttribute("aria-pressed", String(styles.size === size));
		}
	}

	setStyles(editor.selectionStyles());

	return {
		element: bar,
		setStyles,
		destroy: () => bar.remove(),
	};
}

/** `iconOnly` buttons (marks, colour swatches) get the animated tooltip chip
 *  off `data-bs-tooltip`; the size buttons carry a visible "S/M/L" glyph, so
 *  they keep the native `title`. */
function makeButton(label: string, iconOnly = true): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.setAttribute("aria-label", label);
	if (iconOnly) btn.dataset.bsTooltip = label;
	else btn.title = label;
	btn.setAttribute("aria-pressed", "false");
	return btn;
}

function divider(): HTMLSpanElement {
	const sep = document.createElement("span");
	sep.className = "whiteboard__format-divider";
	sep.setAttribute("aria-hidden", "true");
	return sep;
}
