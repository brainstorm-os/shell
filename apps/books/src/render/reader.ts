/**
 * The minimal reflow reader for the 9.21.1.5 preview drop, with the
 * 9.21.3 typography controls. Plain-DOM, self-contained render surface
 * (allowed under the reactivity rule — it is not a vault-entity list). It
 * paints the current page's fragments, derives a chars-per-page budget
 * from the typography model × its own measured area, and re-paginates on
 * resize / typography change while keeping the reader on the same words
 * (the headline invariant). THROWAWAY: 9.21.2 replaces this with the
 * epub.js-backed renderer; the pure model under src/logic/ stays.
 */

import { PopoverBodyPadding, PopoverSize, createPopoverElement } from "@brainstorm-os/sdk/popover";
import { type ShortcutDisposer, attachShortcut } from "@brainstorm-os/sdk/shortcut";
import { type BooksI18nKey, t } from "../i18n";
import { BlockKind, type BookContent } from "../logic/content";
import {
	type HighlightPort,
	HighlightStore,
	composeHighlight,
	highlightsOnPage,
} from "../logic/highlight-store";
import { slicePage } from "../logic/page-slice";
import {
	type ReaderState,
	canGoNext,
	canGoPrev,
	createReaderState,
	currentLocator,
	currentPage,
	goToLocator,
	nextPage,
	pageCount,
	prevPage,
	readingProgress,
	repaginate,
} from "../logic/reader-state";
import { resolveSelection } from "../logic/selection-locator";
import {
	DEFAULT_TYPOGRAPHY,
	ReadingFamily,
	ReadingTheme,
	type TypographySettings,
	charsPerPageBudget,
	readerCssVars,
	serializeTypography,
	stepLeading,
	stepMeasure,
	stepSize,
	withFamily,
	withTheme,
} from "../logic/typography";
import type { Locator } from "../types/locator";
import { createHighlighterGlyph } from "../ui/icons";
import { ReaderChord, buildReaderFooter, controlButton, labelledRow, stepperRow } from "./chrome";
import {
	buildHighlightsPanel,
	buildSelectionMenu,
	paintFragment,
	readFragmentSelection,
} from "./highlights";

const FAMILY_LABELS: Record<ReadingFamily, BooksI18nKey> = {
	[ReadingFamily.System]: "typography.family.system",
	[ReadingFamily.Serif]: "typography.family.serif",
	[ReadingFamily.Sans]: "typography.family.sans",
	[ReadingFamily.Mono]: "typography.family.mono",
};

const THEME_LABELS: Record<ReadingTheme, BooksI18nKey> = {
	[ReadingTheme.Theme]: "typography.theme.app",
	[ReadingTheme.Light]: "typography.theme.light",
	[ReadingTheme.Sepia]: "typography.theme.sepia",
	[ReadingTheme.Dark]: "typography.theme.dark",
};

const FAMILY_ORDER: readonly ReadingFamily[] = [
	ReadingFamily.System,
	ReadingFamily.Serif,
	ReadingFamily.Sans,
	ReadingFamily.Mono,
];

const THEME_ORDER: readonly ReadingTheme[] = [
	ReadingTheme.Theme,
	ReadingTheme.Light,
	ReadingTheme.Sepia,
	ReadingTheme.Dark,
];

export type ReaderHandle = {
	dispose: () => void;
	/** Pure access for tests / future per-book persistence wiring. */
	typography: () => TypographySettings;
	/** The current parked reading locator — pure access for tests + the
	 *  per-book persistence wiring. `null` only when the book is empty. */
	position: () => Locator | null;
	/** The live highlight store — pure access for tests + future wiring. */
	highlights: () => HighlightStore;
	/** Jump to the page holding `locator` — the TOC navigation seam. */
	goTo: (locator: Locator) => void;
};

/** Called when the typography changes — the per-book persistence seam.
 *  9.21.6 wires this to a `Book/v1` property write; the preview leaves it
 *  unset. Receives the serialized blob (the persisted wire form). */
