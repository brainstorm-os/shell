// @vitest-environment jsdom
/**
 * SortMenuPopover — the Files view-options menu. Pins the Tasks/Contacts
 * icon convention (release-13 polish): every sort / group option carries its
 * concept glyph in a leading slot — the same SDK `IconName` the Tasks sort
 * menu uses for the same concept — alongside the active-option check.
 *
 * Also pins the two defects the 20-app visual audit (session 329) found in
 * this menu: it anchored nowhere (it painted as a centred modal while its
 * trigger sat top-right), and the direction row had an empty state slot.
 */

import { IconName } from "@brainstorm-os/sdk/icon";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupKey } from "../logic/group";
import { SortDirection, SortKey } from "../logic/sort";
import { TileSize } from "../view-mode";
import { GROUP_MENU_ICON, SORT_MENU_ICON, SortMenuPopover, directionIcon } from "./dialogs";

type Harness = { host: HTMLElement; cleanup: () => void };

type MountOptions = {
	direction?: SortDirection;
	anchor?: HTMLElement | null;
};

/** The toolbar "Sort by: …" button lives at the top-right, so its rect is a
 *  narrow box hard against the right edge of the window. */
const TRIGGER_RECT = { top: 40, left: 820, right: 940, bottom: 62 };
const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 400;

function stubRects(): () => void {
	const original = Element.prototype.getBoundingClientRect;
	Element.prototype.getBoundingClientRect = function getRect(this: Element): DOMRect {
		const box = this.classList.contains("bs-popover__panel")
			? { top: 0, left: 0, right: PANEL_WIDTH, bottom: PANEL_HEIGHT }
			: TRIGGER_RECT;
		return {
			...box,
			width: box.right - box.left,
			height: box.bottom - box.top,
			x: box.left,
			y: box.top,
			toJSON: () => box,
		} as DOMRect;
	};
	return () => {
		Element.prototype.getBoundingClientRect = original;
	};
}

