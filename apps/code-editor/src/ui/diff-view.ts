/**
 * Diff view (9.7.7) — a centred overlay showing the open file's current
 * buffer against its last-saved baseline, in unified or side-by-side mode.
 * The change-marker gutter (`ui/code-pane.ts`) flags lines inline; this is
 * the full review surface the user opens to read the changes together.
 *
 * Mode is the caller's persisted preference (the object menu picks it, like
 * word-wrap + syntax-theme). The overlay itself carries only a title + close
 * affordance — no bespoke menu chrome. Pure DOM (no app state) so it's
 * jsdom-testable; the rows come from the pure `logic/diff-rows` core.
 */

import { IconName, createIconElement } from "@brainstorm-os/sdk/icon";
import { type DiffRow, DiffRowKind, buildDiffRows, diffStats } from "../logic/diff-rows";

export enum DiffViewMode {
	SideBySide = "side-by-side",
	Unified = "unified",
}

export type DiffViewLabels = {
	title: (name: string) => string;
	close: string;
	stats: (params: { added: string; removed: string }) => string;
	noChanges: string;
	baseColumn: string;
	nextColumn: string;
};

export type DiffViewOptions = {
	fileName: string;
	baseline: string;
	current: string;
	mode: DiffViewMode;
	mount: HTMLElement;
	labels: DiffViewLabels;
	/** Fired once when the overlay tears down (close button, backdrop, Escape,
	 *  or `controller.close()`) so the caller can drop its handle. */
	onClose?: () => void;
};

export type DiffViewController = {
	close(): void;
};

const ROW_CLASS: Readonly<Record<DiffRowKind, string>> = Object.freeze({
	[DiffRowKind.Context]: "editor__diff-row--context",
	[DiffRowKind.Added]: "editor__diff-row--added",
	[DiffRowKind.Removed]: "editor__diff-row--removed",
});

function gutterCell(value: number | null): HTMLElement {
	const cell = document.createElement("span");
	cell.className = "editor__diff-gutter";
	cell.setAttribute("aria-hidden", "true");
	cell.textContent = value === null ? "" : String(value);
	return cell;
}

function textCell(text: string): HTMLElement {
	const cell = document.createElement("span");
	cell.className = "editor__diff-text";
	// Render whitespace faithfully; empty lines still occupy a row height.
	cell.textContent = text.length === 0 ? " " : text;
	return cell;
}

/** A unified row: base# · next# · text, classed by change kind. */
function unifiedRow(row: DiffRow): HTMLElement {
	const el = document.createElement("div");
	el.className = `editor__diff-row ${ROW_CLASS[row.kind]}`;
	el.append(gutterCell(row.baseLine), gutterCell(row.nextLine), textCell(row.text));
	return el;
}

/** A side-by-side row: base cell on the left, next cell on the right. A
 *  removed row leaves the right blank; an added row leaves the left blank;
 *  context fills both. */
function sideBySideRow(row: DiffRow): HTMLElement {
	const el = document.createElement("div");
	el.className = `editor__diff-row ${ROW_CLASS[row.kind]}`;

	const left = document.createElement("span");
	left.className = "editor__diff-side editor__diff-side--base";
	const right = document.createElement("span");
	right.className = "editor__diff-side editor__diff-side--next";

	if (row.kind === DiffRowKind.Added) {
		left.append(gutterCell(null), textCell(""));
		left.classList.add("editor__diff-side--empty");
		right.append(gutterCell(row.nextLine), textCell(row.text));
	} else if (row.kind === DiffRowKind.Removed) {
		left.append(gutterCell(row.baseLine), textCell(row.text));
		right.append(gutterCell(null), textCell(""));
		right.classList.add("editor__diff-side--empty");
	} else {
		left.append(gutterCell(row.baseLine), textCell(row.text));
		right.append(gutterCell(row.nextLine), textCell(row.text));
	}
	el.append(left, right);
	return el;
}

export function openDiffView(opts: DiffViewOptions): DiffViewController {
	const { labels } = opts;
	const rows = buildDiffRows(opts.baseline, opts.current);
	const { added, removed } = diffStats(rows);

	const overlay = document.createElement("div");
	overlay.className = "editor__diff-overlay";

	const panel = document.createElement("div");
	panel.className = "editor__diff glass--strong";
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-modal", "true");
	panel.setAttribute("aria-label", labels.title(opts.fileName));

	const head = document.createElement("div");
	head.className = "editor__diff-head";
	const title = document.createElement("span");
	title.className = "editor__diff-title";
	title.textContent = labels.title(opts.fileName);
	const stats = document.createElement("span");
	stats.className = "editor__diff-stats";
	stats.textContent = labels.stats({ added: String(added), removed: String(removed) });
	const closeBtn = document.createElement("button");
	closeBtn.type = "button";
	closeBtn.className = "editor__diff-close";
	closeBtn.setAttribute("aria-label", labels.close);
	closeBtn.appendChild(createIconElement(IconName.Close, { size: 16 }));
	head.append(title, stats, closeBtn);

	const body = document.createElement("div");
	body.className = `editor__diff-body editor__diff-body--${opts.mode}`;

	if (rows.length === 0 || (added === 0 && removed === 0)) {
		const empty = document.createElement("div");
		empty.className = "editor__diff-empty";
		empty.textContent = labels.noChanges;
		body.appendChild(empty);
	} else if (opts.mode === DiffViewMode.Unified) {
		body.append(...rows.map(unifiedRow));
	} else {
		const columns = document.createElement("div");
		columns.className = "editor__diff-columns";
		const baseHead = document.createElement("div");
		baseHead.className = "editor__diff-colhead";
		baseHead.textContent = labels.baseColumn;
		const nextHead = document.createElement("div");
		nextHead.className = "editor__diff-colhead";
		nextHead.textContent = labels.nextColumn;
		columns.append(baseHead, nextHead);
		body.appendChild(columns);
		body.append(...rows.map(sideBySideRow));
	}

	panel.append(head, body);
	overlay.appendChild(panel);
	opts.mount.appendChild(overlay);

	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		overlay.removeEventListener("keydown", onKeydown);
		overlay.remove();
		opts.onClose?.();
	};

	// Escape closes; it isn't an editable surface, so a local handler is fine
	// (the diff body carries no input the shortcut layer would own).
	function onKeydown(event: KeyboardEvent): void {
		// keyboard-exempt
		if (event.key === "Escape") {
			event.preventDefault();
			close();
		}
	}
	overlay.addEventListener("keydown", onKeydown);
	overlay.addEventListener("mousedown", (event) => {
		if (event.target === overlay) close();
	});
	closeBtn.addEventListener("click", close);

	panel.tabIndex = -1;
	panel.focus();

	return { close };
}