export type ReaderOptions = {
	initialTypography?: TypographySettings;
	onTypographyChange?: (serialized: string, settings: TypographySettings) => void;
	/** Where the book was last parked (9.21.6). The reader restores to the
	 *  page holding this locator on mount, so reopening returns to where you
	 *  stopped. `null`/absent starts at the beginning. */
	initialPosition?: Locator | null;
	/** The per-book reading-position persistence seam (9.21.6). Fired on
	 *  every navigation with the current locator + measured progress (0..1);
	 *  the host advances the `Book/v1` via `withReadingPosition` and writes
	 *  it. The preview drop leaves it unset (in-memory only). Mirrors
	 *  `onTypographyChange`. */
	onPositionChange?: (locator: Locator, progress: number) => void;
	/** The book whose highlights these are — the `Highlight/v1.bookId`. */
	bookId?: string;
	/** The highlight persistence seam. 9.21.6 wires these to `Highlight/v1`
	 *  entity writes; the preview drop runs in-memory only. */
	highlightPort?: HighlightPort;
	/** Mint a stable id for a new highlight. Defaults to a random id;
	 *  injectable so tests are deterministic. */
	newHighlightId?: () => string;
	/** Clock seam — defaults to `Date.now`. */
	now?: () => number;
};

export function mountReader(
	root: HTMLElement,
	controlsHost: HTMLElement,
	content: BookContent,
	options: ReaderOptions = {},
): ReaderHandle {
	root.replaceChildren();
	controlsHost.replaceChildren();

	const typeBtn = controlButton("bs-panel-toggle books__type-btn", t("typography.open"), "Aa");
	typeBtn.setAttribute("aria-haspopup", "dialog");
	const highlightsBtn = controlButton(
		"bs-panel-toggle books__hl-btn",
		t("highlight.panel.open"),
		"",
	);
	highlightsBtn.replaceChildren(createHighlighterGlyph());
	highlightsBtn.setAttribute("aria-haspopup", "dialog");
	controlsHost.append(typeBtn, highlightsBtn);

	const page = document.createElement("article");
	page.className = "books__page";
	page.setAttribute("role", "document");

	const { footer, prev, next, status, progress } = buildReaderFooter();

	const stage = document.createElement("div");
	stage.className = "books__stage";
	stage.append(page);

	root.append(stage, footer);

	let typography: TypographySettings = options.initialTypography ?? DEFAULT_TYPOGRAPHY;
	let state: ReaderState = createReaderState(content, budget());
	if (options.initialPosition) {
		state = goToLocator(state, options.initialPosition);
	}

	const bookId = options.bookId ?? "sample-book";
	const now = options.now ?? Date.now;
	const newId =
		options.newHighlightId ?? (() => `hl-${now()}-${Math.random().toString(36).slice(2, 8)}`);
	const highlightStore = new HighlightStore(options.highlightPort ?? {});

	function budget(): number {
		const rect = stage.getBoundingClientRect();
		const w = rect.width || 600;
		const h = rect.height || 700;
		return charsPerPageBudget(typography, w, h);
	}

	function applyTypographyVars(): void {
		for (const [name, value] of Object.entries(readerCssVars(typography))) {
			root.style.setProperty(name, value);
		}
		for (const theme of THEME_ORDER) {
			root.classList.toggle(`books--theme-${theme}`, theme === typography.theme);
		}
	}

	function paint(): void {
		applyTypographyVars();
		const current = currentPage(state);
		page.replaceChildren();
		if (!current) {
			const empty = document.createElement("p");
			empty.className = "books__empty";
			empty.textContent = t("reader.empty");
			page.append(empty);
		} else {
			const fragments = slicePage(state.spine, current.range);
			const onPage = highlightsOnPage(highlightStore.list(), current.range);
			fragments.forEach((fragment, index) => {
				const el = document.createElement(fragment.kind === BlockKind.Heading ? "h2" : "p");
				el.className = fragment.kind === BlockKind.Heading ? "books__heading" : "books__paragraph";
				paintFragment(el, fragment, index, onPage, openHighlightPanelAt);
				page.append(el);
			});
		}
		const total = pageCount(state);
		status.textContent = t("reader.pageStatus", {
			page: String(state.pageIndex + 1),
			total: String(total),
		});
		progress.textContent = t("reader.progress", {
			percent: String(Math.round(readingProgress(state) * 100)),
		});
		prev.disabled = !canGoPrev(state);
		next.disabled = !canGoNext(state);
	}

	function go(mutator: (s: ReaderState) => ReaderState): void {
		const before = currentLocator(state);
		state = mutator(state);
		paint();
		const after = currentLocator(state);
		if (
			after &&
			(!before || before.spineIndex !== after.spineIndex || before.charOffset !== after.charOffset)
		) {
			options.onPositionChange?.(after, readingProgress(state));
		}
	}

	/** A typography change re-paginates against a fresh budget while the
	 *  current locator stays put, then persists the new settings. */
	function setTypography(nextTypography: TypographySettings): void {
		typography = nextTypography;
		go((s) => repaginate(s, budget()));
		options.onTypographyChange?.(serializeTypography(typography), typography);
	}

	prev.addEventListener("click", () => go(prevPage));
	next.addEventListener("click", () => go(nextPage));

	let openPanel: { close: () => void } | null = null;
	function toggleTypographyPanel(): void {
		if (openPanel) {
			openPanel.close();
			openPanel = null;
			return;
		}
		const handle = createPopoverElement({
			title: t("typography.title"),
			body: buildTypographyPanel(typography, setTypography),
			size: PopoverSize.Small,
			bodyPadding: PopoverBodyPadding.Comfortable,
			onClose: () => {
				openPanel = null;
				typeBtn.setAttribute("aria-expanded", "false");
			},
			testId: "books-typography-panel",
			labels: { close: t("typography.close") },
		});
		openPanel = handle;
		typeBtn.setAttribute("aria-expanded", "true");
	}
	typeBtn.addEventListener("click", toggleTypographyPanel);

	let highlightPanel: { close: () => void } | null = null;
	let highlightPanelBody: HTMLElement | null = null;
	function renderHighlightPanelBody(): HTMLElement {
		return buildHighlightsPanel(highlightStore.list(), {
			onGoTo: (range) => {
				go((s) => goToLocator(s, range.start));
			},
			onSetColor: (id, color) => highlightStore.setColor(id, color, now()),
			onSetNote: (id, note) => highlightStore.setNote(id, note, now()),
			onRemove: (id) => highlightStore.remove(id),
		});
	}
	function refreshHighlightPanel(): void {
		if (!highlightPanelBody) return;
		const next = renderHighlightPanelBody();
		highlightPanelBody.replaceWith(next);
		highlightPanelBody = next;
	}
	function toggleHighlightPanel(): void {
		if (highlightPanel) {
			highlightPanel.close();
			highlightPanel = null;
			return;
		}
		highlightPanelBody = renderHighlightPanelBody();
		const handle = createPopoverElement({
			title: t("highlight.panel.title"),
			body: highlightPanelBody,
			bodyPadding: PopoverBodyPadding.Comfortable,
			onClose: () => {
				highlightPanel = null;
				highlightPanelBody = null;
				highlightsBtn.setAttribute("aria-expanded", "false");
			},
			testId: "books-highlights-panel",
			labels: { close: t("highlight.panel.close") },
		});
		highlightPanel = handle;
		highlightsBtn.setAttribute("aria-expanded", "true");
	}
	highlightsBtn.addEventListener("click", toggleHighlightPanel);

	function openHighlightPanelAt(id: string): void {
		if (!highlightPanel) toggleHighlightPanel();
		const item = highlightPanelBody?.querySelector<HTMLElement>(
			`.books__hl-item[data-highlight-id="${id}"]`,
		);
		item?.classList.add("books__hl-item--active");
		item?.scrollIntoView({ block: "nearest" });
	}

	let selectionMenu: { close: () => void } | null = null;
	function closeSelectionMenu(): void {
		selectionMenu?.close();
		selectionMenu = null;
	}
	function handleSelection(): void {
		const current = currentPage(state);
		if (!current) return;
		const fragmentSelection = readFragmentSelection(page, window.getSelection());
		if (!fragmentSelection) return;
		const resolved = resolveSelection(
			slicePage(state.spine, current.range),
			current.range.start.spineIndex,
			fragmentSelection,
		);
		if (!resolved) return;
		closeSelectionMenu();
		const menu = buildSelectionMenu({
			quote: resolved.quote,
			onConfirm: (color) => {
				highlightStore.add(
					composeHighlight({ bookId, color, selection: resolved, now: now(), id: newId() }),
				);
				window.getSelection()?.removeAllRanges();
				closeSelectionMenu();
			},
			onCancel: closeSelectionMenu,
		});
		selectionMenu = createPopoverElement({
			title: t("highlight.create"),
			body: menu.body,
			footer: menu.footer,
			size: PopoverSize.Small,
			bodyPadding: PopoverBodyPadding.Comfortable,
			onClose: () => {
				selectionMenu = null;
			},
			testId: "books-selection-menu",
			labels: { close: t("highlight.closeMenu") },
		});
	}
	page.addEventListener("mouseup", () => {
		window.setTimeout(handleSelection, 0);
	});

	const unsubscribe = highlightStore.subscribe(() => {
		paint();
		refreshHighlightPanel();
	});

	const disposers: ShortcutDisposer[] = [
		attachShortcut(window, ReaderChord.Next, () => go(nextPage)),
		attachShortcut(window, ReaderChord.Prev, () => go(prevPage)),
		attachShortcut(window, ReaderChord.Larger, () => setTypography(stepSize(typography, 1))),
		attachShortcut(window, ReaderChord.Smaller, () => setTypography(stepSize(typography, -1))),
		attachShortcut(window, ReaderChord.Highlights, toggleHighlightPanel),
	];

	const resize = new ResizeObserver(() => {
		go((s) => repaginate(s, budget()));
	});
	resize.observe(stage);

	paint();

	return {
		dispose() {
			for (const d of disposers) d();
			resize.disconnect();
			unsubscribe();
			closeSelectionMenu();
			highlightPanel?.close();
			openPanel?.close();
			// The controls slot outlives this reader (React owns it) — leave it
			// empty so a non-reflow successor doesn't inherit stale buttons.
			controlsHost.replaceChildren();
		},
		typography: () => typography,
		position: () => currentLocator(state),
		highlights: () => highlightStore,
		goTo: (locator) => go((s) => goToLocator(s, locator)),
	};
}

