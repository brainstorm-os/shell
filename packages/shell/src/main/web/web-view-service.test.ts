import {
	SitePermissionKind,
	TabLoadState,
	WEB_BROWSE_CAP,
	WEB_BROWSE_READONLY_CAP,
	WEB_CAPTURE_CAP,
	type WebViewEvent,
	WebViewEventKind,
	WebViewMethod,
} from "@brainstorm-os/sdk-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseWindowHandle } from "../apps/window-container";
import { LIVE_DOM_MAX_CHARS } from "./web-live-dom";
import { BrowseMode } from "./web-readonly";
import {
	type CapturePageSpec,
	type CreateViewSpec,
	DEFAULT_MAX_LIVE_VIEWS,
	type ManagedWebView,
	WebViewService,
	type WebViewServiceOptions,
	type WindowTarget,
} from "./web-view-service";

let viewSeq = 0;

function fakeView() {
	return {
		webContentsId: ++viewSeq,
		loadUrl: vi.fn(),
		navigateBack: vi.fn(),
		navigateForward: vi.fn(),
		reload: vi.fn(),
		stop: vi.fn(),
		findInPage: vi.fn(),
		stopFind: vi.fn(),
		setBounds: vi.fn(),
		setVisible: vi.fn(),
		bringToFront: vi.fn(),
		focus: vi.fn(),
		captureHtml: vi.fn(async () => "<html><body><p>page</p></body></html>" as string | null),
		destroy: vi.fn(),
	} satisfies ManagedWebView;
}

const APP = "brainstorm.browser";
const raiseChrome = vi.fn();
const WINDOW: WindowTarget = {
	baseWindow: {} as BaseWindowHandle,
	windowId: "main",
	bodyOrigin: () => ({ x: 0, y: 0 }),
	raiseChrome,
};

function setup(overrides: Partial<WebViewServiceOptions> = {}) {
	const events: WebViewEvent[] = [];
	const created = new Map<string, ReturnType<typeof fakeView>>();
	const specs = new Map<string, CreateViewSpec>();
	/** Every createView call in order — a remount appends, so a suspension
	 *  restore is observable (the `specs` map only keeps the latest). */
	const specOrder: CreateViewSpec[] = [];
	const captures: CapturePageSpec[] = [];
	let clock = 0;

	const service = new WebViewService({
		createView: (spec) => {
			const v = fakeView();
			created.set(spec.tabId, v);
			specs.set(spec.tabId, spec);
			specOrder.push(spec);
			return v;
		},
		resolveWindow: () => WINDOW,
		emitEvent: (_appId, event) => events.push(event),
		capture: async (_appId, spec) => {
			captures.push(spec);
			return `bm_${spec.tabId}`;
		},
		now: () => ++clock,
		...overrides,
	});

	return { service, events, created, specs, specOrder, captures };
}

