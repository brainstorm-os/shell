// @vitest-environment jsdom
/**
 * 9.13.16 Stage 2/3 — React chrome unit tests. The canvas controller mounts
 * Pixi (WebGL), which won't stand up under jsdom, so these drive the chrome
 * sub-components (header / filters / settings / legend / local badge / history
 * popover) with a lightweight fake controller built from the demo dataset.
 * They assert the React-owned chrome renders from the snapshot and that the
 * control affordances call the controller's command methods. The canvas
 * behaviour stays covered by the logic / render / canvas-focus suites.
 */

import {
	BrainstormMenuProvider,
	CONTEXT_MENU_ID,
	type ContextMenuItem,
	closeContextMenu,
	getActiveMenuStore,
} from "@brainstorm-os/sdk/menus";
import { SystemEntityType } from "@brainstorm-os/sdk/system-entities";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "./app";
import { DEMO_GRAPH, canonicalBerlinPattern } from "./demo/dataset";
import {
	type AppState,
	type CanvasSnapshot,
	type GraphCanvasController,
	SidebarMode,
} from "./graph-canvas-controller";
import { LocalDirection } from "./logic/local-scope";
import { DEFAULT_LAYOUT_PARAMS } from "./render/force-layout";
import { LayoutDriver } from "./render/layout-driver";
import { buildScene, resolveGraphTheme } from "./render/scene";
import { flush, renderInto } from "./test/render";
import { HistoryReveal } from "./types/graph-view";
import type { GraphPattern } from "./types/pattern";

const { GraphHeader, FiltersPanel, SettingsPanel, Legend, LocalBadge, HistoryFab } = __testing;

function makeState(): AppState {
	const scene = buildScene(canonicalBerlinPattern(), DEMO_GRAPH);
	return {
		pattern: canonicalBerlinPattern(),
		cutoffAt: null,
		isPlaying: false,
		playbackSpeed: 1,
		layoutNodes: new Map(),
		layoutParams: { ...DEFAULT_LAYOUT_PARAMS },
		renderer: null,
		scene,
		layout: new LayoutDriver({ ...DEFAULT_LAYOUT_PARAMS }),
		settings: {
			showUnmatched: true,
			showLabels: true,
			showArrows: true,
			showIcons: true,
			reveal: HistoryReveal.Eased,
		},
		forces: {
			charge: DEFAULT_LAYOUT_PARAMS.charge,
			chargeDistanceMax: DEFAULT_LAYOUT_PARAMS.chargeDistanceMax,
			linkDistance: DEFAULT_LAYOUT_PARAMS.linkDistance,
			centerStrength: DEFAULT_LAYOUT_PARAMS.centerStrength,
			collidePadding: DEFAULT_LAYOUT_PARAMS.collidePadding,
			collideStrength: DEFAULT_LAYOUT_PARAMS.collideStrength,
			velocityDecay: DEFAULT_LAYOUT_PARAMS.velocityDecay,
			maxSpeed: DEFAULT_LAYOUT_PARAMS.maxSpeed,
		},
		drag: null,
		linkDrag: null,
		hoveredId: null,
		kbFocusId: null,
		selectedIds: new Set(),
		selectionAnchor: null,
		focusAlphaByNode: new Map(),
		focusAlphaByEdge: new Map(),
		db: DEMO_GRAPH,
		sidebarMode: SidebarMode.Filters,
		sidebarCollapsed: false,
		theme: resolveGraphTheme(),
		pinned: new Map(),
		transform: { k: 1, tx: 0, ty: 0 },
		pan: null,
		localRootId: null,
		localDepth: 1,
		localDirection: LocalDirection.Both,
		pathMode: false,
		pathStart: null,
		pathNodes: new Set(),
		pathStatus: null,
		lastPaint: null,
		focusAnimating: false,
		forceRepaint: false,
		pendingFitAfterSettle: false,
		layoutSettling: false,
		rafId: null,
		disposed: false,
		resizeObserver: null,
		hidden: false,
		frameCount: 0,
		graphRecord: null,
		graphRepo: null,
		graphView: null,
		viewRepo: null,
		status: null,
		dataLoaded: true,
		pendingPersisted: null,
		clearHydrating: null,
		runtimeReady: true,
		bufferedVaultData: null,
	};
}

