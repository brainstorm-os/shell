/**
 * Compose / edit form. Used both by `intent.compose` (the Notes `/task`
 * slash path) and by the "Edit…" row action — same fields, same chrome,
 * different submit verb. Returns the body + footer nodes and a `read()`
 * so the app owns mount + persist; this stays presentational.
 *
 * In edit mode the form prefills from the passed-in `task` and surfaces
 * the scalar editable fields (priority, scheduled, due) so the user
 * isn't bounced through 4 chip menus for a multi-field change. Rich
 * notes are NOT a form field — since 9.14.6 they live in the task's
 * universal-body Y.Doc, edited in the inspector; a plain-text textarea
 * here would write a competing string and reintroduce the data-loss
 * limbo the body migration exists to avoid. Recurrence stays read-only
 * (no builder yet — change via the row's recurrence chip).
 */

import { openCalendarPopover } from "@brainstorm-os/sdk/calendar";
import { type SelectMenuHandle, createSelectMenu } from "@brainstorm-os/sdk/select-menu";
import { t } from "../i18n/t";
import type { Project } from "../types/project";
import { PRIORITIES, Priority, type Task } from "../types/task";
import { formatDateRelative } from "./format-date";

export type ComposeFormParts = {
	body: HTMLElement;
	footer: HTMLElement;
	/** Focus the name field — called by the host after the popover mounts. */
	focus(): void;
	/** Trimmed form values. Empty name → caller should treat submit as a
	 *  no-op (matches the original compose contract). */
	read(): ComposeFormValue;
};

export type ComposeFormValue = {
	name: string;
	projectId: string | null;
	priority: Priority;
	scheduledAt: number | null;
	dueAt: number | null;
};

export type ComposeFormMode =
	| { kind: "create"; defaultProjectId: string | null; defaultScheduledAt?: number | null }
	| { kind: "edit"; task: Task };

export type ComposeFormOptions = {
	mode: ComposeFormMode;
	projects: readonly Project[];
	onSubmit(): void;
	onCancel(): void;
	/** Create-mode only: returns true when an active task already carries the
	 *  given (trimmed) name, so the form can warn before stacking a duplicate
	 *  (F-045). Non-blocking — the user can still create it. */
	isDuplicateName?(name: string): boolean;
};

const PRIORITY_LABEL_KEYS: Record<Priority, string> = {
	[Priority.None]: "tasks.priority.none",
	[Priority.Low]: "tasks.priority.low",
	[Priority.Medium]: "tasks.priority.medium",
	[Priority.High]: "tasks.priority.high",
	[Priority.Critical]: "tasks.priority.critical",
};

export function buildComposeForm(options: ComposeFormOptions): ComposeFormParts {
	const seed = seedValues(options.mode);

	const body = document.createElement("form");
	body.className = "tasks-compose";
	body.addEventListener("submit", (event) => {
		event.preventDefault();
		options.onSubmit();
	});

	const nameInput = labeledInput({
		labelKey: "tasks.compose.name.label",
		placeholderKey: "tasks.compose.name.placeholder",
		value: seed.name,
	});
	body.appendChild(nameInput.label);

	const { isDuplicateName } = options;
	if (options.mode.kind === "create" && isDuplicateName) {
		const hint = document.createElement("p");
		hint.className = "tasks-compose__hint";
		hint.hidden = true;
		hint.textContent = t("tasks.compose.duplicate.hint");
		body.appendChild(hint);
		const refresh = (): void => {
			hint.hidden = !isDuplicateName(nameInput.input.value.trim());
		};
		nameInput.input.addEventListener("input", refresh);
	}

	let projectSelect: SelectMenuHandle | null = null;
	if (options.projects.length > 0) {
		const { label, handle } = projectSelectControl(options.projects, seed.projectId);
		projectSelect = handle;
		body.appendChild(label);
	}

	const prioritySelect = prioritySelectControl(seed.priority);
	body.appendChild(prioritySelect.label);

	const scheduledInput = dateTriggerControl({
		labelKey: "tasks.compose.scheduled.label",
		value: seed.scheduledAt,
	});
	const dueInput = dateTriggerControl({
		labelKey: "tasks.compose.due.label",
		value: seed.dueAt,
	});
	const dateRow = document.createElement("div");
	dateRow.className = "tasks-compose__row";
	dateRow.appendChild(scheduledInput.label);
	dateRow.appendChild(dueInput.label);
	body.appendChild(dateRow);

	const footer = document.createElement("div");
	footer.className = "tasks-compose__actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "bs-btn bs-btn--neutral";
	cancel.textContent = t("tasks.compose.cancel");
	cancel.addEventListener("click", () => options.onCancel());
	const submit = document.createElement("button");
	submit.type = "button";
	submit.className = "bs-btn";
	submit.dataset.bsPrimary = "";
	submit.textContent =
		options.mode.kind === "create" ? t("tasks.compose.create") : t("tasks.compose.save");
	submit.addEventListener("click", () => options.onSubmit());
	footer.append(cancel, submit);

	return {
		body,
		footer,
		focus() {
			nameInput.input.focus();
			if (options.mode.kind === "edit") nameInput.input.select();
		},
		read() {
			return {
				name: nameInput.input.value.trim(),
				projectId: projectSelect?.getValue() || null,
				priority: prioritySelect.read(),
				scheduledAt: scheduledInput.read(),
				dueAt: dueInput.read(),
			};
		},
	};
}