describe("WebViewService", () => {
	let h: ReturnType<typeof setup>;
	beforeEach(() => {
		h = setup();
	});

	it("open() mounts a view in the resolved window and loads the URL", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://example.com" });
		expect(h.created.has("t1")).toBe(true);
		expect(h.created.get("t1")?.loadUrl).toHaveBeenCalledWith("https://example.com");
		expect(h.specs.get("t1")?.appId).toBe(APP);
		expect(h.service.liveCount()).toBe(1);
	});

	it("normal tabs share the persistent partition; private tabs are isolated (Browser-10)", () => {
		// Full-mode opens (what the Browser's own chrome sends) — a read-only
		// open is isolated instead, which Browser-8's suite covers.
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" }, [
			WEB_BROWSE_CAP,
		]);
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t2", url: "https://b.com" }, [
			WEB_BROWSE_CAP,
		]);
		h.service.handle(
			APP,
			{ method: WebViewMethod.Open, tabId: "p1", url: "https://c.com", private: true },
			[WEB_BROWSE_CAP],
		);
		const p1 = h.specs.get("t1")?.partition ?? "";
		const p2 = h.specs.get("t2")?.partition ?? "";
		const pv = h.specs.get("p1")?.partition ?? "";
		// Normal tabs share one session so a login sticks across tabs.
		expect(p1).toBe(p2);
		// A private tab is isolated from the persistent jar and from other tabs.
		expect(pv).not.toBe(p1);
		// Still in-memory (we own persistence) — never a Chromium `persist:` jar.
		for (const p of [p1, p2, pv]) expect(p.startsWith("persist:")).toBe(false);
		expect(h.specs.get("t1")?.private).toBe(false);
		expect(h.specs.get("p1")?.private).toBe(true);
	});

	it("closing one normal tab leaves a sibling's shared session untouched", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" }, [
			WEB_BROWSE_CAP,
		]);
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t2", url: "https://b.com" }, [
			WEB_BROWSE_CAP,
		]);
		h.service.handle(APP, { method: WebViewMethod.Close, tabId: "t1" });
		// t2 keeps the same persistent partition; only t1's view was destroyed.
		expect(h.created.get("t1")?.destroy).toHaveBeenCalledOnce();
		expect(h.created.get("t2")?.destroy).not.toHaveBeenCalled();
		expect(h.specs.get("t2")?.partition).toBe(h.specs.get("t1")?.partition);
	});

	it("ClearBrowsingData routes to the injected jar-clear hook", async () => {
		const clearBrowsingData = vi.fn(async () => {});
		const svc = new WebViewService({
			createView: () => fakeView(),
			resolveWindow: () => WINDOW,
			emitEvent: () => {},
			clearBrowsingData,
		});
		await svc.handle(APP, { method: WebViewMethod.ClearBrowsingData });
		expect(clearBrowsingData).toHaveBeenCalledOnce();
	});

	it("resolveTabContext maps a tab's webContents to its id + current url", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		const wcId = h.created.get("t1")?.webContentsId ?? -1;
		const ctx = h.specs.get("t1")?.resolveTabContext(wcId);
		expect(ctx).toEqual({ tabId: "t1", firstPartyUrl: "https://a.com" });
		expect(h.specs.get("t1")?.resolveTabContext(99999)).toBeNull();
	});

	it("open() mounts no view and emits Closed when the app has no live window", () => {
		const events: WebViewEvent[] = [];
		const svc = new WebViewService({
			createView: () => fakeView(),
			resolveWindow: () => null,
			emitEvent: (_a, e) => events.push(e),
		});
		svc.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://x.com" });
		expect(svc.liveCount()).toBe(0);
		// The chrome must learn the tab never opened (no phantom dangling tab).
		expect(events).toContainEqual({ kind: WebViewEventKind.Closed, tabId: "t1" });
	});

	it("navigate() on an existing tab loads the new URL", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		h.service.handle(APP, { method: WebViewMethod.Navigate, tabId: "t1", url: "https://b.com" });
		expect(h.created.get("t1")?.loadUrl).toHaveBeenLastCalledWith("https://b.com");
	});

	it("routes back/forward/reload/stop/find/bounds to the live view", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		const v = h.created.get("t1");
		h.service.handle(APP, { method: WebViewMethod.Back, tabId: "t1" });
		h.service.handle(APP, { method: WebViewMethod.Forward, tabId: "t1" });
		h.service.handle(APP, { method: WebViewMethod.Reload, tabId: "t1" });
		h.service.handle(APP, { method: WebViewMethod.Stop, tabId: "t1" });
		h.service.handle(APP, {
			method: WebViewMethod.SetBounds,
			tabId: "t1",
			bounds: { x: 0, y: 40, width: 800, height: 600 },
		});
		h.service.handle(APP, {
			method: WebViewMethod.FindInPage,
			tabId: "t1",
			query: "hello",
			forward: true,
		});
		expect(v?.navigateBack).toHaveBeenCalledOnce();
		expect(v?.navigateForward).toHaveBeenCalledOnce();
		expect(v?.reload).toHaveBeenCalledOnce();
		expect(v?.stop).toHaveBeenCalledOnce();
		expect(v?.setBounds).toHaveBeenCalledWith({ x: 0, y: 40, width: 800, height: 600 });
		expect(v?.findInPage).toHaveBeenCalledWith("hello", true);
	});

	it("a method on an unknown tab is a safe no-op", () => {
		expect(() =>
			h.service.handle(APP, { method: WebViewMethod.Reload, tabId: "ghost" }),
		).not.toThrow();
	});

	it("close() destroys the view + its partition and emits Closed", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		const v = h.created.get("t1");
		h.service.handle(APP, { method: WebViewMethod.Close, tabId: "t1" });
		expect(v?.destroy).toHaveBeenCalledOnce();
		expect(h.service.liveCount()).toBe(0);
		expect(h.events).toContainEqual({ kind: WebViewEventKind.Closed, tabId: "t1" });
	});

	it("activate() shows only the active tab's view in the window", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t2", url: "https://b.com" });
		h.service.handle(APP, { method: WebViewMethod.Activate, tabId: "t2" });
		expect(h.created.get("t1")?.setVisible).toHaveBeenLastCalledWith(false);
		expect(h.created.get("t2")?.setVisible).toHaveBeenLastCalledWith(true);
		expect(h.created.get("t2")?.focus).toHaveBeenCalled();
	});

	it("view metadata events fan out to the app, tagged by tab", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		const spec = h.specs.get("t1");
		spec?.onEvent({ kind: WebViewEventKind.TitleChanged, tabId: "t1", title: "Example" });
		spec?.onEvent({
			kind: WebViewEventKind.LoadStateChanged,
			tabId: "t1",
			loadState: TabLoadState.Loaded,
		});
		expect(h.events).toContainEqual({
			kind: WebViewEventKind.TitleChanged,
			tabId: "t1",
			title: "Example",
		});
	});

	it("capture() runs the port, emits Captured, and returns the bookmark id", async () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		h.specs.get("t1")?.onEvent({ kind: WebViewEventKind.TitleChanged, tabId: "t1", title: "T" });
		const result = await h.service.handle(
			APP,
			{ method: WebViewMethod.Capture, tabId: "t1", selectionOnly: false },
			[WEB_CAPTURE_CAP],
		);
		expect(h.captures[0]).toMatchObject({ tabId: "t1", url: "https://a.com", title: "T" });
		expect(result).toEqual({ bookmarkId: "bm_t1" });
		expect(h.events).toContainEqual({
			kind: WebViewEventKind.Captured,
			tabId: "t1",
			bookmarkId: "bm_t1",
		});
	});

	it("capture() feeds the tab's live DOM to the seal (Browser-5)", async () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		await h.service.handle(
			APP,
			{ method: WebViewMethod.Capture, tabId: "t1", selectionOnly: false },
			[WEB_CAPTURE_CAP],
		);
		expect(h.captures[0]?.html).toContain("<p>page</p>");
	});

	it("capture() clamps an enormous DOM before it crosses to the seal (Browser-5)", async () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		h.created.get("t1")?.captureHtml.mockResolvedValueOnce("x".repeat(LIVE_DOM_MAX_CHARS + 999));
		await h.service.handle(
			APP,
			{ method: WebViewMethod.Capture, tabId: "t1", selectionOnly: false },
			[WEB_CAPTURE_CAP],
		);
		expect(h.captures[0]?.html?.length).toBe(LIVE_DOM_MAX_CHARS);
	});

	it("capture() degrades to a link-only seal when the page DOM is unreadable (Browser-5)", async () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		h.created.get("t1")?.captureHtml.mockResolvedValueOnce(null);
		const result = await h.service.handle(
			APP,
			{ method: WebViewMethod.Capture, tabId: "t1", selectionOnly: false },
			[WEB_CAPTURE_CAP],
		);
		expect(result).toEqual({ bookmarkId: "bm_t1" });
		expect(h.captures[0]?.html).toBeNull();
	});

	it("capture() without a broker-verified web.capture cap is refused (fail closed)", async () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		expect(() =>
			h.service.handle(APP, { method: WebViewMethod.Capture, tabId: "t1", selectionOnly: false }),
		).toThrowError(/web\.capture/);
		expect(h.captures).toHaveLength(0);
		expect(h.events.some((e) => e.kind === WebViewEventKind.Captured)).toBe(false);
	});

	it("suspends the LRU non-pinned tab past the live cap (OQ-WV-2)", () => {
		for (let i = 0; i <= DEFAULT_MAX_LIVE_VIEWS; i += 1) {
			h.service.handle(APP, {
				method: WebViewMethod.Open,
				tabId: `t${i}`,
				url: `https://s${i}.com`,
			});
		}
		// Opened DEFAULT_MAX_LIVE_VIEWS+1 tabs; cap holds the live count.
		expect(h.service.liveCount()).toBe(DEFAULT_MAX_LIVE_VIEWS);
		// t0 was least-recently-active ⇒ suspended (its view destroyed).
		expect(h.created.get("t0")?.destroy).toHaveBeenCalledOnce();
	});

	it("a pinned tab is exempt from suspension", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "pin", url: "https://p.com" });
		h.service.setPinned("pin", true);
		for (let i = 0; i < DEFAULT_MAX_LIVE_VIEWS; i += 1) {
			h.service.handle(APP, {
				method: WebViewMethod.Open,
				tabId: `t${i}`,
				url: `https://s${i}.com`,
			});
		}
		expect(h.created.get("pin")?.destroy).not.toHaveBeenCalled();
	});

	it("activate() restores a suspended tab by reloading its URL", () => {
		for (let i = 0; i <= DEFAULT_MAX_LIVE_VIEWS; i += 1) {
			h.service.handle(APP, {
				method: WebViewMethod.Open,
				tabId: `t${i}`,
				url: `https://s${i}.com`,
			});
		}
		// t0 is suspended; re-activating recreates + reloads it.
		h.service.handle(APP, { method: WebViewMethod.Activate, tabId: "t0" });
		const restored = h.created.get("t0");
		expect(restored?.loadUrl).toHaveBeenLastCalledWith("https://s0.com");
	});

	it("bounds set while a tab is suspended are applied when activate() remounts it", () => {
		for (let i = 0; i <= DEFAULT_MAX_LIVE_VIEWS; i += 1) {
			h.service.handle(APP, {
				method: WebViewMethod.Open,
				tabId: `t${i}`,
				url: `https://s${i}.com`,
			});
		}
		// t0 is suspended (view === null) — the chrome's SetBounds must not vanish.
		h.service.handle(APP, {
			method: WebViewMethod.SetBounds,
			tabId: "t0",
			bounds: { x: 0, y: 40, width: 800, height: 600 },
		});
		h.service.handle(APP, { method: WebViewMethod.Activate, tabId: "t0" });
		const restored = h.created.get("t0");
		expect(restored?.setBounds).toHaveBeenCalledWith({ x: 0, y: 40, width: 800, height: 600 });
	});

	it("navigate() remounting a suspended tab reapplies its last known bounds", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t0", url: "https://a.com" });
		// Bounds arrive while the view is live (the normal chrome layout push).
		h.service.handle(APP, {
			method: WebViewMethod.SetBounds,
			tabId: "t0",
			bounds: { x: 0, y: 40, width: 800, height: 600 },
		});
		for (let i = 1; i <= DEFAULT_MAX_LIVE_VIEWS; i += 1) {
			h.service.handle(APP, {
				method: WebViewMethod.Open,
				tabId: `t${i}`,
				url: `https://s${i}.com`,
			});
		}
		// t0 is now suspended; an omnibox navigate remounts it. The chrome's
		// bounds effect is keyed on the active tab id (unchanged here), so no
		// fresh SetBounds follows — the remount itself must size the view.
		h.service.handle(APP, { method: WebViewMethod.Navigate, tabId: "t0", url: "https://b.com" });
		const remounted = h.created.get("t0");
		expect(remounted?.loadUrl).toHaveBeenLastCalledWith("https://b.com");
		expect(remounted?.setBounds).toHaveBeenCalledWith({ x: 0, y: 40, width: 800, height: 600 });
	});

	it("suspension never picks a window's most-recently-active tab (visible in another window)", () => {
		const windowB: WindowTarget = {
			baseWindow: {} as BaseWindowHandle,
			windowId: "second",
			bodyOrigin: () => ({ x: 0, y: 0 }),
			raiseChrome: vi.fn(),
		};
		let target = windowB;
		const created = new Map<string, ReturnType<typeof fakeView>>();
		const svc = new WebViewService({
			createView: (spec) => {
				const v = fakeView();
				created.set(spec.tabId, v);
				return v;
			},
			resolveWindow: () => target,
			emitEvent: () => {},
			maxLiveViews: 2,
		});
		// b1 is window B's only (⇒ visible) tab and the global LRU.
		svc.handle(APP, { method: WebViewMethod.Open, tabId: "b1", url: "https://b1.com" });
		target = WINDOW;
		svc.handle(APP, { method: WebViewMethod.Open, tabId: "a1", url: "https://a1.com" });
		svc.handle(APP, { method: WebViewMethod.Open, tabId: "a2", url: "https://a2.com" });
		// Over the cap by one: a1 (window A's background tab) must go, not b1 —
		// suspending b1 would blank window B with no signal to its chrome.
		expect(created.get("b1")?.destroy).not.toHaveBeenCalled();
		expect(created.get("a1")?.destroy).toHaveBeenCalledOnce();
	});

	it("dispose() tears down every view", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t2", url: "https://b.com" });
		h.service.dispose();
		expect(h.service.liveCount()).toBe(0);
	});
});