function snapshotFrom(state: AppState, overrides: Partial<CanvasSnapshot> = {}): CanvasSnapshot {
	return {
		hoveredId: null,
		kbFocusId: null,
		selectedIds: [],
		pathMode: false,
		pathNodes: [],
		localRootId: null,
		localDepth: 1,
		localDirection: LocalDirection.Both,
		cutoffAt: null,
		isPlaying: false,
		playbackSpeed: 1,
		reveal: HistoryReveal.Eased,
		sidebarMode: state.sidebarMode,
		sidebarCollapsed: state.sidebarCollapsed,
		graphRecord: state.graphRecord,
		stats: { bindings: 3, visibleNodes: 5, visibleEdges: 4 },
		visibleNodeCount: 5,
		totalNodeCount: state.scene.renderNodes.length,
		bounds: state.scene.bounds,
		transform: state.transform,
		path: null,
		status: null,
		...overrides,
	};
}

type FakeController = GraphCanvasController & {
	calls: Record<string, unknown[]>;
};

function fakeController(state: AppState): FakeController {
	const calls: Record<string, unknown[]> = {};
	const record = (name: string) =>
		vi.fn((...args: unknown[]) => {
			const list = calls[name] ?? [];
			list.push(args);
			calls[name] = list;
		});
	const c = {
		calls,
		subscribe: () => () => {},
		getSnapshot: () => snapshotFrom(state),
		getState: () => state,
		setPattern: record("setPattern"),
		setSettings: record("setSettings"),
		setForces: record("setForces"),
		setReveal: record("setReveal"),
		reconcileScene: record("reconcileScene"),
		setPlaybackSpeed: record("setPlaybackSpeed"),
		setLocalDepth: record("setLocalDepth"),
		setCutoffFraction: record("setCutoffFraction"),
		togglePlayback: record("togglePlayback"),
		zoomIn: record("zoomIn"),
		zoomOut: record("zoomOut"),
		resetCamera: record("resetCamera"),
		fitToContent: record("fitToContent"),
		resetLayout: record("resetLayout"),
		setSidebar: record("setSidebar"),
		setLocalRoot: record("setLocalRoot"),
		setLocalParams: record("setLocalParams"),
		setPathMode: record("setPathMode"),
		pickPathEndpoint: record("pickPathEndpoint"),
		effectiveDb: () => state.db,
		svgExportInput: () => ({ nodes: [], edges: [] }),
		schedulePersist: record("schedulePersist"),
		scheduleGraphEntityPersist: record("scheduleGraphEntityPersist"),
		requestRepaint: record("requestRepaint"),
		applySettingsToSvg: record("applySettingsToSvg"),
		hydrateFromRuntime: record("hydrateFromRuntime"),
		setVaultData: record("setVaultData"),
		dispose: record("dispose"),
	};
	return c as unknown as FakeController;
}

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;
afterEach(async () => {
	await handle?.unmount();
	handle = null;
});

