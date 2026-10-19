import { CHROME_TABS_STATE_CHANNEL, SplitStep } from "@brainstorm-os/protocol/chrome-tabs";
import { describe, expect, it, vi } from "vitest";
import { SPLIT_DIVIDER_PX, SPLIT_MIN_PANE_PX } from "../window/split-layout";
import { SplitOrder, SplitPane } from "../window/split-state";
import {
	type BaseWindowHandle,
	type Rectangle,
	type Tab,
	type TabViewFactory,
	type WebContentsViewHandle,
	WindowContainer,
} from "./window-container";

type Listener = (...a: unknown[]) => void;

function emitter() {
	const handlers = new Map<string, Listener[]>();
	return {
		on: (e: string, h: Listener) => {
			handlers.set(e, [...(handlers.get(e) ?? []), h]);
		},
		off: (e: string, h: Listener) => {
			handlers.set(
				e,
				(handlers.get(e) ?? []).filter((x) => x !== h),
			);
		},
		fire: (e: string, ...a: unknown[]) => {
			for (const h of [...(handlers.get(e) ?? [])]) h(...a);
		},
		count: (e: string) => (handlers.get(e) ?? []).length,
	};
}

const WIDTH = 1206;

function fakeBaseWindow(): BaseWindowHandle {
	const ev = emitter();
	let destroyed = false;
	let title = "";
	return {
		id: 7,
		contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
		getContentBounds: () => ({ x: 0, y: 0, width: WIDTH, height: 700 }),
		getBounds: () => ({ x: 10, y: 20, width: WIDTH, height: 700 }),
		setBounds: vi.fn(),
		setTitle: vi.fn((t: string) => {
			title = t;
		}),
		getTitle: () => title,
		setBackgroundColor: vi.fn(),
		isDestroyed: () => destroyed,
		isFocused: () => true,
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
		on: ev.on as BaseWindowHandle["on"],
		off: ev.off as BaseWindowHandle["off"],
		once: ev.on as BaseWindowHandle["once"],
	};
}

type FakeView = WebContentsViewHandle & {
	appId: string;
	bounds: () => Rectangle | undefined;
	fire: (e: string, ...a: unknown[]) => void;
	listeners: (e: string) => number;
	setTitleForTest: (t: string) => void;
};

function fakeFactory(): TabViewFactory & { views: FakeView[] } {
	const views: FakeView[] = [];
	let nextId = 50;
	const factory = ((spec: { appId: string }) => {
		const ev = emitter();
		let title = "";
		let destroyed = false;
		let lastBounds: Rectangle | undefined;
		const view: FakeView = {
			appId: spec.appId,
			webContents: {
				id: nextId++,
				send: vi.fn(),
				getTitle: () => title,
				getURL: () => "",
				isDestroyed: () => destroyed,
				isFocused: () => false,
				startDrag: vi.fn(),
				close: vi.fn(() => {
					destroyed = true;
				}),
				focus: vi.fn(() => ev.fire("focus")),
				loadURL: vi.fn(() => ev.fire("did-finish-load")),
				on: ev.on,
				off: ev.off,
			},
			setBounds: vi.fn((b: Rectangle) => {
				lastBounds = b;
			}),
			setVisible: vi.fn(),
			bounds: () => lastBounds,
			fire: ev.fire,
			listeners: ev.count,
			setTitleForTest: (t: string) => {
				title = t;
				ev.fire("page-title-updated");
			},
		};
		views.push(view);
		return view;
	}) as unknown as TabViewFactory & { views: FakeView[] };
	factory.views = views;
	return factory;
}

function fakeChrome() {
	let lastBounds: Rectangle | undefined;
	const chrome = {
		webContents: { id: 999, send: vi.fn(), isDestroyed: () => false, on: vi.fn() },
		setBounds: vi.fn((b: Rectangle) => {
			lastBounds = b;
		}),
		setVisible: vi.fn(),
	};
	return {
		view: chrome as unknown as WebContentsViewHandle,
		bounds: () => lastBounds,
		lastState: () =>
			chrome.webContents.send.mock.calls.filter((c) => c[0] === CHROME_TABS_STATE_CHANNEL).at(-1)?.[1],
	};
}

const APP = "io.example.notes";
const OTHER = "io.example.tasks";

function setup() {
	const baseWindow = fakeBaseWindow();
	const factory = fakeFactory();
	let seq = 0;
	const created: Tab[] = [];
	const closed: Tab[] = [];
	const onEmpty = vi.fn();
	const container = new WindowContainer({
		appId: APP,
		baseWindow,
		tabViewFactory: factory,
		nextTabId: () => `tab-${++seq}`,
		reveal: vi.fn(),
		onTabCreated: (_c, tab) => created.push(tab),
		onTabClosed: (_c, tab) => closed.push(tab),
		onChanged: vi.fn(),
		onEmpty,
	});
	const spec = (title: string, route: string | null = null) => ({
		entryUrl: "file:///app/index.html",
		preloadPath: "/preload.js",
		additionalArguments: [],
		backgroundColor: "#000",
		route,
		title,
	});
	const primary = container.addTab(spec("Primary note", "brainstorm://entity/a"));
	return { container, baseWindow, factory, created, closed, onEmpty, spec, primary };
}

