// @vitest-environment jsdom
/**
 * The dashboard layout ratchet (POLISH-DSN-13).
 *
 * The 2026-08-10 fleet audit read `21-light-01-dashboard.png` and found the
 * product's first screen with the Contacts widget painted over the labels of
 * three app icons, and Recent-notes / Journal / Conversations layered like a
 * dropped stack of cards (left edges x≈48, 56, 384, 720, two of them almost
 * entirely on top of each other). A colour/px drift ratchet had certified the
 * same screen clean, because nothing ever compared two rectangles.
 *
 * This is that comparison. It renders the REAL widgets layer and the REAL icons
 * layer into one surface, exactly as `dashboard.tsx` composes them, then reads
 * each element's geometry. Rect maths only — no pixel sampling, no screenshot,
 * no layout engine, so it cannot flake:
 *
 *  - a widget card carries its rect as inline `left/top/width/height` px;
 *  - an app icon carries its cell as inline `--icon-col` / `--icon-row`, which
 *    `icons-layer.css` turns into `margin + cell * unit` — the same formula
 *    `grid.ts` uses, so the rect is computable from the constants.
 *
 * TWO invariants, and the second one is why this file was rewritten:
 *
 *  1. **No intersection** — widget vs widget, widget vs app icon.
 *  2. **Reachability** — every rendered card, INCLUDING its header row (the
 *     grip, the collapse toggle and the ⋯ menu that is the only way to remove
 *     a widget) lies wholly inside the visible stage, and every widget in the
 *     store is either a card on the stage or a row in the "no room" tray.
 *
 * The first version of this ratchet asserted only (1) and passed on a layout
 * that parked overflow cards at y=928 and y=1264 on a 660px stage — invisible
 * AND unremovable, which is strictly worse than the overlap it fixed. An
 * intersection test alone cannot see that, because a card nobody can reach
 * intersects nothing.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DashboardIcon, DashboardWidget } from "../../preload";
import {
	GRID_OUTER_MARGIN,
	GRID_UNIT,
	ICON_BUTTON_H,
	ICON_BUTTON_W,
	ICON_FOOTPRINT_H,
	ICON_FOOTPRINT_W,
	UNPLACED_ICON_POSITION,
} from "../../shared/dashboard-icon-grid";
import { UNPLACED_WIDGET_POSITION } from "./grid";
import { DashboardIconsLayer } from "./icons-layer";
import { DashboardWidgetsLayer, WIDGET_HEADER_PX, WIDGET_TRAY_BAND_PX } from "./widgets-layer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The stage `21-light-01-dashboard.png` was captured on: a 1100px-wide window,
 *  whose dashboard body (header + tray removed) is ~660px tall. */
const STAGE_W = 1100;
const STAGE_H = 660;

type Rect = { x: number; y: number; width: number; height: number };

class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