describe("GraphHeader (React)", () => {
	it("renders the glass header with Path / Animate / Filters / Settings / Export buttons", async () => {
		const state = makeState();
		handle = await renderInto(
			<GraphHeader controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		const header = handle.container.querySelector(".app-header");
		expect(header).not.toBeNull();
		const buttons = handle.container.querySelectorAll(".app-header__right .header-icon-btn");
		expect(buttons.length).toBe(5);
	});

	it("toggles the Filters sidebar via setSidebar when not already active", async () => {
		const state = makeState();
		const c = fakeController(state);
		handle = await renderInto(
			<GraphHeader controller={c} snap={snapshotFrom(state, { sidebarCollapsed: true })} />,
		);
		await flush();
		const filtersBtn = handle.container.querySelectorAll(".header-icon-btn")[2] as HTMLButtonElement;
		filtersBtn.click();
		expect(c.calls.setSidebar?.[0]).toEqual([SidebarMode.Filters, false]);
	});

	it("places the object ⋯ menu LAST when a Graph record is bound", async () => {
		const state = makeState();
		state.graphRecord = {
			id: "g1",
			name: "My Graph",
			description: "",
			createdAt: 0,
			updatedAt: 0,
			pattern: state.pattern,
		};
		handle = await renderInto(
			<GraphHeader controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		const right = handle.container.querySelector<HTMLElement>(".app-header__right");
		const last = right?.lastElementChild;
		expect(last?.classList.contains("bs-object-menu__more")).toBe(true);
	});

	it("still places the ⋯ menu LAST when no Graph record is bound (F-234: graph view actions)", async () => {
		const state = makeState();
		handle = await renderInto(
			<GraphHeader controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		const right = handle.container.querySelector<HTMLElement>(".app-header__right");
		const last = right?.lastElementChild;
		expect(last?.classList.contains("bs-object-menu__more")).toBe(true);
	});
});

describe("FiltersPanel (React)", () => {
	it("renders the Show toggles, match summary, and pattern editor sections", async () => {
		const state = makeState();
		handle = await renderInto(
			<FiltersPanel controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		expect(handle.container.querySelector("#show-toggles")).not.toBeNull();
		expect(handle.container.querySelector("#match-summary")).not.toBeNull();
		expect(handle.container.querySelector("#subject-list")).not.toBeNull();
		expect(handle.container.querySelector("#edge-list")).not.toBeNull();
	});

	it("groups system plumbing types into a trailing System sub-group (F-212)", async () => {
		const state = makeState();
		state.db = {
			...state.db,
			entities: [
				...state.db.entities,
				{
					id: "ent_sys_listview",
					type: SystemEntityType.ListView,
					properties: { name: "Saved view" },
					createdAt: 1,
					updatedAt: 1,
					deletedAt: null,
				},
				{
					id: "ent_sys_workflow",
					type: SystemEntityType.Workflow,
					properties: { name: "Nightly digest" },
					createdAt: 1,
					updatedAt: 1,
					deletedAt: null,
				},
			],
		};
		handle = await renderInto(
			<FiltersPanel controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		const userGroup = handle.container.querySelector("#show-toggles");
		const systemGroup = handle.container.querySelector("#show-toggles-system");
		expect(systemGroup).not.toBeNull();
		const labels = (root: Element | null) =>
			Array.from(root?.querySelectorAll(".show-toggle__label") ?? []).map((l) => l.textContent);
		expect(labels(systemGroup).sort()).toEqual(["ListView", "Workflow"]);
		expect(labels(userGroup)).not.toContain("ListView");
		expect(labels(userGroup)).not.toContain("Workflow");
		expect(labels(userGroup).length).toBeGreaterThan(0);
		expect(systemGroup?.querySelector(".show-toggles__group-label")?.textContent).toBe("System");
	});

	it("omits the System sub-group when only content types are present", async () => {
		const state = makeState();
		handle = await renderInto(
			<FiltersPanel controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		expect(handle.container.querySelector("#show-toggles-system")).toBeNull();
	});

	it("surfaces the snapshot match-summary counts", async () => {
		const state = makeState();
		handle = await renderInto(
			<FiltersPanel
				controller={fakeController(state)}
				snap={snapshotFrom(state, { stats: { bindings: 7, visibleNodes: 9, visibleEdges: 11 } })}
			/>,
		);
		await flush();
		const rows = handle.container.querySelectorAll(
			"#match-summary .match-summary__row span:last-child",
		);
		expect(Array.from(rows).map((r) => r.textContent)).toEqual(["7", "9", "11"]);
	});

	it("drives the edge subject pick through the shared select menu", async () => {
		const state = makeState();
		const controller = fakeController(state);
		handle = await renderInto(
			<BrainstormMenuProvider>
				<FiltersPanel controller={controller} snap={snapshotFrom(state)} />
			</BrainstormMenuProvider>,
		);
		await flush();

		const trigger = handle.container.querySelector<HTMLButtonElement>(
			"#edge-list .bs-select.edge-select",
		);
		expect(trigger).not.toBeNull();
		expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
		await act(async () => trigger?.click());

		const store = getActiveMenuStore();
		const open = store
			?.getAll()
			.find((m) => m.id === `${CONTEXT_MENU_ID}:${trigger?.getAttribute("aria-label")}`);
		expect(open).toBeDefined();
		const items = (open?.param.data as { items: ContextMenuItem[] }).items;
		const subjects = Object.entries(canonicalBerlinPattern().subjects);
		expect(items.map((it) => it.label)).toEqual(subjects.map(([k, s]) => s.displayName || k));
		expect(items.filter((it) => it.selected === true)).toHaveLength(1);

		const other = items.findIndex((it) => it.selected !== true);
		await act(async () => items[other]?.onSelect?.());
		expect(controller.calls.setPattern).toHaveLength(1);
		const [next] = controller.calls.setPattern?.[0] as [GraphPattern];
		expect(next.edges[0]?.from).toBe(subjects[other]?.[0]);
		await act(async () => closeContextMenu());
	});
});

describe("SettingsPanel (React)", () => {
	it("renders appearance toggles and one slider per force", async () => {
		const state = makeState();
		handle = await renderInto(
			<SettingsPanel controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		expect(handle.container.querySelectorAll(".settings-toggle").length).toBeGreaterThanOrEqual(4);
		expect(handle.container.querySelectorAll(".settings-slider").length).toBe(9); // 8 forces + depth
	});

	it("calls setSettings + reconcileScene when 'Icons' is toggled", async () => {
		const state = makeState();
		const c = fakeController(state);
		handle = await renderInto(<SettingsPanel controller={c} snap={snapshotFrom(state)} />);
		await flush();
		const iconsToggle = Array.from(handle.container.querySelectorAll(".settings-toggle")).find((l) =>
			l.textContent?.includes("Icons"),
		);
		const box = iconsToggle?.querySelector("input") as HTMLInputElement;
		box.click();
		expect(c.calls.setSettings).toBeTruthy();
		expect(c.calls.reconcileScene).toBeTruthy();
	});

	it("resets the layout via resetLayout", async () => {
		const state = makeState();
		const c = fakeController(state);
		handle = await renderInto(<SettingsPanel controller={c} snap={snapshotFrom(state)} />);
		await flush();
		(handle.container.querySelector(".settings-button") as HTMLButtonElement).click();
		expect(c.calls.resetLayout).toBeTruthy();
	});
});

describe("Legend (React)", () => {
	it("renders one row per link category with a swatch + count", async () => {
		const state = makeState();
		handle = await renderInto(
			<Legend controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		const rows = handle.container.querySelectorAll(".edge-legend__row");
		expect(rows.length).toBe(3);
		expect(handle.container.querySelectorAll(".edge-legend__swatch").length).toBe(3);
	});
});

describe("LocalBadge (React)", () => {
	it("is absent when no local root is active", async () => {
		const state = makeState();
		handle = await renderInto(
			<LocalBadge controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		expect(handle.container.querySelector(".local-badge")).toBeNull();
	});

	it("renders the depth stepper + direction segments + close when a root is set", async () => {
		const state = makeState();
		const rootId = state.scene.renderNodes[0]?.id ?? "x";
		const c = fakeController(state);
		handle = await renderInto(
			<LocalBadge controller={c} snap={snapshotFrom(state, { localRootId: rootId, localDepth: 2 })} />,
		);
		await flush();
		expect(handle.container.querySelector(".local-badge")).not.toBeNull();
		expect(handle.container.querySelectorAll(".local-badge__seg").length).toBe(3);
		(handle.container.querySelector(".local-badge__close") as HTMLButtonElement).click();
		expect(c.calls.setLocalRoot?.[0]).toEqual([null]);
	});
});

describe("HistoryFab (React)", () => {
	it("renders the FAB closed, opening the popover on click", async () => {
		const state = makeState();
		handle = await renderInto(
			<HistoryFab controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		const fab = handle.container.querySelector(".history-fab") as HTMLButtonElement;
		expect(fab.getAttribute("aria-expanded")).toBe("false");
		const pop = handle.container.querySelector("#history-popover") as HTMLElement;
		expect(pop.hidden).toBe(true);
		fab.click();
		await flush();
		expect(fab.getAttribute("aria-expanded")).toBe("true");
		expect((handle.container.querySelector("#history-popover") as HTMLElement).hidden).toBe(false);
	});

	it("marks the scrubber a non-modal, permanent surface (not a transient overlay)", async () => {
		// The scrubber is a docked, non-modal control that stays live while you
		// scrub — it must NOT be treated as an auto-dismissing popover by the
		// interaction-invariant sweep (tests/dogfood/lib/invariants), which keys
		// off `[role="dialog"]:not([data-permanent])`. Mis-classifying it made the
		// dogfood sweep false-fail Graph with a "stuck overlay".
		const state = makeState();
		handle = await renderInto(
			<HistoryFab controller={fakeController(state)} snap={snapshotFrom(state)} />,
		);
		await flush();
		const pop = handle.container.querySelector("#history-popover") as HTMLElement;
		expect(pop.getAttribute("role")).toBe("dialog");
		expect(pop.getAttribute("aria-modal")).toBe("false");
		expect(pop.hasAttribute("data-permanent")).toBe(true);
	});

	it("toggles playback from the play button", async () => {
		const state = makeState();
		const c = fakeController(state);
		handle = await renderInto(<HistoryFab controller={c} snap={snapshotFrom(state)} />);
		await flush();
		(handle.container.querySelector(".history-fab") as HTMLButtonElement).click();
		await flush();
		(handle.container.querySelector(".history-scrubber__button") as HTMLButtonElement).click();
		expect(c.calls.togglePlayback).toBeTruthy();
	});
});
