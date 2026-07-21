/**
 * `createRadio` — the shared DOM radio for sandboxed apps (the circular twin of
 * `createCheckbox`; same chrome via `radio.css`). A visually hidden native
 * `<input type="radio">` carries semantics / keyboard / focus while a painted
 * box mirrors its state through the native `:checked` sibling selector — no JS
 * state-sync needed. Radios sharing a `name` form one group.
 *
 * The CSS ships in `app-theme.css` (apps) and as the `@brainstorm-os/sdk/radio`
 * subpath (shell).
 */

export type CreateRadioOptions = {
	/** `name` shared across the group — the browser enforces single-selection. */
	readonly name: string;
	/** Submitted/identifying value for this option. */
	readonly value: string;
	/** Visible label text. Omit for an icon-only radio (pair with `ariaLabel`). */
	readonly label?: string;
	readonly checked?: boolean;
	readonly disabled?: boolean;
	/** Accessible name when there is no visible `label`. */
	readonly ariaLabel?: string;
	/** Fired when this option becomes selected. */
	readonly onSelect?: () => void;
};

export type RadioHandle = {
	readonly element: HTMLLabelElement;
	readonly input: HTMLInputElement;
	readonly setChecked: (checked: boolean) => void;
};

function buildBox(): HTMLSpanElement {
	const box = document.createElement("span");
	box.className = "radio__box";
	box.setAttribute("aria-hidden", "true");
	const dot = document.createElement("span");
	dot.className = "radio__dot";
	box.append(dot);
	return box;
}

export function createRadio(options: CreateRadioOptions): RadioHandle {
	const element = document.createElement("label");
	element.className = options.disabled ? "radio radio--disabled" : "radio";

	const input = document.createElement("input");
	input.type = "radio";
	input.className = "radio__input";
	input.name = options.name;
	input.value = options.value;
	input.checked = options.checked ?? false;
	if (options.disabled) input.disabled = true;
	if (options.ariaLabel) input.setAttribute("aria-label", options.ariaLabel);

	element.append(input, buildBox());
	if (options.label != null) {
		const label = document.createElement("span");
		label.className = "radio__label";
		label.textContent = options.label;
		element.append(label);
	}

	input.addEventListener("change", () => {
		if (input.checked) options.onSelect?.();
	});

	return {
		element,
		input,
		setChecked: (checked) => {
			input.checked = checked;
		},
	};
}
