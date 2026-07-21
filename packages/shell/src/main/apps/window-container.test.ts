import { TAB_ICON_NONE, TabCommandKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	type BaseWindowHandle,
	TabChord,
	type TabViewFactory,
	type WebContentsViewHandle,
	WindowContainer,
	tabChordFor,
} from "./window-container";

const KEYDOWN = { type: "keyDown", control: false, meta: false, shift: false, alt: false };

function makeEmitter() {
	const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
	return {
		on: (e: string, h: (...a: unknown[]) => void) => {
			const s = handlers.get(e) ?? [];
			s.push(h);
			handlers.set(e, s);
		},
		off: (e: string, h: (...a: unknown[]) => void) => {
			const s = handlers.get(e);
			if (s) s.splice(s.indexOf(h) >>> 0, s.indexOf(h) >= 0 ? 1 : 0);
		},
		fire: (e: string, ...a: unknown[]) => {
			for (const h of [...(handlers.get(e) ?? [])]) h(...a);
		},
	};
}

function fakeBaseWindow(id = 1): BaseWindowHandle {
	const { on, off } = makeEmitter();
	let destroyed = false;
	let title = "seed";
	return {
		id,
		contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
		getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
		getBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
		setBounds: vi.fn(),
		setTitle: vi.fn((t: string) => {
			title = t;
		}),
		getTitle: () => title,
		setBackgroundColor: vi.fn(),
		isDestroyed: () => destroyed,
		isFocused: () => false,
		isMinimized: () => false,
		isMaximized: () => false,
		isFullScreen: () => false,
		setFullScreen: vi.fn(),
		focus: vi.fn(),
		show: vi.fn(),
		showInactive: vi.fn(),
		hide: vi.fn(),
		restore: vi.fn(),
		minimize: vi.fn(),
		maximize: vi.fn(),
		unmaximize: vi.fn(),
		close: vi.fn(),
		destroy: vi.fn(() => {
			destroyed = true;
		}),
		on: on as BaseWindowHandle["on"],
		off: off as BaseWindowHandle["off"],
		once: on as BaseWindowHandle["once"],
	};
}

type FakeView = WebContentsViewHandle & {
	emitTitle: (t: string) => void;
	emitFavicons: (favicons: string[]) => void;
	sends: unknown[][];
	fireInput: (input: Record<string, unknown>) => void;
};

function fakeTabViewFactory(): TabViewFactory & { views: FakeView[] } {
	const views: FakeView[] = [];
	let nextId = 10;
	const factory = (() => {
		const id = nextId++;
		const { on, off, fire } = makeEmitter();
		const sends: unknown[][] = [];
		let title = "";
		const view = {
			sends,
			webContents: {
				id,
				send: (channel: string, ...args: unknown[]) => sends.push([channel, ...args]),
				getTitle: () => title,
				getURL: () => "",
				isDestroyed: () => false,
				isFocused: () => false,
				startDrag: vi.fn(),
				close: vi.fn(),
				focus: vi.fn(),
				loadURL: vi.fn(() => fire("did-finish-load")),
				on: on as WebContentsViewHandle["webContents"]["on"],
				off: off as WebContentsViewHandle["webContents"]["off"],
			},
			setBounds: vi.fn(),
			setVisible: vi.fn(),
			emitTitle: (t: string) => {
				title = t;
				fire("page-title-updated");
			},
			emitFavicons: (favicons: string[]) => {
				fire("page-favicon-updated", {}, favicons);
			},
			fireInput: (input: Record<string, unknown>) => {
				fire("before-input-event", { preventDefault: () => undefined }, input);
			},
		} as FakeView;
		views.push(view);
		return view;
	}) as unknown as TabViewFactory & { views: FakeView[] };
	factory.views = views;
	return factory;
}

function makeContainer(appId = "io.example.notes") {
	const baseWindow = fakeBaseWindow();
	const tabViewFactory = fakeTabViewFactory();
	let tabSeq = 0;
	const onTabCreated = vi.fn();
	const onTabClosed = vi.fn();
	const onChanged = vi.fn();
	const onEmpty = vi.fn();
	const reveal = vi.fn();
	const container = new WindowContainer({
		appId,
		baseWindow,
		tabViewFactory,
		nextTabId: () => `tab-${++tabSeq}`,
		reveal,
		onTabCreated,
		onTabClosed,
		onChanged,
		onEmpty,
	});
	const spec = (route: string | null, title = "Notes") => ({
		entryUrl: "file:///app/index.html",
		preloadPath: "/preload.js",
		additionalArguments: [],
		backgroundColor: "#000",
		route,
		title,
	});
	return {
		container,
		baseWindow,
		tabViewFactory,
		onTabCreated,
		onTabClosed,
		onChanged,
		onEmpty,
		reveal,
		spec,
	};
}

