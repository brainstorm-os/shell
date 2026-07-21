/**
 * Source picker — chooses *which objects* a List shows.
 *
 * A List's membership is driven by its `ListSource` (see
 * `logic/evaluate-source.ts`). The common, discoverable case is
 * `ByType` — "show me my Tasks", "show me Notes + Bookmarks". Before this
 * picker a freshly-created List had `source: null` and rendered nothing
 * with no way to fix it; this is the UI that lets the user pick the object
 * types (and so makes "New list" actually produce a populated list).
 *
 * Two entry points share `buildTypeChecklist`:
 *   - `openSourcePicker` — a modal popover with a confirm step, used by the
 *     "New list" flow (nothing exists yet, so the user commits a choice).
 *   - the inline "Shown objects" section inside the view-settings popover,
 *     which live-applies each toggle against the active List.
 *
 * Plain-DOM dropdown per the [[avoid-blocking-on-deps]] memory; chrome
 * mirrors `view-settings.ts` (`.db-popover`).
 */

import { IconName } from "@brainstorm-os/sdk/icon";
import { matchesChord } from "@brainstorm-os/sdk/shortcut";
import { setSharedIcon } from "./icons";

export type SourceTypeOption = {
	/** Raw entity `type` id, e.g. `brainstorm/Task/v1`. */
	type: string;
	/** Human label, e.g. `Tasks`. */
	label: string;
	/** Live count of non-deleted entities of this type in the vault. */
	count: number;
};

export type TypeChecklistOptions = {
	types: ReadonlyArray<SourceTypeOption>;
	selected: ReadonlySet<string>;
	onToggle: (type: string, checked: boolean) => void;
	/** Free-text filter applied to labels — rows that don't match are hidden. */
	filter?: string;
};

/** The scrollable `<ul>` of type rows. Shared by the modal picker and the
 *  inline settings section so the visual treatment can never drift. */
export function buildTypeChecklist(opts: TypeChecklistOptions): HTMLElement {
	const list = document.createElement("ul");
	list.className = "db-source__list";
	list.setAttribute("role", "list");

	const needle = (opts.filter ?? "").trim().toLowerCase();
	const visible = needle
		? opts.types.filter((t) => t.label.toLowerCase().includes(needle))
		: opts.types;

	if (visible.length === 0) {
		const empty = document.createElement("li");
		empty.className = "db-source__empty";
		empty.textContent = needle ? "No matching types" : "This vault has no objects yet";
		list.appendChild(empty);
		return list;
	}

	for (const option of visible) {
		const li = document.createElement("li");
		li.className = "db-source__row";

		const label = document.createElement("label");
		label.className = "db-source__option";

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.className = "db-source__check";
		checkbox.checked = opts.selected.has(option.type);
		checkbox.addEventListener("change", () => opts.onToggle(option.type, checkbox.checked));

		const name = document.createElement("span");
		name.className = "db-source__name";
		name.textContent = option.label;

		const count = document.createElement("span");
		count.className = "db-source__count";
		count.textContent = String(option.count);

		label.append(checkbox, name, count);
		li.appendChild(label);
		list.appendChild(li);
	}

	return list;
}

export type SourcePickerProps = {
	anchor: HTMLElement;
	availableTypes: ReadonlyArray<SourceTypeOption>;
	selectedTypes: ReadonlyArray<string>;
	title: string;
	confirmLabel: string;
	onConfirm: (types: string[]) => void;
	onCancel: () => void;
};

let openPicker: HTMLElement | null = null;
let openCleanup: (() => void) | null = null;

export function closeSourcePicker(): void {
	if (openCleanup) openCleanup();
	openCleanup = null;
	openPicker?.remove();
	openPicker = null;
}