function seedValues(mode: ComposeFormMode): ComposeFormValue {
	if (mode.kind === "create") {
		return {
			name: "",
			projectId: mode.defaultProjectId,
			priority: Priority.None,
			scheduledAt: mode.defaultScheduledAt ?? null,
			dueAt: null,
		};
	}
	const { task } = mode;
	return {
		name: task.name,
		projectId: task.projectId,
		priority: task.priority,
		scheduledAt: task.scheduledAt,
		dueAt: task.dueAt,
	};
}

function labeledInput(opts: {
	labelKey: string;
	placeholderKey: string;
	value: string;
}): { label: HTMLLabelElement; input: HTMLInputElement } {
	const label = document.createElement("label");
	label.className = "tasks-compose__label";
	label.textContent = t(opts.labelKey);
	const input = document.createElement("input");
	input.type = "text";
	input.className = "tasks-compose__input";
	input.autocomplete = "off";
	input.spellcheck = false;
	input.placeholder = t(opts.placeholderKey);
	input.value = opts.value;
	label.appendChild(input);
	return { label, input };
}

function projectSelectControl(
	projects: readonly Project[],
	value: string | null,
): { label: HTMLLabelElement; handle: SelectMenuHandle } {
	const label = document.createElement("label");
	label.className = "tasks-compose__label";
	label.textContent = t("tasks.quickLook.field.project");
	const handle = createSelectMenu({
		options: [
			{ value: "", label: t("tasks.row.menu.project.inbox") },
			...projects.map((project) => ({ value: project.id, label: project.name })),
		],
		value: value ?? "",
		ariaLabel: t("tasks.quickLook.field.project"),
		className: "tasks-compose__control",
		onChange: () => undefined,
	});
	label.appendChild(handle.element);
	return { label, handle };
}

function prioritySelectControl(value: Priority): {
	label: HTMLLabelElement;
	read(): Priority;
} {
	const label = document.createElement("label");
	label.className = "tasks-compose__label";
	label.textContent = t("tasks.compose.priority.label");
	const handle = createSelectMenu<Priority>({
		options: PRIORITIES.map((priority) => ({
			value: priority,
			label: t(PRIORITY_LABEL_KEYS[priority]),
		})),
		value,
		ariaLabel: t("tasks.compose.priority.label"),
		className: "tasks-compose__control",
		onChange: () => undefined,
	});
	label.appendChild(handle.element);
	return {
		label,
		read: () => handle.getValue() ?? Priority.None,
	};
}

/** A themed single-date picker that pops the shared
 *  `@brainstorm-os/sdk/calendar` `openCalendarPopover` instead of a native
 *  `<input type="date">` — consistent with every other date surface in the
 *  product (the inline row date chip, Journal "go to date"). The chosen
 *  value lives in a closure; `read()` returns the epoch (local midnight) or
 *  null. */
function dateTriggerControl(opts: { labelKey: string; value: number | null }): {
	label: HTMLDivElement;
	read(): number | null;
} {
	let value = opts.value;

	const label = document.createElement("div");
	label.className = "tasks-compose__label";
	const caption = document.createElement("span");
	caption.textContent = t(opts.labelKey);
	label.appendChild(caption);

	const trigger = document.createElement("button");
	trigger.type = "button";
	trigger.className = "tasks-compose__date-trigger";

	const text = document.createElement("span");
	text.className = "tasks-compose__date-text";

	const clear = document.createElement("button");
	clear.type = "button";
	clear.className = "tasks-compose__date-clear";
	clear.textContent = "×";
	clear.setAttribute("aria-label", t("tasks.compose.date.clear"));

	const render = (): void => {
		text.textContent =
			value === null ? t("tasks.compose.date.empty") : formatDateRelative(value, Date.now());
		text.dataset.empty = String(value === null);
		clear.hidden = value === null;
	};
	render();

	trigger.addEventListener("click", () => {
		openCalendarPopover({
			anchor: { element: trigger },
			ariaLabel: t(opts.labelKey),
			labels: {
				today: t("tasks.date.today"),
				prev: t("tasks.row.date.prevMonth"),
				next: t("tasks.row.date.nextMonth"),
			},
			valueMs: value,
			viewMs: value ?? Date.now(),
			todayMs: Date.now(),
			onSelect: (ms) => {
				value = ms;
				render();
			},
		});
	});
	clear.addEventListener("click", (event) => {
		event.stopPropagation();
		value = null;
		render();
	});

	trigger.append(text, clear);
	label.appendChild(trigger);
	return { label, read: () => value };
}