describe("WebViewService — chrome-on-top (floating popup over the page view)", () => {
	let h: ReturnType<typeof setup>;
	beforeEach(() => {
		raiseChrome.mockClear();
		h = setup();
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.com" });
	});

	it("on=true raises the window's chrome view", () => {
		h.service.handle(APP, { method: WebViewMethod.SetChromeOnTop, tabId: "t1", on: true });
		expect(raiseChrome).toHaveBeenCalledOnce();
		expect(h.created.get("t1")?.bringToFront).not.toHaveBeenCalled();
	});

	it("on=false re-stacks the tab's page view on top", () => {
		h.service.handle(APP, { method: WebViewMethod.SetChromeOnTop, tabId: "t1", on: true });
		h.service.handle(APP, { method: WebViewMethod.SetChromeOnTop, tabId: "t1", on: false });
		expect(h.created.get("t1")?.bringToFront).toHaveBeenCalledOnce();
	});

	it("an unknown tab and a foreign app's tab are both no-ops (fail-soft, no throw)", () => {
		h.service.handle(APP, { method: WebViewMethod.SetChromeOnTop, tabId: "ghost", on: true });
		h.service.handle("other.app", { method: WebViewMethod.SetChromeOnTop, tabId: "t1", on: true });
		expect(raiseChrome).not.toHaveBeenCalled();
	});

	it("activate() re-stacks the page view on top (heals an orphaned raise)", () => {
		h.service.handle(APP, { method: WebViewMethod.Open, tabId: "t2", url: "https://b.com" });
		h.service.handle(APP, { method: WebViewMethod.SetChromeOnTop, tabId: "t1", on: true });
		h.service.handle(APP, { method: WebViewMethod.Activate, tabId: "t2" });
		expect(h.created.get("t2")?.bringToFront).toHaveBeenCalledOnce();
	});
});

