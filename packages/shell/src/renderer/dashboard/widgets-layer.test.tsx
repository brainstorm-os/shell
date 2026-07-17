// @vitest-environment jsdom
/**
 * Widgets layer ↔ app-registry glue (F-380): the layer resolves placement
 * titles from `registeredWidgets()` and must re-resolve on `apps:changed` — a
 * fetch that lands during an app's uninstall→install window misses that app's
 * rows, and without the refresh the card is stuck titled with the raw kind
 * slug until a full restart. Card drag/resize/menu behaviour is exercised in
 * the real-Electron dogfood sessions (317/320/375); here we pin the refresh
 * contract.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DashboardWidget } from "../../preload";
import { DashboardWidgetsLayer } from "./widgets-layer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTES = "io.brainstorm.notes";
const WIDGET: DashboardWidget = {
	appId: NOTES,
	kind: "recent-notes",
	x: 0,
	y: 0,
	w: 40,
	h: 20,
	paused: false,
	collapsed: false,
};

const flush = () => act(async () => await Promise.resolve());

describe("DashboardWidgetsLayer — apps:changed refresh (F-380)", () => {
	let host: HTMLDivElement;
	let root: Root;
	let registered: Array<{ appId: string; widgetId: string; name: string; size: string }>;
	let appsChangedListeners: Array<() => void>;
	let upserts: Array<{ id: string; record: DashboardWidget }>;

	beforeEach(() => {
		registered = [];
		appsChangedListeners = [];
		upserts = [];
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			apps: {
				onChanged: (listener: () => void) => {
					appsChangedListeners.push(listener);
					return () => undefined;
				},
			},
			dashboard: {
				registeredWidgets: () => Promise.resolve(registered),
				upsertWidget: (id: string, record: DashboardWidget) => {
					upserts.push({ id, record });
					return Promise.resolve();
				},
				// No widgetBridge — the stale-preload guard path; cards render
				// their placeholder body, which is all this test needs.
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

	it("re-resolves a slug title once the app's registration lands", async () => {
		// Mount during the reinstall window: the catalog has no notes rows yet.
		await act(async () => {
			root.render(<DashboardWidgetsLayer widgets={{ widget_1: WIDGET }} />);
		});
		await flush();
		expect(host.querySelector(".dashboard-widgets__title")?.textContent).toBe("recent-notes");

		// The installer finishes and pushes apps:changed — the title heals.
		registered = [{ appId: NOTES, widgetId: "recent-notes", name: "Recent Notes", size: "medium" }];
		await act(async () => {
			for (const fire of appsChangedListeners) fire();
		});
		await flush();
		expect(host.querySelector(".dashboard-widgets__title")?.textContent).toBe("Recent Notes");
	});

	it("renders a record stranded off-surface back inside the viewport (F-379)", async () => {
		// The pre-7.3b migration bug baked ×10 positions into stored records
		// (session 375: left 336px / top 4016px on an 800px screen). PR #92
		// stopped the re-migration, but an already-baked record still rendered
		// thousands of pixels below the fold with no way to reach it. The layer
		// must clamp the display origin back into the surface (jsdom window:
		// 1024×768).
		const stranded: DashboardWidget = { ...WIDGET, x: 40, y: 500, w: 27, h: 20 };
		await act(async () => {
			root.render(<DashboardWidgetsLayer widgets={{ widget_1: stranded }} />);
		});
		await flush();

		const card = host.querySelector<HTMLElement>('[data-testid="dashboard-widget-widget_1"]');
		if (!card) throw new Error("no card");
		const top = Number.parseFloat(card.style.top);
		const left = Number.parseFloat(card.style.left);
		// At least a minimum footprint of the card (header grip included) must
		// start inside the 768px-tall surface — not 4016px below the fold.
		expect(top).toBeLessThanOrEqual(768 - 48);
		// The horizontal origin was already on-surface — it must not move.
		expect(left).toBe(336);
	});

	it("keeps a widget in place when shrunk to the minimum footprint, through the persistence echo (F-379)", async () => {
		// Mira's original gesture: shrink as small as it goes. The position must
		// survive both the optimistic update AND the store echo round-trip (the
		// old bug teleported the card only once the echoed record re-entered the
		// legacy migration).
		const placed: DashboardWidget = { ...WIDGET, x: 4, y: 50, w: 8, h: 7 };
		await act(async () => {
			root.render(<DashboardWidgetsLayer widgets={{ widget_1: placed }} />);
		});
		await flush();

		const key = (el: Element, key: string, shiftKey = false) =>
			act(() => {
				el.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
			});
		const resize = host.querySelector(".dashboard-widgets__resize");
		if (!resize) throw new Error("no resize grip");
		for (let i = 0; i < 5; i++) key(resize, "ArrowUp", true);
		const final = upserts.at(-1)?.record;
		expect(final).toMatchObject({ x: 4, y: 50, w: 8, h: 6 });
		if (!final) throw new Error("no upsert");

		// Echo the persisted record back through the snapshot prop.
		await act(async () => {
			root.render(<DashboardWidgetsLayer widgets={{ widget_1: final }} />);
		});
		await flush();
		const card = host.querySelector<HTMLElement>('[data-testid="dashboard-widget-widget_1"]');
		expect(card?.style.left).toBe("48px"); // 16 + 4*8
		expect(card?.style.top).toBe("416px"); // 16 + 50*8
	});

	it("arrow keys on the focused grips nudge move/resize on the 8px grid (F-383)", async () => {
		await act(async () => {
			root.render(<DashboardWidgetsLayer widgets={{ widget_1: WIDGET }} />);
		});
		await flush();

		const key = (el: Element, key: string, shiftKey = false) =>
			act(() => {
				el.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
			});

		const grip = host.querySelector(".dashboard-widgets__grip");
		expect(grip?.getAttribute("tabindex")).toBe("0");
		if (!grip) throw new Error("no grip");
		key(grip, "ArrowRight");
		expect(upserts.at(-1)?.record).toMatchObject({ x: WIDGET.x + 1, y: WIDGET.y });
		key(grip, "ArrowDown", true); // Shift = 4 cells
		expect(upserts.at(-1)?.record).toMatchObject({ y: WIDGET.y + 4 });

		const resize = host.querySelector(".dashboard-widgets__resize");
		expect(resize?.getAttribute("tabindex")).toBe("0");
		if (!resize) throw new Error("no resize grip");
		key(resize, "ArrowRight");
		expect(upserts.at(-1)?.record).toMatchObject({ w: WIDGET.w + 1, h: WIDGET.h });
		// Shrinking far below the floor clamps at the 8×6 minimum.
		for (let i = 0; i < 20; i++) key(resize, "ArrowUp", true);
		expect(upserts.at(-1)?.record.h).toBe(6);
	});
});
