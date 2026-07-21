/**
 * `createCheckbox` — the shared DOM checkbox for sandboxed apps (the non-React
 * twin of the shell's `<Checkbox>`; same chrome via `checkbox.css`). A visually
 * hidden native `<input>` carries semantics / keyboard / focus while a painted
 * box mirrors its state through the native `:checked` / `:indeterminate`
 * sibling selectors — no JS state-sync needed.
 *
 * The CSS ships in `app-theme.css` (apps) and as the `@brainstorm-os/sdk/checkbox`
 * subpath (shell). Glyph markup lives here so no app hand-rolls the SVG tick
 * ([[no-inline-glyphs]]). React apps render the `<Checkbox>` twin (also
 * exported here) for the same chrome without mounting DOM imperatively.
 */

export { Checkbox, type CheckboxProps } from "./checkbox";

const SVG_NS = "http://www.w3.org/2000/svg";

export type CreateCheckboxOptions = {
	/** Visible label text. Omit for an icon-only checkbox (pair with `ariaLabel`). */
	readonly label?: string;
	readonly checked?: boolean;
	readonly indeterminate?: boolean;
	readonly disabled?: boolean;
	/** Accessible name when there is no visible `label`. */
	readonly ariaLabel?: string;
	/** Fired on user toggle with the new checked state (clears indeterminate). */
	readonly onChange?: (checked: boolean) => void;
};

export type CheckboxHandle = {
	readonly element: HTMLLabelElement;
	readonly input: HTMLInputElement;
	readonly setChecked: (checked: boolean) => void;
	readonly setIndeterminate: (indeterminate: boolean) => void;
};

function buildBox(): HTMLSpanElement {
	const box = document.createElement("span");
	box.className = "checkbox__box";
	box.setAttribute("aria-hidden", "true");

	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "checkbox__check");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("aria-hidden", "true");
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", "M5 13l4 4L19 7");
	path.setAttribute("stroke", "currentColor");
	path.setAttribute("stroke-width", "3");
	path.setAttribute("stroke-linecap", "round");
	path.setAttribute("stroke-linejoin", "round");
	path.setAttribute("pathLength", "1");
	svg.append(path);

	const dash = document.createElement("span");
	dash.className = "checkbox__dash";

	box.append(svg, dash);
	return box;
}

export function createCheckbox(options: CreateCheckboxOptions = {}): CheckboxHandle {
	const element = document.createElement("label");
	element.className = options.disabled ? "checkbox checkbox--disabled" : "checkbox";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.className = "checkbox__input";
	input.checked = options.checked ?? false;
	input.indeterminate = options.indeterminate ?? false;
	if (options.disabled) input.disabled = true;
	if (options.ariaLabel) input.setAttribute("aria-label", options.ariaLabel);

	element.append(input, buildBox());
	if (options.label != null) {
		const label = document.createElement("span");
		label.className = "checkbox__label";
		label.textContent = options.label;
		element.append(label);
	}

	input.addEventListener("change", () => {
		input.indeterminate = false;
		options.onChange?.(input.checked);
	});

	return {
		element,
		input,
		setChecked: (checked) => {
			input.checked = checked;
		},
		setIndeterminate: (indeterminate) => {
			input.indeterminate = indeterminate;
		},
	};
}