describe("WebViewService — site permissions (Browser-7)", () => {
	it("SetSitePermission routes to the injected grant setter", async () => {
		const set = vi.fn();
		const service = new WebViewService({
			createView: () => fakeView(),
			resolveWindow: () => WINDOW,
			emitEvent: () => {},
			setSitePermission: set,
		});
		await service.handle(APP, {
			method: WebViewMethod.SetSitePermission,
			tabId: "t1",
			origin: "https://example.com",
			permission: SitePermissionKind.Camera,
			allow: true,
		});
		expect(set).toHaveBeenCalledWith("https://example.com", SitePermissionKind.Camera, true);
	});

	it("SetSitePermission without an injected setter is a no-op", async () => {
		const service = new WebViewService({
			createView: () => fakeView(),
			resolveWindow: () => WINDOW,
			emitEvent: () => {},
		});
		await expect(
			Promise.resolve(
				service.handle(APP, {
					method: WebViewMethod.SetSitePermission,
					tabId: "t1",
					origin: "https://example.com",
					permission: SitePermissionKind.Geolocation,
					allow: false,
				}),
			),
		).resolves.toBeUndefined();
	});
});

describe("Browser-8 — read-only browsing (OQ-WV-5)", () => {
	it("opens a full-mode view for a caller that declared web.browse", () => {
		const s = setup();
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.test/" }, [
			WEB_BROWSE_CAP,
		]);
		expect(s.specs.get("t1")?.mode).toBe(BrowseMode.Full);
	});

	it("opens a READ-ONLY view for a caller that declared only the sub-cap", () => {
		const s = setup();
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.test/" }, [
			WEB_BROWSE_READONLY_CAP,
		]);
		expect(s.specs.get("t1")?.mode).toBe(BrowseMode.ReadOnly);
	});

	it("isolates a read-only tab in its own throwaway partition", () => {
		const s = setup();
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "ro", url: "https://a.test/" }, [
			WEB_BROWSE_READONLY_CAP,
		]);
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "full", url: "https://a.test/" }, [
			WEB_BROWSE_CAP,
		]);
		expect(s.specs.get("ro")?.partition).toContain("ro");
		expect(s.specs.get("ro")?.partition).not.toBe(s.specs.get("full")?.partition);
	});

	it("fails closed: a navigate that mints a tab gets read-only, not full", () => {
		const s = setup();
		s.service.handle(APP, { method: WebViewMethod.Navigate, tabId: "t1", url: "https://a.test/" }, [
			WEB_BROWSE_CAP,
		]);
		expect(s.specs.get("t1")?.mode).toBe(BrowseMode.ReadOnly);
	});

	it("fails closed when no browse capability was declared at all", () => {
		const s = setup();
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.test/" }, []);
		expect(s.specs.get("t1")?.mode).toBe(BrowseMode.ReadOnly);
	});

	it("keeps the mode across a suspension remount (never widens)", () => {
		const s = setup({ maxLiveViews: 1 });
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.test/" }, [
			WEB_BROWSE_READONLY_CAP,
		]);
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t2", url: "https://b.test/" }, [
			WEB_BROWSE_CAP,
		]);
		s.service.handle(APP, { method: WebViewMethod.Activate, tabId: "t1" }, [WEB_BROWSE_READONLY_CAP]);
		const mounts = s.specOrder.filter((spec) => spec.tabId === "t1");
		expect(mounts.length).toBeGreaterThan(1);
		expect(mounts[mounts.length - 1]?.mode).toBe(BrowseMode.ReadOnly);
	});
});

