/**
 * Shared fuzzy-combobox palette overlay (9.7.5) — the single owner of the
 * centred glass overlay + `role=dialog` panel, the combobox keyboard wiring,
 * the live-filter render loop, and the Escape / backdrop / row-mousedown
 * semantics shared by the quick-open file palette and the command palette.
 *
 * Both surfaces are the same fuzzy-combobox: a text input that filters a ranked
 * list, with the active row tracked via `aria-activedescendant`. They differ
 * ONLY in their row adapter — the ranking function, how a row renders (the file
 * palette adds a secondary path span), the i18n strings, and what happens on
 * choose. `openFuzzyPalette` takes those four as parameters; the chrome is here.
 *
 * KBN-A-code-editor: the input + results form a combobox driven by the shared
 * `attachCompositeKeyboard` binding (`host: Combobox`, `keyboardTarget` = the
 * input). Focus stays on the input; `aria-activedescendant` tracks the active
 * `option`; ↑/↓ move the cursor and Enter chooses — so the `listbox`/`option`
 * roles + arrow/Enter handling come from the SDK, not hand-written here. Escape
 * (close) stays a local handler — it isn't a composite movement.
 */

import { CompositeHost, Orientation, attachCompositeKeyboard } from "@brainstorm-os/sdk/a11y";

export type FuzzyPaletteLabels = {
	/** `aria-label` for the dialog + the input. */
	label: string;
	/** Input placeholder. */
	placeholder: string;
	/** Empty-state text shown when nothing matches. */
	empty: string;
};

export type FuzzyPaletteOptions<T> = {
	/** The full candidate set, ranked + filtered by `rank` on every keystroke. */
	rows: readonly T[];
	mount: HTMLElement;
	/** Pure ranking fn (e.g. `rankCommands` / `rankFiles`). */
	rank: (rows: readonly T[], query: string) => T[];
	/** Populate the `<li>` for one ranked row (name span, optional path span,
	 *  and any per-row `dataset` keys the tests read). */
	renderRow: (li: HTMLElement, row: T) => void;
	/** Run the chosen row's effect (run a command / route to a file). Called
	 *  AFTER the overlay has torn down. */
	onChoose: (row: T) => void;
	labels: FuzzyPaletteLabels;
	/** Fired once when the palette tears down for any reason (choose, Escape,
	 *  backdrop, or `controller.close()`) so the caller can drop its handle. */
	onClose?: () => void;
};

export type FuzzyPaletteController = {
	close(): void;
};

export function openFuzzyPalette<T>(opts: FuzzyPaletteOptions<T>): FuzzyPaletteController {
	const overlay = document.createElement("div");
	overlay.className = "editor__quickopen-overlay";
	const panel = document.createElement("div");
	panel.className = "editor__quickopen glass--strong";
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-label", opts.labels.label);
	const input = document.createElement("input");
	input.type = "text";
	input.className = "editor__quickopen-input";
	input.placeholder = opts.labels.placeholder;
	input.setAttribute("aria-label", opts.labels.label);
	const list = document.createElement("ul");
	list.className = "editor__quickopen-list";
	panel.append(input, list);
	overlay.appendChild(panel);
	opts.mount.appendChild(overlay);

	let ranked: T[] = [];
	let active = 0;
	let closed = false;

	const close = (): void => {
		if (closed) return;
		closed = true;
		kb.destroy();
		overlay.remove();
		opts.onClose?.();
	};
	const choose = (row: T): void => {
		close();
		opts.onChoose(row);
	};
	// Visual highlight + scroll for the active row; the listbox/option roles +
	// `aria-selected` + `aria-activedescendant` are owned by the binding below.
	const syncActive = (): void => {
		const items = list.querySelectorAll<HTMLElement>(".editor__quickopen-item");
		items.forEach((el, i) => {
			const on = i === active;
			el.dataset.active = on ? "true" : "false";
			// Guarded — not implemented in jsdom / headless environments.
			if (on) el.scrollIntoView?.({ block: "nearest" });
		});
	};

	const kb = attachCompositeKeyboard(list, {
		orientation: Orientation.Vertical,
		host: CompositeHost.Combobox,
		useAriaActiveDescendant: true,
		keyboardTarget: input,
		count: () => ranked.length,
		activeIndex: () => active,
		onActiveIndexChange: (i) => {
			active = i;
			syncActive();
		},
		onActivate: (i) => {
			const row = ranked[i];
			if (row !== undefined) choose(row);
		},
	});

	const renderList = (): void => {
		ranked = opts.rank(opts.rows, input.value);
		active = ranked.length === 0 ? 0 : Math.min(active, ranked.length - 1);
		list.replaceChildren();
		if (ranked.length === 0) {
			const empty = document.createElement("li");
			empty.className = "editor__quickopen-empty";
			empty.textContent = opts.labels.empty;
			list.appendChild(empty);
			kb.refresh();
			return;
		}
		ranked.forEach((row, i) => {
			const li = document.createElement("li");
			li.className = "editor__quickopen-item";
			li.dataset.compositeIndex = String(i);
			opts.renderRow(li, row);
			// `mousedown` (not click) so the press lands before the input's blur
			// can tear the overlay down under the pointer.
			li.addEventListener("mousedown", (event) => {
				event.preventDefault();
				choose(row);
			});
			list.appendChild(li);
		});
		kb.refresh();
		syncActive();
	};

	input.addEventListener("input", () => {
		active = 0;
		renderList();
	});
	// Escape closes the palette — not a composite movement, so it stays local;
	// `attachShortcut` suppresses single keys inside an editable <input>.
	// keyboard-exempt
	input.addEventListener("keydown", (event) => {
		// keyboard-exempt
		if (event.key === "Escape") {
			event.preventDefault();
			close();
		}
	});
	overlay.addEventListener("mousedown", (event) => {
		if (event.target === overlay) close();
	});

	renderList();
	input.focus();

	return { close };
}
