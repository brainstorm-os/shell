/**
 * Office documents renderer — 9.20.9.
 *
 * One renderer for the three OOXML families, dispatched on format:
 *   • DOCX → mammoth → HTML → allowlist-sanitized DOM (no innerHTML).
 *   • XLSX → SheetJS → per-sheet tables built with textContent (safe).
 *   • PPTX → fflate unzip (slides only) → per-slide text outline.
 *
 * mammoth / xlsx / fflate are the heavy bundle, reached only through the
 * registry's dynamic `import()` — off Preview's cold-start path. All
 * cell / slide text is rendered via `textContent`; DOCX HTML is the one
 * untrusted-markup path and goes through `sanitizeToFragment`.
 */

import { Orientation, SelectionAttribute, attachCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { unzipSync } from "fflate";
import * as mammoth from "mammoth";
import * as XLSX from "xlsx";
import { t } from "../i18n";
import { OfficeFormat, officeFormatFor, officeFormatLabel } from "../logic/office-format";
import { slidesFromEntries } from "../logic/pptx-text";
import { sanitizeToFragment } from "../logic/sanitize-fragment";
import { PreviewKind } from "../types/preview-kind";
import type { PreviewInstance, PreviewModule, PreviewMountContext } from "../types/preview-module";
import { sourceBytes } from "./media-source";

const SLIDE_ENTRY_RE = /^ppt\/slides\/slide\d+\.xml$/;

export const officeRenderer: PreviewModule = {
	kind: PreviewKind.Office,
	async mount(context: PreviewMountContext): Promise<PreviewInstance> {
		return await mount(context);
	},
	extractMetadata(source) {
		const format = officeFormatFor(source.mime, "");
		return format ? { Format: officeFormatLabel(format) } : {};
	},
};

async function mount(context: PreviewMountContext): Promise<PreviewInstance> {
	const { host, source, file } = context;
	host.replaceChildren();

	const format = officeFormatFor(source.mime, file.name);
	if (!format) throw new Error(t("office.unsupported"));

	const stage = document.createElement("div");
	stage.className = "preview-stage preview-stage--office";
	host.appendChild(stage);

	const bytes = await sourceBytes(source);
	const teardown: Array<() => void> = [];

	switch (format) {
		case OfficeFormat.Docx:
			await renderDocx(stage, bytes);
			break;
		case OfficeFormat.Xlsx:
			renderXlsx(stage, bytes, teardown);
			break;
		case OfficeFormat.Pptx:
			renderPptx(stage, bytes);
			break;
	}

	return {
		dispose(): void {
			for (const fn of teardown) fn();
			host.replaceChildren();
		},
	};
}

async function renderDocx(stage: HTMLElement, bytes: Uint8Array): Promise<void> {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	const { value } = await mammoth.convertToHtml({ arrayBuffer: buffer });
	const doc = document.createElement("div");
	doc.className = "preview-office-doc";
	const fragment = sanitizeToFragment(value, document);
	if (!fragment.hasChildNodes()) {
		doc.appendChild(emptyNote(t("office.emptyDoc")));
	} else {
		doc.appendChild(fragment);
	}
	stage.appendChild(doc);
}

function renderXlsx(stage: HTMLElement, bytes: Uint8Array, teardown: Array<() => void>): void {
	const wb = XLSX.read(bytes, { type: "array" });
	const names = wb.SheetNames;
	if (names.length === 0) {
		stage.appendChild(emptyNote(t("office.emptySheet")));
		return;
	}

	const tabBar = document.createElement("div");
	tabBar.className = "preview-office-tabs";
	// kbn-roles-exempt: imperative DOM tablist; the sheet tabs are focusable <button>s (Tab+Enter operable).
	tabBar.setAttribute("role", "tablist");
	tabBar.setAttribute("aria-label", t("office.sheets"));
	const tableHost = document.createElement("div");
	tableHost.className = "preview-office-sheet";

	let active = 0;
	const tabs: HTMLButtonElement[] = names.map((name, i) => {
		const tab = document.createElement("button");
		tab.type = "button";
		tab.className = "preview-office-tab";
		tab.setAttribute("role", "tab");
		tab.textContent = name;
		tab.dataset.compositeIndex = String(i);
		tab.addEventListener("click", () => select(i));
		tabBar.appendChild(tab);
		return tab;
	});

	function select(i: number): void {
		active = i;
		tabs.forEach((tab, idx) => {
			const on = idx === i;
			tab.setAttribute("aria-selected", String(on));
			tab.tabIndex = on ? 0 : -1;
		});
		const sheetName = names[i];
		const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
		tableHost.replaceChildren(sheet ? buildSheetTable(sheet) : emptyNote(t("office.emptySheet")));
	}

	if (names.length > 1) stage.appendChild(tabBar);
	stage.appendChild(tableHost);
	select(0);

	if (names.length > 1) {
		const keyboard = attachCompositeKeyboard(tabBar, {
			orientation: Orientation.Horizontal,
			role: "tablist",
			selectionAttribute: SelectionAttribute.AriaSelected,
			count: () => tabs.length,
			activeIndex: () => active,
			onActiveIndexChange: select,
		});
		teardown.push(() => keyboard.destroy());
	}
}

function buildSheetTable(sheet: XLSX.WorkSheet): HTMLElement {
	const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
		header: 1,
		blankrows: false,
		defval: "",
	});
	const table = document.createElement("table");
	table.className = "preview-office-table";
	const tbody = document.createElement("tbody");
	for (const row of rows) {
		const tr = document.createElement("tr");
		for (const cell of row) {
			const td = document.createElement("td");
			td.textContent = cell === null || cell === undefined ? "" : String(cell);
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	return table;
}

function renderPptx(stage: HTMLElement, bytes: Uint8Array): void {
	// Only decompress the slide XML — never the (potentially huge / hostile)
	// embedded media, which also sidesteps a zip-bomb via images.
	const entries = unzipSync(bytes, { filter: (f) => SLIDE_ENTRY_RE.test(f.name) });
	const slides = slidesFromEntries(entries);
	if (slides.length === 0) {
		stage.appendChild(emptyNote(t("office.emptyDeck")));
		return;
	}
	const deck = document.createElement("div");
	deck.className = "preview-office-deck";
	slides.forEach((slide, i) => {
		const section = document.createElement("section");
		section.className = "preview-office-slide";
		const heading = document.createElement("h2");
		heading.className = "preview-office-slide__num";
		heading.textContent = t("office.slideNum", { num: i + 1 });
		section.appendChild(heading);
		for (const line of slide.lines) {
			const p = document.createElement("p");
			p.textContent = line;
			section.appendChild(p);
		}
		deck.appendChild(section);
	});
	stage.appendChild(deck);
}

function emptyNote(message: string): HTMLElement {
	const note = document.createElement("p");
	note.className = "preview-office-empty";
	note.textContent = message;
	return note;
}