/** The five-axis typography form. Each control mutates through the pure
 *  model and calls back with the next settings — the reader re-paginates +
 *  persists. Rebuilds itself on every change so labels/values stay live. */
function buildTypographyPanel(
	settings: TypographySettings,
	onChange: (next: TypographySettings) => void,
): HTMLElement {
	const form = document.createElement("div");
	form.className = "books__type-panel";

	const rerender = (next: TypographySettings): void => {
		onChange(next);
		form.replaceChildren(...rows(next));
	};

	function rows(s: TypographySettings): HTMLElement[] {
		return [
			familyRow(s, (family) => rerender(withFamily(s, family))),
			stepperRow(
				t("typography.size"),
				`${s.size}px`,
				() => rerender(stepSize(s, -1)),
				() => rerender(stepSize(s, 1)),
				"books-type-size",
			),
			stepperRow(
				t("typography.leading"),
				s.leading.toFixed(1),
				() => rerender(stepLeading(s, -1)),
				() => rerender(stepLeading(s, 1)),
				"books-type-leading",
			),
			stepperRow(
				t("typography.measure"),
				t("typography.measureValue", { count: String(s.measure) }),
				() => rerender(stepMeasure(s, -1)),
				() => rerender(stepMeasure(s, 1)),
				"books-type-measure",
			),
			themeRow(s, (theme) => rerender(withTheme(s, theme))),
		];
	}

	form.replaceChildren(...rows(settings));
	return form;
}