describe("WindowContainer", () => {
	it("adds a tab, makes it active, and reveals on first load", () => {
		const t = makeContainer();
		const tab = t.container.addTab(t.spec("brainstorm://entity/ent_1"));
		expect(t.container.tabs()).toHaveLength(1);
		expect(t.container.activeTab()?.tabId).toBe(tab.tabId);
		expect(t.container.activeRoute()).toBe("brainstorm://entity/ent_1");
		expect(t.onTabCreated).toHaveBeenCalledTimes(1);
		expect(t.reveal).toHaveBeenCalled();
	});

	it("publishes the object title to the OS window when the active tab reports it", () => {
		const t = makeContainer();
		t.container.addTab(t.spec(null));
		t.tabViewFactory.views[0]?.emitTitle("My note — Notes");
		expect(t.baseWindow.setTitle).toHaveBeenCalledWith("My note — Notes");
		expect(t.container.activeTitle()).toBe("My note — Notes");
	});

	it("captures the app's published favicon as the tab icon and pushes it to the strip", () => {
		const t = makeContainer();
		const chrome = {
			webContents: { id: 99, send: vi.fn(), isDestroyed: () => false, on: makeEmitter().on },
			setBounds: vi.fn(),
			setVisible: vi.fn(),
		} as unknown as WebContentsViewHandle;
		t.container.mountChrome(chrome, 40);
		t.container.addTab(t.spec(null));
		t.tabViewFactory.views[0]?.emitFavicons(["data:image/svg+xml,%3Csvg%3E%F0%9F%93%9D%3C/svg%3E"]);
		const send = chrome.webContents.send as ReturnType<typeof vi.fn>;
		expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
			tabs: [{ icon: "data:image/svg+xml,%3Csvg%3E%F0%9F%93%9D%3C/svg%3E" }],
		});
	});

	it("drops non data/brainstorm favicon URLs and treats TAB_ICON_NONE as no icon", () => {
		const t = makeContainer();
		t.container.addTab(t.spec(null));
		const view = t.tabViewFactory.views[0];
		// Remote URL: an app-authored favicon must never become a strip-side
		// network fetch (egress beacon) — gated to data:image/ + brainstorm:.
		view?.emitFavicons(["https://evil.example/beacon.png"]);
		expect(t.container.tabs()[0]?.icon).toBeNull();
		view?.emitFavicons(["brainstorm://icon/abc.png"]);
		expect(t.container.tabs()[0]?.icon).toBe("brainstorm://icon/abc.png");
		view?.emitFavicons([TAB_ICON_NONE]);
		expect(t.container.tabs()[0]?.icon).toBeNull();
	});

	it("switches tabs: only the active view is visible, others paused", () => {
		const t = makeContainer();
		const a = t.container.addTab(t.spec("brainstorm://entity/a"));
		const b = t.container.addTab(t.spec("brainstorm://entity/b"));
		// b is active after add; activate a.
		t.container.activateTab(a.tabId);
		const [va, vb] = t.tabViewFactory.views;
		expect(va?.setVisible).toHaveBeenLastCalledWith(true);
		expect(vb?.setVisible).toHaveBeenLastCalledWith(false);
		// The newly-hidden tab gets a visibility:false pause signal.
		expect(vb?.sends).toContainEqual(["window:visibility-changed", false]);
	});

	it("a visibility broadcast survives a tab whose webContents was torn down", () => {
		// Regression: a tab's `view.webContents` can be undefined (not just
		// destroyed) when the view is torn down while the window still fires a
		// hide/show event — broadcastVisibility → sendVisibility then threw
		// `Cannot read properties of undefined (reading 'isDestroyed')`. Surfaced
		// by the Books + Form-designer deep dogfood sweeps.
		const t = makeContainer();
		const a = t.container.addTab(t.spec("brainstorm://entity/a"));
		t.container.addTab(t.spec("brainstorm://entity/b")); // b active
		const [, vb] = t.tabViewFactory.views;
		(vb as unknown as { webContents: unknown }).webContents = undefined;
		// Activating a hides b and broadcasts visibility to it — must not throw.
		expect(() => t.container.activateTab(a.tabId)).not.toThrow();
	});

	it("closing a tab activates a neighbor; closing the last fires onEmpty", () => {
		const t = makeContainer();
		const a = t.container.addTab(t.spec("brainstorm://entity/a"));
		const b = t.container.addTab(t.spec("brainstorm://entity/b"));
		t.container.closeTab(b.tabId);
		expect(t.container.tabs()).toHaveLength(1);
		expect(t.container.activeTab()?.tabId).toBe(a.tabId);
		expect(t.onTabClosed).toHaveBeenCalledTimes(1);
		t.container.closeTab(a.tabId);
		expect(t.onEmpty).toHaveBeenCalledTimes(1);
	});

	it("the close-tab chord closes the active container tab", () => {
		const t = makeContainer();
		t.container.addTab(t.spec("brainstorm://entity/a"));
		t.container.addTab(t.spec("brainstorm://entity/b"));
		t.tabViewFactory.views[1]?.fireInput({ ...KEYDOWN, meta: true, key: "w" });
		expect(t.container.tabs()).toHaveLength(1);
	});

	it("the close-tab chord routes to a self-tabbing app's renderer instead of the container", () => {
		const t = makeContainer("io.brainstorm.browser");
		t.container.addTab(t.spec(null, "Browser"));
		const view = t.tabViewFactory.views[0];
		view?.fireInput({ ...KEYDOWN, meta: true, key: "w" });
		// The container tab survives; the chord becomes a window:tab-command the
		// Browser's chrome uses to close a tab in its OWN strip.
		expect(t.container.tabs()).toHaveLength(1);
		expect(view?.sends).toContainEqual(["window:tab-command", { kind: TabCommandKind.CloseTab }]);
	});

	it("re-focuses the active tab when closing a background tab (focus returns from the strip)", () => {
		const t = makeContainer();
		const a = t.container.addTab(t.spec("brainstorm://entity/a"));
		const b = t.container.addTab(t.spec("brainstorm://entity/b"));
		const c = t.container.addTab(t.spec("brainstorm://entity/c"));
		// c is active; clear focus calls recorded during setup so we assert the close.
		const [va, vb, vc] = t.tabViewFactory.views;
		(va?.webContents.focus as ReturnType<typeof vi.fn>).mockClear();
		(vc?.webContents.focus as ReturnType<typeof vi.fn>).mockClear();
		// Close a BACKGROUND tab (a) — c stays active and must regain focus so a
		// strip-initiated × click doesn't strand keyboard focus in the strip.
		t.container.closeTab(a.tabId);
		expect(t.container.activeTab()?.tabId).toBe(c.tabId);
		expect(vc?.webContents.focus).toHaveBeenCalled();
		expect(vb?.webContents.focus).toBeDefined();
	});

	it("collapses the strip with one tab and reveals it with two", () => {
		const t = makeContainer();
		const chromeOn = makeEmitter();
		const chrome = {
			webContents: {
				id: 99,
				send: vi.fn(),
				isDestroyed: () => false,
				on: chromeOn.on as WebContentsViewHandle["webContents"]["on"],
			},
			setBounds: vi.fn(),
			setVisible: vi.fn(),
		} as unknown as WebContentsViewHandle;
		t.container.mountChrome(chrome, 40);

		t.container.addTab(t.spec("brainstorm://entity/a"));
		// Lone tab: strip hidden + zero height.
		expect(chrome.setVisible).toHaveBeenLastCalledWith(false);
		expect((chrome.setBounds as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({
			height: 0,
		});

		t.container.addTab(t.spec("brainstorm://entity/b"));
		// Second tab: strip visible at its mounted height + a 1px bleed that
		// underlaps the app view, closing the sub-pixel inter-view seam.
		expect(chrome.setVisible).toHaveBeenLastCalledWith(true);
		expect((chrome.setBounds as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({
			height: 41,
		});

		// Back down to one tab collapses it again (closing the active tab).
		t.container.closeActiveTab();
		expect(chrome.setVisible).toHaveBeenLastCalledWith(false);
		expect((chrome.setBounds as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({
			height: 0,
		});
	});

	it("tells tabs when the strip takes over the OS-control gutter (collapses the header inset)", () => {
		const t = makeContainer();
		const chrome = {
			webContents: { id: 99, send: vi.fn(), isDestroyed: () => false, on: makeEmitter().on },
			setBounds: vi.fn(),
			setVisible: vi.fn(),
		} as unknown as WebContentsViewHandle;
		t.container.mountChrome(chrome, 40);
		t.container.addTab(t.spec("brainstorm://entity/a"));
		const [va] = t.tabViewFactory.views;
		// Lone tab: no strip, header keeps its traffic-light gutter.
		expect(va?.sends).not.toContainEqual(["window:strip-visible-changed", true]);

		t.container.addTab(t.spec("brainstorm://entity/b"));
		const [, vb] = t.tabViewFactory.views;
		// Strip up: both tabs are told it now owns the gutter.
		expect(va?.sends).toContainEqual(["window:strip-visible-changed", true]);
		expect(vb?.sends).toContainEqual(["window:strip-visible-changed", true]);

		t.container.closeActiveTab();
		// Back to one tab: the surviving tab reclaims its header gutter.
		expect(va?.sends).toContainEqual(["window:strip-visible-changed", false]);
	});

	it("setRoute updates the tab's route (app internal navigation)", () => {
		const t = makeContainer();
		const tab = t.container.addTab(t.spec("brainstorm://entity/a"));
		t.container.setRoute(tab.webContentsId, "brainstorm://entity/b");
		expect(t.container.activeRoute()).toBe("brainstorm://entity/b");
	});

	it("reorderTabs reorders by id and keeps unnamed tabs at the end", () => {
		const t = makeContainer();
		const a = t.container.addTab(t.spec(null, "A"));
		const b = t.container.addTab(t.spec(null, "B"));
		const c = t.container.addTab(t.spec(null, "C"));
		t.container.reorderTabs([c.tabId, a.tabId]);
		expect(t.container.tabs().map((x) => x.tabId)).toEqual([c.tabId, a.tabId, b.tabId]);
	});

	it("dispose destroys the OS window and tears down tabs", () => {
		const t = makeContainer();
		t.container.addTab(t.spec("brainstorm://entity/a"));
		t.container.dispose();
		expect(t.baseWindow.destroy).toHaveBeenCalled();
		expect(t.onTabClosed).toHaveBeenCalled();
	});

	it("change subscribers fire on tab add and title change", () => {
		const t = makeContainer();
		const sub = vi.fn();
		t.container.onDidChange(sub);
		t.container.addTab(t.spec(null));
		expect(sub).toHaveBeenCalled();
		sub.mockClear();
		t.tabViewFactory.views[0]?.emitTitle("x");
		expect(sub).toHaveBeenCalled();
	});

	it("cycleTab advances the active tab and wraps", () => {
		const t = makeContainer();
		const a = t.container.addTab(t.spec(null, "A"));
		const b = t.container.addTab(t.spec(null, "B"));
		const c = t.container.addTab(t.spec(null, "C")); // c active
		t.container.cycleTab(1);
		expect(t.container.activeTab()?.tabId).toBe(a.tabId); // wraps c → a
		t.container.cycleTab(-1);
		expect(t.container.activeTab()?.tabId).toBe(c.tabId);
		expect(b.tabId).toBeDefined();
	});

	it("closeActiveTab closes the active tab", () => {
		const t = makeContainer();
		t.container.addTab(t.spec(null, "A"));
		const b = t.container.addTab(t.spec(null, "B"));
		t.container.closeActiveTab();
		expect(t.container.tabs().some((x) => x.tabId === b.tabId)).toBe(false);
		expect(t.container.tabs()).toHaveLength(1);
	});
});

describe("tabChordFor", () => {
	it("maps Cmd/Ctrl+W to close-tab", () => {
		expect(tabChordFor({ ...KEYDOWN, meta: true, key: "w" })).toBe(TabChord.CloseTab);
		expect(tabChordFor({ ...KEYDOWN, control: true, key: "W" })).toBe(TabChord.CloseTab);
	});
	it("maps Ctrl+Tab / Ctrl+Shift+Tab to next / prev", () => {
		expect(tabChordFor({ ...KEYDOWN, control: true, key: "Tab" })).toBe(TabChord.NextTab);
		expect(tabChordFor({ ...KEYDOWN, control: true, shift: true, key: "Tab" })).toBe(
			TabChord.PrevTab,
		);
	});
	it("ignores plain keys, keyup, and alt-held chords", () => {
		expect(tabChordFor({ ...KEYDOWN, key: "w" })).toBeNull();
		expect(tabChordFor({ ...KEYDOWN, type: "keyUp", meta: true, key: "w" })).toBeNull();
		expect(tabChordFor({ ...KEYDOWN, meta: true, alt: true, key: "w" })).toBeNull();
	});
});