function mount({ direction = SortDirection.Asc, anchor = null }: MountOptions = {}): Harness {
	const container = document.createElement("div");
	document.body.append(container);
	const root: Root = createRoot(container);
	act(() =>
		root.render(
			<SortMenuPopover
				current={SortKey.Name}
				direction={direction}
				groupKey={GroupKey.None}
				tileSize={TileSize.Medium}
				listColumns={[]}
				onSelect={vi.fn()}
				onToggleDirection={vi.fn()}
				onSelectGroup={vi.fn()}
				onSelectTileSize={vi.fn()}
				onToggleColumn={vi.fn()}
				onApplyToAll={vi.fn()}
				anchor={anchor}
				onClose={vi.fn()}
			/>,
		),
	);
	return {
		host: container,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("SortMenuPopover — per-option icons (release-13 polish)", () => {
	let h: Harness | null = null;
	afterEach(() => {
		h?.cleanup();
		h = null;
		document.body.innerHTML = "";
	});

	it("renders a concept glyph on every sort option", () => {
		h = mount();
		for (const key of Object.values(SortKey)) {
			const glyph = h.host.querySelector(`[data-testid="sort-${key}"] .sort-menu__glyph svg`);
			expect(glyph, `sort option ${key} has a glyph`).not.toBeNull();
		}
	});

	it("renders a concept glyph on every group option", () => {
		h = mount();
		for (const key of Object.values(GroupKey)) {
			const glyph = h.host.querySelector(`[data-testid="group-${key}"] .sort-menu__glyph svg`);
			expect(glyph, `group option ${key} has a glyph`).not.toBeNull();
		}
	});

	it("keeps the check on the active options next to the glyph", () => {
		h = mount();
		const active = h.host.querySelector(`[data-testid="sort-${SortKey.Name}"]`);
		expect(active?.getAttribute("aria-checked")).toBe("true");
		expect(active?.querySelector(".sort-menu__check svg")).not.toBeNull();
		expect(active?.querySelector(".sort-menu__glyph svg")).not.toBeNull();
	});

	it("mirrors the Tasks glyph for each shared concept", () => {
		// Same concept, same glyph as the Tasks sort menu (`SORT_ICON` in
		// apps/tasks/src/ui/surface-view.ts): manual/native order → View,
		// name → KindText, created → History, a date axis → KindDate.
		expect(SORT_MENU_ICON[SortKey.Manual]).toBe(IconName.View);
		expect(SORT_MENU_ICON[SortKey.Name]).toBe(IconName.KindText);
		expect(SORT_MENU_ICON[SortKey.Created]).toBe(IconName.History);
		expect(SORT_MENU_ICON[SortKey.Modified]).toBe(IconName.KindDate);
		expect(SORT_MENU_ICON[SortKey.Size]).toBe(IconName.KindNumber);
		expect(GROUP_MENU_ICON[GroupKey.Month]).toBe(IconName.KindDate);
		expect(GROUP_MENU_ICON[GroupKey.FirstLetter]).toBe(IconName.KindText);
	});
});

describe("SortMenuPopover — direction row state glyph (329 audit)", () => {
	let h: Harness | null = null;
	afterEach(() => {
		h?.cleanup();
		h = null;
		document.body.innerHTML = "";
	});

	it("fills the state slot with a caret matching the current direction", () => {
		h = mount({ direction: SortDirection.Asc });
		const row = h.host.querySelector('[data-testid="sort-toggle-direction"]');
		expect(row?.getAttribute("data-direction")).toBe(SortDirection.Asc);
		const slot = row?.querySelector(".sort-menu__check--direction");
		expect(slot, "direction row has a state slot").not.toBeNull();
		expect(slot?.querySelector("svg"), "state slot is not empty").not.toBeNull();
	});

	it("flips the caret with the direction", () => {
		expect(directionIcon(SortDirection.Asc)).toBe(IconName.CaretUp);
		expect(directionIcon(SortDirection.Desc)).toBe(IconName.CaretDown);

		h = mount({ direction: SortDirection.Desc });
		const row = h.host.querySelector('[data-testid="sort-toggle-direction"]');
		expect(row?.getAttribute("data-direction")).toBe(SortDirection.Desc);
		expect(row?.querySelector(".sort-menu__check--direction svg")).not.toBeNull();
	});

	it("stays a plain menuitem — it is an action, not a checked option", () => {
		h = mount();
		const row = h.host.querySelector('[data-testid="sort-toggle-direction"]');
		expect(row?.getAttribute("role")).toBe("menuitem");
		expect(row?.getAttribute("aria-checked")).toBeNull();
	});
});

describe("SortMenuPopover — anchored to its trigger (329 audit)", () => {
	let h: Harness | null = null;
	let restoreRects: (() => void) | null = null;
	afterEach(() => {
		h?.cleanup();
		h = null;
		restoreRects?.();
		restoreRects = null;
		document.body.innerHTML = "";
	});

	it("hangs off the trigger, right edges flush, instead of centring", () => {
		restoreRects = stubRects();
		const trigger = document.createElement("button");
		document.body.append(trigger);
		h = mount({ anchor: trigger });

		const panel = h.host.querySelector<HTMLElement>('[data-testid="sort-menu"]');
		expect(panel?.dataset.anchored).toBe("true");
		expect(panel?.style.position).toBe("fixed");
		// End-aligned: the panel's right edge sits on the trigger's right edge.
		expect(panel?.style.left).toBe(`${TRIGGER_RECT.right - PANEL_WIDTH}px`);
		// And it hangs below the trigger, gutter included.
		expect(Number.parseInt(panel?.style.top ?? "", 10)).toBeGreaterThan(TRIGGER_RECT.bottom);
		// A menu must not dim the surface it is a menu OF.
		expect(h.host.querySelector(".bs-popover--anchored")).not.toBeNull();
		expect(h.host.querySelector('[aria-modal="true"]')).toBeNull();

		trigger.remove();
	});

	it("falls back to the centred modal when there is no trigger", () => {
		h = mount({ anchor: null });
		const panel = h.host.querySelector<HTMLElement>('[data-testid="sort-menu"]');
		expect(panel?.dataset.anchored).toBeUndefined();
		expect(panel?.style.position).toBe("");
		expect(h.host.querySelector(".bs-popover--anchored")).toBeNull();
	});
});