function familyRow(
	settings: TypographySettings,
	onPick: (family: ReadingFamily) => void,
): HTMLElement {
	const row = labelledRow(t("typography.family"), "stacked");
	const group = document.createElement("div");
	group.className = "books__type-segmented";
	// kbn-roles-exempt: imperative DOM radiogroup; items are focusable <button>s (Tab+Enter operable). Arrow-roving lands with the Books React migration.
	group.setAttribute("role", "radiogroup");
	group.setAttribute("aria-label", t("typography.family"));
	for (const family of FAMILY_ORDER) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = `books__type-seg books__type-seg--${family}`;
		btn.setAttribute("role", "radio");
		const active = family === settings.family;
		btn.setAttribute("aria-checked", active ? "true" : "false");
		btn.classList.toggle("books__type-seg--active", active);
		btn.textContent = t(FAMILY_LABELS[family]);
		btn.addEventListener("click", () => onPick(family));
		group.append(btn);
	}
	row.append(group);
	return row;
}

function themeRow(
	settings: TypographySettings,
	onPick: (theme: ReadingTheme) => void,
): HTMLElement {
	const row = labelledRow(t("typography.themeLabel"), "stacked");
	const group = document.createElement("div");
	group.className = "books__type-swatches";
	// kbn-roles-exempt: imperative DOM radiogroup; items are focusable <button>s (Tab+Enter operable). Arrow-roving lands with the Books React migration.
	group.setAttribute("role", "radiogroup");
	group.setAttribute("aria-label", t("typography.themeLabel"));
	for (const theme of THEME_ORDER) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = `books__type-swatch books__type-swatch--${theme}`;
		btn.setAttribute("role", "radio");
		const active = theme === settings.theme;
		btn.setAttribute("aria-checked", active ? "true" : "false");
		btn.classList.toggle("books__type-swatch--active", active);
		const fill = document.createElement("span");
		fill.className = "books__type-swatch-fill";
		fill.setAttribute("aria-hidden", "true");
		fill.textContent = "Aa";
		const label = document.createElement("span");
		label.className = "books__type-swatch-label";
		label.textContent = t(THEME_LABELS[theme]);
		btn.append(fill, label);
		btn.addEventListener("click", () => onPick(theme));
		group.append(btn);
	}
	row.append(group);
	return row;
}
