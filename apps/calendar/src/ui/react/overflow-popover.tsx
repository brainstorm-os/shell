/**
 * "+N more" overflow popover (Month view) — a free-floating panel anchored
 * at the pill listing every item for the day. Chips inside route through the
 * SAME `onItemClick` + `objectMenu` providers as the main cells. Dismisses on
 * outside-mousedown / Escape / outside-scroll / resize (a scroll inside the
 * popover's own list does NOT dismiss — regression coverage). The header
 * doubles as an explicit "open this day" route.
 *
 * Deliberately bespoke, not `@brainstorm-os/sdk/popover`: that primitive is a
 * fixed, centred, full-viewport MODAL (backdrop + `aria-modal`). This is an
 * anchored, non-modal flyout that must pop at the day pill and leave the rest
 * of the month interactive — no shared anchored-panel primitive exists yet.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../i18n/t";
import type { MonthDayCell } from "../../logic/compile-view";
import type { ScheduledItem } from "../../logic/scheduled-item";
import { EventChip } from "./event-chip";
import type { EventChipMenuProvider, ViewCallbacks } from "./view-callbacks";

const GUTTER = 8;

export type OverflowPopoverProps = {
	cell: MonthDayCell;
	items: ScheduledItem[];
	anchor: DOMRect;
	onItemClick: ViewCallbacks["onItemClick"];
	onDayClick: ViewCallbacks["onDayClick"];
	objectMenu: EventChipMenuProvider;
	onClose: () => void;
};

export function OverflowPopover({
	cell,
	items,
	anchor,
	onItemClick,
	onDayClick,
	objectMenu,
	onClose,
}: OverflowPopoverProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;
		const rect = panel.getBoundingClientRect();
		let left = anchor.left;
		let top = anchor.bottom + 4;
		if (left + rect.width > window.innerWidth - GUTTER)
			left = window.innerWidth - rect.width - GUTTER;
		if (top + rect.height > window.innerHeight - GUTTER) top = anchor.top - rect.height - 4;
		if (left < GUTTER) left = GUTTER;
		if (top < GUTTER) top = GUTTER;
		setPos({ left, top });
	}, [anchor]);

	useEffect(() => {
		const onPointer = (event: MouseEvent): void => {
			if (!panelRef.current?.contains(event.target as Node)) onClose();
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.defaultPrevented) return;
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
			}
		};
		const onScroll = (event: Event): void => {
			// Scrolling the popover's own list must not dismiss it; only a scroll
			// outside the panel (moving the anchor) does.
			if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
			onClose();
		};
		document.addEventListener("mousedown", onPointer, true);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("resize", onClose);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("mousedown", onPointer, true);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("resize", onClose);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [onClose]);

	const dayDate = new Date(cell.dayStart);
	const headerText = dayDate.toLocaleDateString(undefined, {
		weekday: "long",
		day: "numeric",
		month: "long",
	});

	return (
		<div
			ref={panelRef}
			className="cal-month__overflow-popover glass--strong"
			role="dialog"
			aria-label={t("calendar.event.overflowPopover.title", { count: items.length })}
			style={{
				position: "fixed",
				left: pos ? `${pos.left}px` : "0",
				top: pos ? `${pos.top}px` : "0",
				visibility: pos ? "visible" : "hidden",
			}}
		>
			<button
				type="button"
				className="cal-month__overflow-popover-header"
				onClick={() => {
					onClose();
					onDayClick(cell.dayStart);
				}}
			>
				{headerText}
			</button>
			<ul className="cal-month__overflow-popover-list">
				{items.map((item) => (
					<li key={item.id} className="cal-month__overflow-popover-item">
						<EventChip
							item={item}
							mode="compact"
							onClick={(it) => {
								onClose();
								onItemClick(it);
							}}
							objectMenu={objectMenu}
						/>
					</li>
				))}
			</ul>
		</div>
	);
}
