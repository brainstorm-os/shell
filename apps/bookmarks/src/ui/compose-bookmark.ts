/**
 * Add-bookmark + edit-tags surfaces, rendered through the shared
 * `@brainstorm-os/sdk/popover` glass chrome (no bespoke dialog markup).
 * The URL normalize / dedupe / tag-normalize policy lives in
 * `logic/compose.ts` — these functions are the form shell + validation
 * feedback only.
 */

import { createCheckbox } from "@brainstorm-os/sdk/checkbox";
import { PopoverBodyPadding, PopoverSize, createPopoverElement } from "@brainstorm-os/sdk/popover";
import { t } from "../i18n/manifest";
import { ComposeError, applyTagEdit, composeBookmark } from "../logic/compose";
import type { Bookmark } from "../types/bookmark";

type Field = {
	row: HTMLElement;
	input: HTMLInputElement | HTMLTextAreaElement;
};

function field(
	labelKey: Parameters<typeof t>[0],
	placeholderKey: Parameters<typeof t>[0],
	multiline = false,
): Field {
	const row = document.createElement("label");
	row.className = "bookmarks__form-row";
	const label = document.createElement("span");
	label.className = "bookmarks__form-label";
	label.textContent = t(labelKey);
	const input = multiline ? document.createElement("textarea") : document.createElement("input");
	input.className = "bookmarks__form-input";
	input.placeholder = t(placeholderKey);
	if (input instanceof HTMLInputElement) input.type = "text";
	row.append(label, input);
	return { row, input };
}

function errorLine(): HTMLParagraphElement {
	const p = document.createElement("p");
	p.className = "bookmarks__form-error";
	p.setAttribute("role", "alert");
	p.hidden = true;
	return p;
}

function footer(
	submitLabel: string,
	cancelLabel: string,
): {
	el: HTMLElement;
	submit: HTMLButtonElement;
	cancel: HTMLButtonElement;
} {
	const el = document.createElement("div");
	el.className = "bookmarks__form-footer";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "bs-btn bs-btn--secondary";
	cancel.textContent = cancelLabel;
	const submit = document.createElement("button");
	submit.type = "submit";
	submit.className = "bs-btn";
	submit.dataset.bsPrimary = "";
	submit.textContent = submitLabel;
	el.append(cancel, submit);
	return { el, submit, cancel };
}

export type ComposeBookmarkOptions = {
	existing: readonly Bookmark[];
	idFactory: () => string;
	now: () => number;
	/** Initial state of the "Download page content" checkbox — the per-vault
	 *  default (9.18.5). Defaults to checked when omitted. */
	downloadContentDefault?: boolean;
	onSave: (bookmark: Bookmark, opts: { downloadContent: boolean }) => void;
};

/** Open the add-bookmark popover. Resolves nothing — `onSave` is the
 *  side-effecting path; the popover self-closes on success or Escape. */
export function openComposeBookmark(options: ComposeBookmarkOptions): void {
	const form = document.createElement("form");
	form.className = "bookmarks__form";
	form.noValidate = true;

	const url = field("compose.url.label", "compose.url.placeholder");
	url.input.setAttribute("inputmode", "url");
	const title = field("compose.title.label", "compose.title.placeholder");
	const description = field("compose.description.label", "compose.description.placeholder", true);
	const tags = field("compose.tags.label", "compose.tags.placeholder");

	// "Download page content" — when checked, the readable page body is
	// captured into the bookmark on save (offline reading); when off, only the
	// metadata properties are kept. The initial state is the per-vault default
	// (9.18.5) — on unless the vault opted out. The shared SDK checkbox keeps
	// it visually identical to the shell's.
	const download = createCheckbox({
		label: t("compose.downloadContent"),
		checked: options.downloadContentDefault ?? true,
	});

	const error = errorLine();
	const foot = footer(t("compose.submit"), t("compose.cancel"));

	form.append(url.row, title.row, description.row, tags.row, download.element, error);

	const handle = createPopoverElement({
		title: t("compose.title"),
		body: form,
		footer: foot.el,
		size: PopoverSize.Medium,
		bodyPadding: PopoverBodyPadding.Comfortable,
		onClose: () => handle.close(),
	});

	const close = (): void => handle.close();
	foot.cancel.addEventListener("click", close);

	const submit = (): void => {
		const result = composeBookmark(
			{
				url: url.input.value,
				title: title.input.value,
				description: description.input.value,
				tags: tags.input.value,
			},
			options.existing,
			{ idFactory: options.idFactory, now: options.now },
		);
		if (!result.ok) {
			error.hidden = false;
			error.textContent =
				result.error === ComposeError.Duplicate
					? t("compose.error.duplicate")
					: t("compose.error.invalidUrl");
			url.input.focus();
			return;
		}
		options.onSave(result.bookmark, { downloadContent: download.input.checked });
		close();
	};

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		submit();
	});
	foot.submit.addEventListener("click", (e) => {
		e.preventDefault();
		submit();
	});

	queueMicrotask(() => url.input.focus());
}

export type EditTagsOptions = {
	bookmark: Bookmark;
	now: () => number;
	onSave: (bookmark: Bookmark) => void;
};

/** Open the edit-tags popover for a single bookmark. */
export function openEditTags(options: EditTagsOptions): void {
	const form = document.createElement("form");
	form.className = "bookmarks__form";
	form.noValidate = true;

	const tags = field("tags.label", "tags.placeholder");
	tags.input.value = options.bookmark.tags.join(", ");
	const foot = footer(t("tags.submit"), t("tags.cancel"));
	form.append(tags.row);

	const handle = createPopoverElement({
		title: t("tags.title"),
		body: form,
		footer: foot.el,
		size: PopoverSize.Small,
		bodyPadding: PopoverBodyPadding.Comfortable,
		onClose: () => handle.close(),
	});

	const close = (): void => handle.close();
	foot.cancel.addEventListener("click", close);

	const submit = (): void => {
		options.onSave(applyTagEdit(options.bookmark, tags.input.value, options.now));
		close();
	};
	form.addEventListener("submit", (e) => {
		e.preventDefault();
		submit();
	});
	foot.submit.addEventListener("click", (e) => {
		e.preventDefault();
		submit();
	});

	queueMicrotask(() => tags.input.focus());
}