describe("Browser-8 — extract-text", () => {
	const extracted = {
		url: "https://a.test/",
		title: "A",
		byline: null,
		text: "body text",
		truncated: false,
	};

	it("feeds the live DOM to the extractor and returns its projection (Net-3)", async () => {
		const seen: string[] = [];
		const s = setup({
			extractText: async (_appId, spec) => {
				seen.push(spec.html);
				return extracted;
			},
		});
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.test/" }, [
			WEB_BROWSE_CAP,
		]);
		expect(
			await s.service.handle(APP, { method: WebViewMethod.ExtractText, tabId: "t1" }, [
				WEB_CAPTURE_CAP,
			]),
		).toEqual(extracted);
		expect(seen[0]).toContain("<p>page</p>");
	});

	it("reports nothing when the page has no readable DOM (Net-3)", async () => {
		const s = setup({ extractText: async () => extracted });
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.test/" }, [
			WEB_BROWSE_CAP,
		]);
		s.created.get("t1")?.captureHtml.mockResolvedValueOnce(null);
		expect(
			await s.service.handle(APP, { method: WebViewMethod.ExtractText, tabId: "t1" }, [
				WEB_CAPTURE_CAP,
			]),
		).toBeNull();
	});

	it("clamps an enormous DOM before it reaches the parser (Net-3)", async () => {
		let received = "";
		const s = setup({
			extractText: async (_appId, spec) => {
				received = spec.html;
				return extracted;
			},
		});
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.test/" }, [
			WEB_BROWSE_CAP,
		]);
		s.created.get("t1")?.captureHtml.mockResolvedValueOnce("x".repeat(LIVE_DOM_MAX_CHARS + 1_000));
		await s.service.handle(APP, { method: WebViewMethod.ExtractText, tabId: "t1" }, [
			WEB_CAPTURE_CAP,
		]);
		expect(received.length).toBe(LIVE_DOM_MAX_CHARS);
	});

	it("resolves null for an unknown tab", async () => {
		const s = setup({ extractText: async () => extracted });
		expect(
			await s.service.handle(APP, { method: WebViewMethod.ExtractText, tabId: "nope" }, [
				WEB_CAPTURE_CAP,
			]),
		).toBeNull();
	});

	it("resolves null when the host wired no extractor", async () => {
		const s = setup();
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.test/" }, [
			WEB_BROWSE_CAP,
		]);
		expect(
			await s.service.handle(APP, { method: WebViewMethod.ExtractText, tabId: "t1" }, [
				WEB_CAPTURE_CAP,
			]),
		).toBeNull();
	});

	it("extract-text without a broker-verified web.capture cap is refused (fail closed)", () => {
		const s = setup({ extractText: async () => extracted });
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.test/" }, [
			WEB_BROWSE_CAP,
		]);
		expect(() =>
			s.service.handle(APP, { method: WebViewMethod.ExtractText, tabId: "t1" }, [WEB_BROWSE_CAP]),
		).toThrowError(/web\.capture/);
	});

	it("writes nothing to the vault (it is the read path, not capture)", async () => {
		const s = setup({ extractText: async () => extracted });
		s.service.handle(APP, { method: WebViewMethod.Open, tabId: "t1", url: "https://a.test/" }, [
			WEB_BROWSE_CAP,
		]);
		await s.service.handle(APP, { method: WebViewMethod.ExtractText, tabId: "t1" }, [
			WEB_CAPTURE_CAP,
		]);
		expect(s.captures).toHaveLength(0);
	});
});
