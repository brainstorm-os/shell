/**
 * Event search overlay (React) — a shared-`<Popover>` surface that
 * keyword-filters the loaded scheduled items live and lets the user jump to a
 * result (Enter / click). The input + results form a combobox driven by the
 * shared `useCompositeKeyboard` (host: Combobox, `aria-activedescendant` on
 * the input, listbox/option roles on the list/rows): focus stays on the
 * input, ↑/↓ move the cursor, Enter picks.
 */

import { CompositeHost, Orientation, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { Popover, PopoverBodyPadding, PopoverSize } from "@brainstorm/sdk/popover";
import { useEffect, useMemo, useState } from "react";
import { t } from "../../i18n/t";
import { labelForSourceKey } from "../../logic/calendar-sources";
import type { ScheduledItem } from "../../logic/scheduled-item";
import { searchScheduledItems } from "../../logic/search";
import { formatTime } from "../format-date";

export type SearchOverlayProps = {
	getItems: () => readonly ScheduledItem[];
	now: number;
	onPick: (item: ScheduledItem) => void;
	onClose: () => void;
};

export function SearchOverlay({ getItems, now, onPick, onClose }: SearchOverlayProps) {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(-1);

	const results = useMemo<ScheduledItem[]>(() => {
		if (query.trim().length === 0) return [];
		return searchScheduledItems(getItems(), query, { now });
	}, [query, getItems, now]);

	// Reset the cursor to the first row whenever the result set changes.
	const resultKey = results.map((r) => r.id).join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: resultKey is the change trigger
	useEffect(() => {
		setActiveIndex(results.length > 0 ? 0 : -1);
	}, [resultKey, results.length]);

	const pick = (index: number): void => {
		const item = results[index];
		if (!item) return;
		onClose();
		onPick(item);
	};

	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		host: CompositeHost.Combobox,
		useAriaActiveDescendant: true,
		count: results.length,
		activeIndex,
		onActiveIndexChange: setActiveIndex,
		onActivate: pick,
	});

	const { role: _role, tabIndex: _tabIndex, ...inputBinding } = containerProps;

	const showHint = query.trim().length === 0;
	const showEmpty = !showHint && results.length === 0;

	return (
		<Popover
			title={t("calendar.search.title")}
			onClose={onClose}
			size={PopoverSize.Medium}
			bodyPadding={PopoverBodyPadding.Comfortable}
		>
			<div className="cal-search">
				<input
					type="search"
					className="cal-search__input cal-detail__input"
					placeholder={t("calendar.search.placeholder")}
					aria-label={t("calendar.search.title")}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					{...inputBinding}
				/>
				<p className="cal-search__status" hidden={!showHint && !showEmpty}>
					{showHint ? t("calendar.search.hint") : showEmpty ? t("calendar.search.empty") : ""}
				</p>
				{/* Combobox listbox: focus stays on the input (aria-activedescendant);
				    the listbox itself is not a Tab stop, per the WAI-ARIA combobox pattern. */}
				{/* biome-ignore lint/a11y/useFocusableInteractive: combobox listbox is driven by the input, not focusable */}
				{/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: WAI-ARIA combobox listbox is a <ul> — kbn-roles-exempt: keyboard via the useCompositeKeyboard Combobox host on the input */}
				<ul className="cal-search__results" role="listbox">
					{results.map((item, index) => {
						const date = new Date(item.start).toLocaleDateString(undefined, {
							weekday: "short",
							month: "short",
							day: "numeric",
						});
						const itemProps = getItemProps(index);
						return (
							<li key={item.id} className="cal-search__item">
								<button
									type="button"
									className="cal-search__row"
									data-active={String(index === activeIndex)}
									onClick={() => pick(index)}
									{...itemProps}
								>
									<span className="cal-search__when">
										{item.allDay ? date : `${date} · ${formatTime(item.start)}`}
									</span>
									<span className="cal-search__title">{item.title}</span>
									<span className="cal-search__source" data-source={item.sourceKey}>
										{labelForSourceKey(item.sourceKey)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>
		</Popover>
	);
}
