/**
 * Layers panel chrome (9.17.13, rebuilt for F-197).
 *
 * The panel is a right-edge glass overlay floating above the canvas (per
 * the right-panel rule — never a reserved layout track). It mounts hidden
 * and renders nothing until opened; once open it always shows the shared
 * panel header (44px, 1px subtle bottom border — the cross-app baseline),
 * a close affordance, and either the layer rows or an explicit empty
 * state. The header + list shell are built ONCE so the close button keeps
 * its DOM identity (and focus) across the per-paint row refreshes; only
 * the rows are replaced.
 *
 * Extracted from `app.ts` so the open/closed contract and the row
 * rendering are jsdom-tested without booting the canvas app.
 */

import { EmptyStateTone, createEmptyState } from "@brainstorm-os/sdk/empty-state";
import { IconName } from "@brainstorm-os/sdk/icon";
import type { TranslationParams, WhiteboardMessageKey } from "../i18n/t";
import type { LayerRow } from "../logic/layer-list";
import { WhiteboardIcon, createIcon } from "./icons";

/** Structural fingerprint of the rows + selection — `renderRows` runs on every
 *  canvas repaint (it's in the paint loop), so we rebuild the DOM only when this
 *  changes, not 60×/sec. Covers everything the rows render off. */
function rowsSignature(rows: readonly LayerRow[], selectedIds: ReadonlySet<string>): string {
	const sel = [...selectedIds].sort().join(",");
	const body = rows
		.map((r) => `${r.id}${r.hidden ? 1 : 0}${r.locked ? 1 : 0}${r.kind}${r.snippet}`)
		.join("");
	return `${sel}${body}`;
}

export type LayersPanelT = (key: WhiteboardMessageKey, params?: TranslationParams) => string;

export type LayersPanelOptions = {
	t: LayersPanelT;
	/** The close affordance was activated (the toggle button mirrors it). */
	onClose(): void;
	/** Toggle a row's hidden flag. */
	onToggleHidden(id: string): void;
	/** Select the row's node on the canvas. */
	onSelectNode(id: string): void;
};

export type LayersPanelHandle = {
	element: HTMLElement;
	isOpen(): boolean;
	setOpen(open: boolean): void;
	/** Replace the rows (no-op while closed — the panel renders nothing
	 *  until it is actually open). */
	renderRows(rows: readonly LayerRow[], selectedIds: ReadonlySet<string>): void;
};

export function createLayersPanel(options: LayersPanelOptions): LayersPanelHandle {
	const { t } = options;
	let open = false;

	const panel = document.createElement("aside");
	panel.className = "whiteboard__layers glass--strong";
	panel.setAttribute("aria-label", t("whiteboard.layers.region"));
	panel.hidden = true;

	const head = document.createElement("div");
	head.className = "whiteboard__layers-head";
	const title = document.createElement("h2");
	title.className = "whiteboard__layers-title";
	title.textContent = t("whiteboard.layers.title");
	const close = document.createElement("button");
	close.type = "button";
	close.className = "whiteboard__layers-close";
	close.dataset.bsTooltip = t("whiteboard.layers.close");
	close.setAttribute("aria-label", t("whiteboard.layers.close"));
	close.appendChild(createIcon(WhiteboardIcon.Close, { size: 14 }));
	close.addEventListener("click", () => options.onClose());
	head.append(title, close);

	const list = document.createElement("ul");
	list.className = "whiteboard__layers-list";

	panel.append(head, list);

	// The last-painted fingerprint; cleared on close so re-opening always paints.
	let lastSig: string | null = null;

	const renderRows = (rows: readonly LayerRow[], selectedIds: ReadonlySet<string>): void => {
		if (!open) return;
		const sig = rowsSignature(rows, selectedIds);
		if (sig === lastSig) return;
		lastSig = sig;
		if (rows.length === 0) {
			const empty = document.createElement("li");
			empty.className = "whiteboard__layers-empty";
			empty.appendChild(
				createEmptyState({
					icon: IconName.Entity,
					title: t("whiteboard.layers.empty"),
					tone: EmptyStateTone.Compact,
				}),
			);
			list.replaceChildren(empty);
			return;
		}
		const items = rows.map((row) => {
			const item = document.createElement("li");
			item.className = "whiteboard__layer";
			item.dataset.nodeId = row.id;
			if (selectedIds.has(row.id)) item.dataset.selected = "true";
			if (row.hidden) item.dataset.hidden = "true";

			const vis = document.createElement("button");
			vis.type = "button";
			vis.className = "whiteboard__layer-vis";
			vis.dataset.hidden = String(row.hidden);
			vis.setAttribute(
				"aria-label",
				row.hidden ? t("whiteboard.layers.show") : t("whiteboard.layers.hide"),
			);
			vis.addEventListener("click", (e) => {
				e.stopPropagation();
				options.onToggleHidden(row.id);
			});

			const label = document.createElement("button");
			label.type = "button";
			label.className = "whiteboard__layer-label";
			const kindText = t(`whiteboard.layer.kind.${row.kind}`);
			label.textContent = row.snippet.length > 0 ? row.snippet : kindText;
			label.title = kindText;
			if (row.locked) label.dataset.locked = "true";
			label.addEventListener("click", () => options.onSelectNode(row.id));

			item.append(vis, label);
			return item;
		});
		list.replaceChildren(...items);
	};

	return {
		element: panel,
		isOpen: () => open,
		setOpen: (next: boolean) => {
			open = next;
			panel.hidden = !next;
			if (!next) {
				lastSig = null;
				list.replaceChildren();
			}
		},
		renderRows,
	};
}
