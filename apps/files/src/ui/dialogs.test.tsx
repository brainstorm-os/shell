// @vitest-environment jsdom
/**
 * SortMenuPopover — the Files view-options menu. Pins the Tasks/Contacts
 * icon convention (release-13 polish): every sort / group option carries its
 * concept glyph in a leading slot — the same SDK `IconName` the Tasks sort
 * menu uses for the same concept — alongside the active-option check.
 */

import { IconName } from "@brainstorm-os/sdk/icon";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupKey } from "../logic/group";
import { SortDirection, SortKey } from "../logic/sort";
import { TileSize } from "../view-mode";
import { GROUP_MENU_ICON, SORT_MENU_ICON, SortMenuPopover } from "./dialogs";

type Harness = { host: HTMLElement; cleanup: () => void };

function mount(): Harness {
	const container = document.createElement("div");
	document.body.append(container);
	const root: Root = createRoot(container);
	act(() =>
		root.render(
			<SortMenuPopover
				current={SortKey.Name}
				direction={SortDirection.Asc}
				groupKey={GroupKey.None}
				tileSize={TileSize.Medium}
				listColumns={[]}
				onSelect={vi.fn()}
				onToggleDirection={vi.fn()}
				onSelectGroup={vi.fn()}
				onSelectTileSize={vi.fn()}
				onToggleColumn={vi.fn()}
				onApplyToAll={vi.fn()}
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
