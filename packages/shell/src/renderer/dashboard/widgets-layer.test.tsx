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
