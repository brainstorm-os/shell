/**
 * `openValueCombobox` — the type-or-pick editor for a select-like text cell
 * that has no catalog vocabulary. Wraps the shared `openSearchPicker` (the
 * sanctioned filter-input-over-a-list combobox) with the "values already used
 * in this column" semantics: the rows are the column's existing distinct
 * values, filtered by what the user types, plus a synthetic "use the typed
 * text" row so a brand-new value can still be committed (free text preserved).
 *
 * The picker owns its own input, focus, keyboard and a11y; this module owns
 * only the row set (filter + synthetic row) and turning a chosen row id back
 * into the committed string.
 */

import {
	type SearchPickerItem,
	closeSearchPicker,
	openSearchPicker,
} from "../../menus/search-picker";

/** Row id for the "commit the typed text as a new value" affordance. A leading
 *  space can't collide with a real value (rows + values are trimmed user text). */
export const COMBOBOX_FREE_TEXT_ID = " bs-free-text";

/** Build the combobox rows for a query (pure — the testable core): the existing
 *  values that substring-match, plus a leading "commit the typed text" row when
 *  the query is non-empty and isn't already one of the values. */
export function comboboxRows(
	suggestions: readonly string[],
	query: string,
	useTypedLabel: (query: string) => string,
): SearchPickerItem[] {
	const q = query.trim().toLowerCase();
	const rows: SearchPickerItem[] = suggestions
		.filter((v) => v.toLowerCase().includes(q))
		.map((v) => ({ id: v, label: v }));
	const trimmed = query.trim();
	const exact = suggestions.some((v) => v.toLowerCase() === q);
	if (trimmed.length > 0 && !exact) {
		rows.unshift({ id: COMBOBOX_FREE_TEXT_ID, label: useTypedLabel(trimmed) });
	}
	return rows;
}

export type OpenValueComboboxOptions = {
	/** The cell element the picker drops from. */
	anchor: Element;
	/** The current value — seeds the filter input so an edit starts from it. */
	current: string;
	/** Existing distinct values for the column (already deduped by the host). */
	suggestions: readonly string[];
	/** Filter-input placeholder. */
	placeholder: string;
	/** Accessible name for the picker shell. */
	ariaLabel: string;
	/** Label for the synthetic "commit typed text" row, given the typed query. */
	useTypedLabel: (query: string) => string;
	/** Commit the chosen / typed value. */
	onCommit: (value: string) => void;
	/** Fired once when the picker closes for any reason (return focus / clear
	 *  the host's editing state). */
	onClose: () => void;
};

/** Open the value combobox. Returns false when no menu host is mounted, so the
 *  caller can fall back to a plain inline input. */
export function openValueCombobox(opts: OpenValueComboboxOptions): boolean {
	let lastQuery = opts.current;

	return openSearchPicker({
		placeholder: opts.placeholder,
		ariaLabel: opts.ariaLabel,
		initialQuery: opts.current,
		filter: (query) => {
			lastQuery = query;
			return comboboxRows(opts.suggestions, query, opts.useTypedLabel);
		},
		onSelect: (id) => {
			opts.onCommit(id === COMBOBOX_FREE_TEXT_ID ? lastQuery.trim() : id);
		},
		onClose: opts.onClose,
		anchor: opts.anchor,
	});
}

export { closeSearchPicker as closeValueCombobox };