function view(t: Tab): FakeView {
	return t.view as FakeView;
}

describe("WindowContainer split view", () => {
	it("opens a side pane as its own renderer for its own app", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Task list"), appId: OTHER });
		expect(t.factory.views).toHaveLength(2);
		expect(view(side).appId).toBe(OTHER);
		expect(side.appId).toBe(OTHER);
		expect(side.webContentsId).not.toBe(t.primary.webContentsId);
		expect(t.created.map((tab) => tab.appId)).toEqual([APP, OTHER]);
		// The side pane is not a strip tab.
		expect(t.container.tabs()).toEqual([t.primary]);
		expect(t.container.panes()).toEqual([t.primary, side]);
	});

	it("lays the panes side by side with the divider gap between them", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		const left = view(t.primary).bounds();
		const right = view(side).bounds();
		expect(left).toEqual({ x: 0, y: 0, width: 600, height: 700 });
		expect(right).toEqual({ x: 600 + SPLIT_DIVIDER_PX, y: 0, width: 600, height: 700 });
	});

	it("spans the chrome view under both panes so the gap can take the drag", () => {
		const t = setup();
		const chrome = fakeChrome();
		t.container.mountChrome(chrome.view, 44);
		t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		expect(chrome.bounds()?.height).toBe(700);
		expect(chrome.view.setVisible).toHaveBeenLastCalledWith(true);
		const state = chrome.lastState() as { split?: { divider: Rectangle; stripHeight: number } };
		expect(state.split?.divider.width).toBe(SPLIT_DIVIDER_PX);
		expect(state.split?.stripHeight).toBe(0);
	});

	it("focuses the new side pane and names the window after it", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		expect(t.container.splitState().focused).toBe(SplitPane.Side);
		expect(t.container.focusedPane()).toBe(side);
		view(side).setTitleForTest("Groceries — Tasks");
		expect(t.baseWindow.getTitle()).toBe("Groceries — Tasks");
		expect(t.container.activeTitle()).toBe("Groceries — Tasks");
	});

	it("follows focus when the user clicks into the other pane", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		view(side).setTitleForTest("Side title");
		view(t.primary).setTitleForTest("Primary title");
		expect(t.baseWindow.getTitle()).toBe("Side title");
		view(t.primary).fire("focus");
		expect(t.container.splitState().focused).toBe(SplitPane.Primary);
		expect(t.baseWindow.getTitle()).toBe("Primary title");
	});

	it("focus-other moves keyboard focus to the other renderer", () => {
		const t = setup();
		t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		const primaryFocus = t.primary.view.webContents.focus as ReturnType<typeof vi.fn>;
		primaryFocus.mockClear();
		expect(t.container.focusOtherPane()).toBe(true);
		expect(primaryFocus).toHaveBeenCalledOnce();
		expect(t.container.splitState().focused).toBe(SplitPane.Primary);
	});

	it("swap puts the side pane on the left without resizing either", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		t.container.stepSplit(SplitStep.Left);
		const primaryWidth = view(t.primary).bounds()?.width;
		expect(t.container.swapPanes()).toBe(true);
		expect(t.container.splitState().order).toBe(SplitOrder.SideFirst);
		expect(view(side).bounds()?.x).toBe(0);
		expect(view(t.primary).bounds()?.width).toBe(primaryWidth);
	});

	it("keyboard step and drag resize, clamped to the minimum pane width", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		for (let i = 0; i < 30; i++) t.container.stepSplit(SplitStep.Right);
		expect(view(side).bounds()?.width).toBe(SPLIT_MIN_PANE_PX);
		t.container.dragSplitTo(-10_000);
		expect(view(t.primary).bounds()?.width).toBe(SPLIT_MIN_PANE_PX);
		expect(t.container.dragSplitTo(Number.NaN)).toBe(false);
	});

	it("Cmd+W in the side pane closes the side pane, not a strip tab", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		view(side).fire(
			"before-input-event",
			{ preventDefault: vi.fn() },
			{ type: "keyDown", key: "w", meta: true, control: false, shift: false, alt: false },
		);
		expect(t.container.sidePane()).toBeNull();
		expect(t.container.tabs()).toEqual([t.primary]);
		expect(t.closed).toEqual([side]);
		expect(view(t.primary).bounds()?.width).toBe(WIDTH);
	});

	it("closing the side pane returns to a single view and releases its listeners", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		expect(t.container.closeSidePane()).toBe(true);
		expect(t.container.splitState().open).toBe(false);
		expect(view(side).listeners("focus")).toBe(0);
		expect(side.view.webContents.close).toHaveBeenCalled();
		expect(t.container.closeSidePane()).toBe(false);
	});

	it("un-splitting hands the whole window body back to the surviving pane", () => {
		const t = setup();
		t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		t.container.stepSplit(SplitStep.Left);
		expect(view(t.primary).bounds()?.width).toBeLessThan(WIDTH / 2);
		t.container.closeSidePane();
		expect(view(t.primary).bounds()).toEqual({ x: 0, y: 0, width: WIDTH, height: 700 });
	});

	it("a divider drag or step resizes the panes, never the OS window", () => {
		const t = setup();
		t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		t.container.stepSplit(SplitStep.Left);
		t.container.dragSplitTo(400);
		expect(view(t.primary).bounds()?.width).not.toBe(WIDTH);
		expect(t.baseWindow.setBounds).not.toHaveBeenCalled();
		expect(t.baseWindow.getBounds().width).toBe(WIDTH);
	});

	it("a side pane whose renderer is destroyed from outside un-splits the window", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		// Mimic Electron: the webContents is already gone when `destroyed` fires.
		side.view.webContents.close();
		view(side).fire("destroyed");
		expect(t.container.sidePane()).toBeNull();
		expect(t.container.splitState().open).toBe(false);
		expect(view(t.primary).bounds()).toEqual({ x: 0, y: 0, width: WIDTH, height: 700 });
		expect(t.closed.map((tab) => tab.tabId)).toContain(side.tabId);
		expect(view(side).listeners("destroyed")).toBe(0);
	});

	it("a strip tab whose renderer is destroyed from outside leaves the strip", () => {
		const t = setup();
		const second = t.container.addTab(t.spec("Second"));
		second.view.webContents.close();
		view(second).fire("destroyed");
		expect(t.container.tabs().map((tab) => tab.tabId)).toEqual([t.primary.tabId]);
		expect(view(t.primary).bounds()?.width).toBe(WIDTH);
	});

	it("re-opening a split in the same window keeps the dragged width", () => {
		const t = setup();
		t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		t.container.stepSplit(SplitStep.Left);
		const width = view(t.primary).bounds()?.width;
		t.container.closeSidePane();
		t.container.openSidePane({ ...t.spec("Side again"), appId: OTHER });
		expect(view(t.primary).bounds()?.width).toBe(width);
	});

	it("opening a second side pane replaces the first", () => {
		const t = setup();
		const first = t.container.openSidePane({ ...t.spec("One"), appId: OTHER });
		const second = t.container.openSidePane({ ...t.spec("Two"), appId: OTHER });
		expect(t.container.sidePane()).toBe(second);
		expect(t.closed).toEqual([first]);
		expect(t.container.panes()).toHaveLength(2);
	});

	it("closing the primary's last tab promotes a same-app side pane", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: APP });
		t.container.closeTab(t.primary.tabId);
		expect(t.onEmpty).not.toHaveBeenCalled();
		expect(t.container.sidePane()).toBeNull();
		expect(t.container.tabs()).toEqual([side]);
		expect(t.container.activeTab()).toBe(side);
		expect(t.closed).toEqual([t.primary]);
		expect(view(side).bounds()?.width).toBe(WIDTH);
	});

	it("closing the primary's last tab with a different-app side pane hands off to the launcher", () => {
		const t = setup();
		t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		t.container.closeTab(t.primary.tabId);
		expect(t.onEmpty).toHaveBeenCalledOnce();
		expect(t.container.sidePane()).not.toBeNull();
	});

	it("detachSidePane lifts the renderer out alive; adoptTab refuses another app", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		const detached = t.container.detachSidePane();
		expect(detached).toBe(side);
		expect(side.view.webContents.close).not.toHaveBeenCalled();
		expect(t.closed).toEqual([]);
		expect(view(side).listeners("focus")).toBe(0);
		expect(() => t.container.adoptTab(side)).toThrow(/cannot adopt/);
	});

	it("split actions are no-ops on an unsplit window", () => {
		const t = setup();
		expect(t.container.swapPanes()).toBe(false);
		expect(t.container.focusOtherPane()).toBe(false);
		expect(t.container.stepSplit(SplitStep.Left)).toBe(false);
		expect(t.container.dragSplitTo(300)).toBe(false);
		expect(t.container.focusSidePane()).toBe(false);
	});

	it("tears the side pane down with the window", () => {
		const t = setup();
		const side = t.container.openSidePane({ ...t.spec("Side"), appId: OTHER });
		t.container.dispose();
		expect(t.closed).toContain(side);
		expect(side.view.webContents.close).toHaveBeenCalled();
	});

	it("routes are tracked per pane", () => {
		const t = setup();
		const side = t.container.openSidePane({
			...t.spec("Side", "brainstorm://entity/b"),
			appId: OTHER,
		});
		t.container.setRoute(side.webContentsId, "brainstorm://entity/c");
		expect(side.route).toBe("brainstorm://entity/c");
		expect(t.primary.route).toBe("brainstorm://entity/a");
	});
});