function intersects(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function describeRect(r: Rect): string {
	return `x ${r.x}–${r.x + r.width} · y ${r.y}–${r.y + r.height}`;
}

function appIcon(target: string, x: number, y: number): DashboardIcon {
	return { kind: "app", target, label: target, x, y } as unknown as DashboardIcon;
}

function widget(
	appId: string,
	kind: string,
	x: number,
	y: number,
	w: number,
	h: number,
): DashboardWidget {
	return { appId, kind, x, y, w, h, paused: false, collapsed: false } as DashboardWidget;
}

/** The rendered rect of a widget card, from the inline geometry the layer writes. */
function cardRect(el: HTMLElement): Rect {
	return {
		x: Number.parseFloat(el.style.left),
		y: Number.parseFloat(el.style.top),
		width: Number.parseFloat(el.style.width),
		height: Number.parseFloat(el.style.height),
	};
}

/** The rendered rect of an app icon, from the cell the layer writes into
 *  `--icon-col` / `--icon-row` (`icons-layer.css` translates it by
 *  `margin + cell * unit`, matching `cellToPoint` in `grid.ts`). */
function iconRect(el: HTMLElement): Rect {
	const col = Number.parseFloat(el.style.getPropertyValue("--icon-col"));
	const row = Number.parseFloat(el.style.getPropertyValue("--icon-row"));
	return {
		x: GRID_OUTER_MARGIN + col * GRID_UNIT,
		y: GRID_OUTER_MARGIN + row * GRID_UNIT,
		width: ICON_BUTTON_W,
		height: ICON_BUTTON_H,
	};
}

type Named = { name: string; el: HTMLElement; rect: Rect };

function cards(host: HTMLElement): Named[] {
	return Array.from(host.querySelectorAll<HTMLElement>(".dashboard-widgets__card")).map((el) => ({
		name: el.dataset.testid ?? "widget",
		el,
		rect: cardRect(el),
	}));
}

function icons(host: HTMLElement): Named[] {
	return Array.from(host.querySelectorAll<HTMLElement>(".dashboard-icons__icon")).map((el) => ({
		name: el.dataset.testid ?? "icon",
		el,
		rect: iconRect(el),
	}));
}

/** Every intersecting pair on the rendered surface, named. */
function intersectingPairs(host: HTMLElement): string[] {
	const widgetEls = cards(host);
	const iconEls = icons(host);
	const pairs: string[] = [];
	for (let i = 0; i < widgetEls.length; i += 1) {
		const card = widgetEls[i] as Named;
		for (const icon of iconEls) {
			if (intersects(card.rect, icon.rect)) {
				pairs.push(
					`${card.name} (${describeRect(card.rect)}) ∩ ${icon.name} (${describeRect(icon.rect)})`,
				);
			}
		}
		for (let j = i + 1; j < widgetEls.length; j += 1) {
			const other = widgetEls[j] as Named;
			if (intersects(card.rect, other.rect)) {
				pairs.push(
					`${card.name} (${describeRect(card.rect)}) ∩ ${other.name} (${describeRect(other.rect)})`,
				);
			}
		}
	}
	return pairs;
}

/**
 * Every card the user cannot reach — the reachability invariant, stated as a
 * list of violations so a failure names the card and its rect.
 *
 * A card is reachable when its whole rect is on the stage AND the chrome row it
 * carries (grip · open ↗ · collapse · ⋯) is on the stage with it. The header is
 * the top `WIDGET_HEADER_PX` of the card's own rect, so the second clause is
 * checked as its own rectangle rather than inferred: if the card is ever
 * rendered header-elsewhere, this still asks the right question. The presence
 * of the ⋯ button is asserted too — it is the only control that can remove a
 * widget, and a card without it is unremovable however visible it is.
 */
function unreachableCards(host: HTMLElement): string[] {
	const stage: Rect = { x: 0, y: 0, width: STAGE_W, height: STAGE_H };
	const contains = (outer: Rect, inner: Rect) =>
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height;
	const out: string[] = [];
	for (const card of cards(host)) {
		if (!contains(stage, card.rect)) {
			out.push(`${card.name} (${describeRect(card.rect)}) is outside the ${STAGE_W}×${STAGE_H} stage`);
			continue;
		}
		const header: Rect = {
			x: card.rect.x,
			y: card.rect.y,
			width: card.rect.width,
			height: WIDGET_HEADER_PX,
		};
		if (!contains(stage, header)) {
			out.push(`${card.name} header (${describeRect(header)}) is outside the stage`);
		}
		if (!card.el.querySelector(".dashboard-widgets__action--menu")) {
			out.push(`${card.name} has no ⋯ menu — it cannot be removed`);
		}
	}
	return out;
}

/** The band the "no room" tray occupies when it is showing, as a rect. Nothing
 *  may be placed under it — the tray is the only handle on a refused widget, so
 *  it must not be able to cover a card's header in exchange. */
function trayBand(host: HTMLElement): Rect | null {
	if (!host.querySelector(".dashboard-widgets__noroom")) return null;
	return {
		x: 0,
		y: STAGE_H - WIDGET_TRAY_BAND_PX,
		width: STAGE_W,
		height: WIDGET_TRAY_BAND_PX,
	};
}

function cardsUnderTray(host: HTMLElement): string[] {
	const band = trayBand(host);
	if (!band) return [];
	return cards(host)
		.filter((card) => intersects(card.rect, band))
		.map((card) => `${card.name} (${describeRect(card.rect)}) sits under the no-room tray`);
}

/** Every widget in the store must have a handle: a card on the stage, or a row
 *  in the "no room" tray. A record with neither is gone — the failure mode this
 *  ratchet exists to make impossible. */
function widgetsWithoutAHandle(
	host: HTMLElement,
	stored: Record<string, DashboardWidget>,
): string[] {
	const drawn = new Set(cards(host).map((card) => card.name));
	const listed = new Set(
		Array.from(host.querySelectorAll<HTMLElement>("[data-testid^='no-room-']")).map(
			(el) => el.dataset.testid?.slice("no-room-".length) ?? "",
		),
	);
	return Object.keys(stored).filter((id) => !drawn.has(`dashboard-widget-${id}`) && !listed.has(id));
}

describe("dashboard layout — widgets never intersect, and never leave the stage", () => {
	let host: HTMLDivElement;
	let root: Root;
	let upserts: { id: string; record: DashboardWidget }[];

	beforeEach(() => {
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
		// jsdom has no layout engine: both layers read their surface box through
		// `getBoundingClientRect`, and the widgets layer seeds it from the window
		// before its first ResizeObserver tick. Pin both to the captured stage so
		// the geometry under test is the geometry of the screenshot.
		Element.prototype.getBoundingClientRect = () =>
			({ width: STAGE_W, height: STAGE_H, x: 0, y: 0, top: 0, left: 0 }) as DOMRect;
		Object.defineProperty(window, "innerWidth", { value: STAGE_W, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: STAGE_H, configurable: true });
		upserts = [];
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			apps: {
				onChanged: () => () => undefined,
				listRunning: () => Promise.resolve([]),
				onRunningChanged: () => () => undefined,
				onBadgesChanged: () => () => undefined,
				listInstalled: () => Promise.resolve([]),
				iconUrl: (id: string) => `brainstorm://app-icon/${id}`,
			},
			dashboard: {
				registeredWidgets: () => Promise.resolve([]),
				upsertWidget: (id: string, record: DashboardWidget) => {
					upserts.push({ id, record });
					return Promise.resolve();
				},
				removeWidget: () => Promise.resolve(),
			},
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	async function renderDashboard(
		iconMap: Record<string, DashboardIcon>,
		widgets: Record<string, DashboardWidget>,
	): Promise<void> {
		await act(async () => {
			// Same composition, same order as `dashboard.tsx`.
			root.render(
				<>
					<DashboardIconsLayer
						icons={iconMap}
						pins={{}}
						onMoveIcon={() => undefined}
						onActivate={() => undefined}
						gridMigrated={true}
						onGridMigrated={() => undefined}
					/>
					<DashboardWidgetsLayer widgets={widgets} icons={iconMap} />
				</>,
			);
		});
		await act(async () => await Promise.resolve());
	}

	/** The captured fleet: 20 app icons packed across the top of the stage. */
	function auditIcons(): Record<string, DashboardIcon> {
		const map: Record<string, DashboardIcon> = {};
		for (let i = 0; i < 20; i += 1) {
			map[`app_${i}`] = appIcon(
				`io.brainstorm.app${i}`,
				(i % 12) * ICON_FOOTPRINT_W,
				Math.floor(i / 12) * ICON_FOOTPRINT_H,
			);
		}
		return map;
	}

	it("the 327-audit dashboard: no widget covers an icon or another widget", async () => {
		// The six widgets the audit counted, at the left edges it measured
		// (x≈48, 56, 384, 720 → cells 4, 5, 46, 88) and stacked into the icon
		// band the way the captured store had them.
		const widgets = {
			widget_contacts: widget("io.brainstorm.contacts", "contacts", 4, 2, 40, 20),
			widget_notes: widget("io.brainstorm.notes", "recent-notes", 5, 6, 40, 20),
			widget_journal: widget("io.brainstorm.journal", "journal", 46, 8, 40, 20),
			widget_chat: widget("io.brainstorm.chat", "conversations", 88, 10, 40, 20),
			widget_books: widget("io.brainstorm.books", "currently-reading", 4, 12, 40, 20),
			widget_runs: widget("io.brainstorm.automations", "recent-runs", 46, 14, 40, 20),
		};
		await renderDashboard(auditIcons(), widgets);
		expect(intersectingPairs(host)).toEqual([]);
		expect(unreachableCards(host)).toEqual([]);
		expect(widgetsWithoutAHandle(host, widgets)).toEqual([]);
	});

	it("a widget cannot spill off the surface, however it was stored", async () => {
		const widgets = {
			// A footprint wider and taller than the whole stage (a record written
			// on a bigger monitor, or by the F-379 ×10 migration bug).
			widget_huge: widget("io.brainstorm.books", "currently-reading", 4, 20, 200, 120),
		};
		await renderDashboard({}, widgets);
		expect(unreachableCards(host)).toEqual([]);
		expect(intersectingPairs(host)).toEqual([]);
	});

	it("an app installed under a widget still gets a clear cell", async () => {
		// Main writes UNPLACED_ICON_POSITION and the renderer chooses the cell —
		// so a widget must reconcile against where the icon LANDS, not against the
		// sentinel (which reads as "no icon there at all").
		const iconMap = auditIcons();
		iconMap.app_new = appIcon(
			"io.brainstorm.newcomer",
			UNPLACED_ICON_POSITION.x,
			UNPLACED_ICON_POSITION.y,
		);
		await renderDashboard(iconMap, {
			widget_inbox: widget("io.brainstorm.mailbox", "inbox", 88, 14, 40, 20),
		});
		expect(intersectingPairs(host)).toEqual([]);
		expect(unreachableCards(host)).toEqual([]);
	});

	it("more widget area than the window holds is REFUSED, never parked off the fold", async () => {
		// The case the previous fix shipped green. Six Large (40×40) cards cannot
		// share 1100×660 under a two-row icon band; the old placer parked cards
		// 4, 5 and 6 at y=592, y=928 and y=1264, the last two entirely below a
		// fold that does not scroll — invisible AND unremovable, since the ⋯ that
		// removes a widget rides on the card's own header.
		//
		// Now: every card that IS drawn is fully on the stage, and every widget
		// that isn't drawn has a named row in the "no room" tray with a way out.
		const widgets: Record<string, DashboardWidget> = {};
		for (let i = 0; i < 6; i += 1) {
			widgets[`widget_${i}`] = widget("io.brainstorm.contacts", "contacts", 4, 2 + i * 4, 40, 40);
		}
		await renderDashboard(auditIcons(), widgets);
		expect(intersectingPairs(host)).toEqual([]);
		expect(unreachableCards(host)).toEqual([]);
		expect(widgetsWithoutAHandle(host, widgets)).toEqual([]);
		// The refusal is surfaced, not swallowed.
		expect(host.querySelector(".dashboard-widgets__noroom")).not.toBeNull();
		expect(host.querySelectorAll("[data-testid^='no-room-']").length).toBeGreaterThan(0);
		// …and every listed widget can be acted on from the tray.
		for (const row of Array.from(host.querySelectorAll<HTMLElement>("[data-testid^='no-room-']"))) {
			expect(row.querySelectorAll("button").length).toBeGreaterThanOrEqual(2);
		}
		// The tray's band is excluded from placement, so it cannot cover a card.
		expect(cardsUnderTray(host)).toEqual([]);
	});

	it("adding a widget does not reshuffle the board", async () => {
		// Deliberately OFF the placement lattice (odd cells): a card the user
		// dragged there is legal and must be left alone, so any re-derivation of
		// the whole board — even one that produces a tidier grid — moves these
		// and fails here.
		const board = {
			widget_a: widget("io.brainstorm.contacts", "contacts", 5, 33, 40, 20),
			widget_b: widget("io.brainstorm.notes", "recent-notes", 49, 33, 40, 20),
			widget_c: widget("io.brainstorm.journal", "journal", 5, 57, 40, 20),
		};
		await renderDashboard(auditIcons(), board);
		// A legal card is drawn on the cell the STORE says, not on a cell the
		// layout re-derived for it.
		for (const [id, record] of Object.entries(board)) {
			const drawn = cards(host).find((card) => card.name === `dashboard-widget-${id}`);
			expect(`${id} ${describeRect(drawn?.rect as Rect)}`).toBe(
				`${id} ${describeRect({
					x: GRID_OUTER_MARGIN + record.x * GRID_UNIT,
					y: GRID_OUTER_MARGIN + record.y * GRID_UNIT,
					width: record.w * GRID_UNIT,
					height: record.h * GRID_UNIT,
				})}`,
			);
		}
		const before = new Map(cards(host).map((card) => [card.name, describeRect(card.rect)]));
		// The newcomer is created UNPLACED (the picker has no stage to measure)
		// and lands wherever the layer finds room.
		await renderDashboard(auditIcons(), {
			...board,
			widget_new: widget(
				"io.brainstorm.chat",
				"conversations",
				UNPLACED_WIDGET_POSITION.x,
				UNPLACED_WIDGET_POSITION.y,
				20,
				20,
			),
		});
		for (const card of cards(host)) {
			if (card.name === "dashboard-widget-widget_new") continue;
			expect(`${card.name} ${describeRect(card.rect)}`).toBe(`${card.name} ${before.get(card.name)}`);
		}
		expect(intersectingPairs(host)).toEqual([]);
		expect(unreachableCards(host)).toEqual([]);
		// A never-placed record gets its chosen cell written back, so removing a
		// sibling later cannot re-derive it somewhere else.
		expect(upserts.map((u) => u.id)).toContain("widget_new");
		const written = upserts.find((u) => u.id === "widget_new")?.record;
		expect(written?.x).toBeGreaterThanOrEqual(0);
		expect(written?.y).toBeGreaterThanOrEqual(0);
	});
});