export function openSourcePicker(props: SourcePickerProps): void {
	closeSourcePicker();

	const selected = new Set(props.selectedTypes);
	let filter = "";

	const backdrop = document.createElement("div");
	backdrop.className = "db-popover__backdrop";
	const popover = document.createElement("div");
	popover.className = "db-popover db-source glass--strong";
	popover.setAttribute("role", "dialog");
	popover.setAttribute("aria-label", props.title);

	const header = document.createElement("header");
	header.className = "db-popover__header";
	const titleEl = document.createElement("h3");
	titleEl.className = "db-popover__title";
	titleEl.textContent = props.title;
	header.appendChild(titleEl);
	const close = document.createElement("button");
	close.type = "button";
	close.className = "db-popover__close";
	close.setAttribute("aria-label", "Cancel");
	setSharedIcon(close, IconName.Close);
	close.addEventListener("click", () => props.onCancel());
	header.appendChild(close);
	popover.appendChild(header);

	const body = document.createElement("div");
	body.className = "db-popover__body";

	// Search only earns its space past a handful of types.
	const showSearch = props.availableTypes.length > 8;
	let searchInput: HTMLInputElement | null = null;
	if (showSearch) {
		searchInput = document.createElement("input");
		searchInput.type = "search";
		searchInput.className = "db-popover__input db-source__search";
		searchInput.placeholder = "Filter object types…";
		searchInput.setAttribute("aria-label", "Filter object types");
		body.appendChild(searchInput);
	}

	const listHost = document.createElement("div");
	listHost.className = "db-source__list-host";
	body.appendChild(listHost);

	const confirm = document.createElement("button");

	const repaintList = (): void => {
		listHost.replaceChildren(
			buildTypeChecklist({
				types: props.availableTypes,
				selected,
				filter,
				onToggle: (type, checked) => {
					if (checked) selected.add(type);
					else selected.delete(type);
					confirm.disabled = selected.size === 0;
					// No full repaint on toggle — the checkbox already reflects
					// its own state; repainting would steal focus from the row.
				},
			}),
		);
	};
	repaintList();

	if (searchInput) {
		searchInput.addEventListener("input", () => {
			filter = searchInput?.value ?? "";
			repaintList();
		});
	}

	popover.appendChild(body);

	const footer = document.createElement("footer");
	footer.className = "db-source__footer";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "bs-btn bs-btn--ghost";
	cancel.textContent = "Cancel";
	cancel.addEventListener("click", () => props.onCancel());
	confirm.type = "button";
	confirm.className = "bs-btn";
	confirm.dataset.bsPrimary = "";
	confirm.textContent = props.confirmLabel;
	confirm.disabled = selected.size === 0;
	confirm.addEventListener("click", () => props.onConfirm([...selected]));
	footer.append(cancel, confirm);
	popover.appendChild(footer);

	document.body.appendChild(backdrop);
	document.body.appendChild(popover);
	positionPopover(props.anchor, popover);
	(searchInput ?? confirm).focus();

	backdrop.addEventListener("click", () => props.onCancel());

	const keyListener = (event: KeyboardEvent): void => {
		if (matchesChord(event, "Escape")) {
			event.preventDefault();
			props.onCancel();
		}
	};
	// keyboard-exempt: transient plain-DOM popover; Escape matched via the shared matchesChord, listener lifecycle-scoped + removed in openCleanup (mirrors the allowlisted anchored-menu pattern).
	document.addEventListener("keydown", keyListener);

	const reposition = (): void => positionPopover(props.anchor, popover);
	window.addEventListener("resize", reposition);
	window.addEventListener("scroll", reposition, true);

	openPicker = popover;
	openCleanup = () => {
		document.removeEventListener("keydown", keyListener);
		window.removeEventListener("resize", reposition);
		window.removeEventListener("scroll", reposition, true);
		backdrop.remove();
	};
}

function positionPopover(anchor: HTMLElement, popover: HTMLElement): void {
	const rect = anchor.getBoundingClientRect();
	const margin = 8;
	const width = 320;
	popover.style.width = `${width}px`;
	const top = Math.min(rect.bottom + margin, window.innerHeight - 64);
	let left = rect.left;
	if (left < margin) left = margin;
	const maxLeft = window.innerWidth - width - margin;
	if (left > maxLeft) left = maxLeft;
	popover.style.top = `${top}px`;
	popover.style.left = `${left}px`;
}
