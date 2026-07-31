/**
 * The one rename dialog (9.7.12). A `.bs-popover` carrying a single
 * `.bs-input`, an inline `role="alert"` error, and a Cancel / Save pair —
 * shared by the file rename (F-238) and the folder rename, which is the same
 * question asked of a path prefix. Extracted the moment there were two
 * callers, per the DRY rule; the caller supplies only the copy and the
 * validating submit.
 */

import { PopoverSize, createPopoverElement } from "@brainstorm-os/sdk/popover";

/** Which question the dialog asks. Renaming something that already exists, or
 *  naming something that was just created — the flow and the validation are
 *  identical, only the title and the confirm label differ. A create arriving
 *  under a "Rename new-folder" title is the bug this replaces. */
export enum NameMode {
	Rename = "rename",
	Create = "create",
}

export interface RenamePopoverParams {
	title: string;
	/** Pre-filled path. */
	value: string;
	inputLabel: string;
	cancelLabel: string;
	saveLabel: string;
	testId: string;
	/** Chars of `value` to pre-select — the stem, so the extension survives a
	 *  straight retype. Defaults to the whole value. */
	selectTo?: number;
	/** Accept (return `null`) or reject with the message to show inline. */
	submit: (typed: string) => string | null;
}

export function openRenamePopover(params: RenamePopoverParams): void {
	const field = document.createElement("form");
	field.className = "editor__rename-field";
	const input = document.createElement("input");
	input.type = "text";
	input.className = "bs-input editor__rename-input";
	input.value = params.value;
	input.setAttribute("aria-label", params.inputLabel);
	const error = document.createElement("div");
	error.className = "editor__rename-error";
	error.id = "code-rename-error";
	error.setAttribute("role", "alert");
	error.hidden = true;
	input.setAttribute("aria-describedby", error.id);
	field.append(input, error);

	const actions = document.createElement("div");
	actions.className = "editor__rename-actions";
	const cancelBtn = document.createElement("button");
	cancelBtn.type = "button";
	cancelBtn.className = "bs-btn bs-btn--ghost";
	cancelBtn.textContent = params.cancelLabel;
	const saveBtn = document.createElement("button");
	saveBtn.type = "button";
	saveBtn.className = "bs-btn";
	saveBtn.dataset.bsPrimary = "";
	saveBtn.textContent = params.saveLabel;
	actions.append(cancelBtn, saveBtn);

	const handle = createPopoverElement({
		title: params.title,
		body: field,
		footer: actions,
		size: PopoverSize.Small,
		// One field + one error line: without this the Small variant's 220px
		// floor left ~120px of dead panel between the input and the footer.
		fitContent: true,
		testId: params.testId,
		onClose: () => handle.close(),
	});

	const submit = (): void => {
		const message = params.submit(input.value);
		if (message !== null) {
			error.textContent = message;
			error.hidden = false;
			input.setAttribute("aria-invalid", "true");
			input.focus();
			input.select();
			return;
		}
		handle.close();
	};
	cancelBtn.addEventListener("click", () => handle.close());
	saveBtn.addEventListener("click", submit);
	field.addEventListener("submit", (event) => {
		event.preventDefault();
		submit();
	});
	input.focus();
	input.setSelectionRange(0, params.selectTo ?? params.value.length);
}
