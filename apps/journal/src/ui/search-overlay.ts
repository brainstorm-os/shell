/**
 * Cross-day search overlay (9.16.9) — a shared-Popover surface that
 * full-text-filters every journal entry live, with mood + habit filter
 * chips, and jumps to the chosen day (Enter / click). Mirrors the Calendar
 * event-search overlay (9.15.12).
 *
 * KBN-A-journal: the input + results form a combobox driven by the shared
 * `attachCompositeKeyboard` binding (`host: Combobox`, `keyboardTarget` = the
 * input). Focus stays on the input; `aria-activedescendant` tracks the active
 * `option`; ↑/↓ move the cursor and Enter picks — so the `listbox`/`option`
 * roles and arrow/Enter handling come from the SDK, not hand-written here. The
 * mood/habit filter rows keep their `role="group"` (not a composite role).
 */

import { CompositeHost, Orientation, attachCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { PopoverBodyPadding, PopoverSize, createPopoverElement } from "@brainstorm-os/sdk/popover";
import {
	HABIT_LABEL_KEY,
	type HabitId,
	JOURNAL_HABITS,
	JOURNAL_MOODS,
	MOOD_LABEL_KEY,
	type MoodId,
	toggleHabit,
} from "../logic/check-in";
import {
	type EntrySearchFilters,
	type JournalSearchResult,
	hasActiveSearch,
	searchEntries,
} from "../logic/entry-search";
import type { JournalT } from "../logic/journal-i18n";
import type { JournalEntry } from "../types/entry";

export type JournalSearchOverlayOptions = {
	t: JournalT;
	getEntries: () => readonly JournalEntry[];
	onPick: (entry: JournalEntry) => void;
};

export function openJournalSearch(opts: JournalSearchOverlayOptions): void {
	const { t } = opts;
	const body = document.createElement("div");
	body.className = "journal-search";

	const input = document.createElement("input");
	input.type = "search";
	input.className = "journal-search__input";
	input.placeholder = t("search.placeholder");
	input.setAttribute("aria-label", t("search.title"));

	const filters: EntrySearchFilters = { mood: null, habits: [] };

	const moodRow = document.createElement("div");
	moodRow.className = "journal-search__filter";
	moodRow.setAttribute("role", "group");
	moodRow.setAttribute("aria-label", t("search.filterMood"));
	const moodLabel = document.createElement("span");
	moodLabel.className = "journal-search__filter-label";
	moodLabel.textContent = t("search.filterMood");
	moodRow.appendChild(moodLabel);

	const habitRow = document.createElement("div");
	habitRow.className = "journal-search__filter";
	habitRow.setAttribute("role", "group");
	habitRow.setAttribute("aria-label", t("search.filterHabits"));
	const habitLabel = document.createElement("span");
	habitLabel.className = "journal-search__filter-label";
	habitLabel.textContent = t("search.filterHabits");
	habitRow.appendChild(habitLabel);

	const status = document.createElement("p");
	status.className = "journal-search__status";

	const list = document.createElement("ul");
	list.className = "journal-search__results";

	body.append(input, moodRow, habitRow, status, list);

	let results: JournalSearchResult[] = [];
	let activeIndex = -1;

	let handle: { close(): void } | null = null;
	const close = (): void => handle?.close();

	const pick = (index: number): void => {
		const result = results[index];
		if (!result) return;
		close();
		opts.onPick(result.entry);
	};

	// Visual highlight + scroll for the active row; the listbox/option roles +
	// `aria-selected` + `aria-activedescendant` are owned by the binding below.
	const updateActive = (): void => {
		const rows = list.querySelectorAll<HTMLElement>(".journal-search__row");
		rows.forEach((row, i) => {
			const on = i === activeIndex;
			row.dataset.active = String(on);
			if (on) row.scrollIntoView?.({ block: "nearest" });
		});
	};

	const kb = attachCompositeKeyboard(list, {
		orientation: Orientation.Vertical,
		host: CompositeHost.Combobox,
		useAriaActiveDescendant: true,
		keyboardTarget: input,
		count: () => results.length,
		activeIndex: () => activeIndex,
		onActiveIndexChange: (i) => {
			activeIndex = i;
			updateActive();
		},
		onActivate: (i) => pick(i),
	});

	const renderResults = (): void => {
		list.replaceChildren();
		if (!hasActiveSearch(input.value, filters)) {
			results = [];
			activeIndex = -1;
			status.textContent = t("search.hint");
			status.hidden = false;
			kb.refresh();
			return;
		}
		results = searchEntries(opts.getEntries(), input.value, filters);
		if (results.length === 0) {
			activeIndex = -1;
			status.textContent = t("search.empty");
			status.hidden = false;
			kb.refresh();
			return;
		}
		status.hidden = true;
		results.forEach((result, index) => list.appendChild(buildRow(result, index, pick)));
		activeIndex = 0;
		kb.refresh();
		updateActive();
	};

	// Build the filter chips once and toggle their state in place (a full
	// rebuild would detach the clicked chip + drop keyboard focus mid-toggle).
	const moodChips = new Map<MoodId, HTMLButtonElement>();
	for (const mood of JOURNAL_MOODS) {
		const chip = filterChip(mood.emoji, t(MOOD_LABEL_KEY[mood.id]), () => {
			filters.mood = filters.mood === mood.id ? null : mood.id;
			for (const [id, el] of moodChips) el.setAttribute("aria-pressed", String(filters.mood === id));
			renderResults();
		});
		moodChips.set(mood.id, chip);
		moodRow.appendChild(chip);
	}
	for (const habit of JOURNAL_HABITS) {
		const chip = filterChip(habit.emoji, t(HABIT_LABEL_KEY[habit.id]), () => {
			filters.habits = toggleHabit(filters.habits, habit.id) as HabitId[];
			chip.setAttribute("aria-pressed", String(filters.habits.includes(habit.id)));
			renderResults();
		});
		habitRow.appendChild(chip);
	}

	input.addEventListener("input", renderResults);

	handle = createPopoverElement({
		title: t("search.title"),
		body,
		onClose: () => kb.destroy(),
		size: PopoverSize.Medium,
		bodyPadding: PopoverBodyPadding.Comfortable,
	});

	renderResults();
	input.focus();
}

function filterChip(emoji: string, label: string, onToggle: () => void): HTMLButtonElement {
	const chip = document.createElement("button");
	chip.type = "button";
	chip.className = "journal-search__chip";
	chip.setAttribute("aria-pressed", "false");
	chip.title = label;
	const glyph = document.createElement("span");
	glyph.setAttribute("aria-hidden", "true");
	glyph.textContent = emoji;
	const text = document.createElement("span");
	text.className = "journal-search__chip-label";
	text.textContent = label;
	chip.append(glyph, text);
	chip.addEventListener("click", onToggle);
	return chip;
}

function buildRow(
	result: JournalSearchResult,
	index: number,
	pick: (i: number) => void,
): HTMLElement {
	const li = document.createElement("li");
	li.className = "journal-search__item";

	const row = document.createElement("button");
	row.type = "button";
	row.className = "journal-search__row";
	row.dataset.compositeIndex = String(index);

	const when = document.createElement("span");
	when.className = "journal-search__when";
	when.textContent = new Date(result.entry.dateEpochMs).toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	});

	const excerpt = document.createElement("span");
	excerpt.className = "journal-search__excerpt";
	excerpt.textContent = result.excerpt;

	row.append(when, excerpt);
	row.addEventListener("click", () => pick(index));
	li.appendChild(row);
	return li;
}
