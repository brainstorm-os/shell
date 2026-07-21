/**
 * Unit coverage for the canvas controller's pure store/command seams
 * (9.13.16 Stage 1). The full controller mounts Pixi + needs a live DOM, so
 * these tests exercise the parts that are runtime-agnostic: the canvas-driven
 * `CanvasSnapshot` projection (`computeSnapshot`) and the scene-options
 * derivation (`sceneOptionsFrom`) that the Stage-2 React layer will read.
 */

import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";

import { DEMO_GRAPH, canonicalBerlinPattern } from "./demo/dataset";
import {
	type AppState,
	type PersistedState,
	SidebarMode,
	__testing,
} from "./graph-canvas-controller";
import { RELATED_TO_DEF } from "./logic/create-link";
import { LocalDirection } from "./logic/local-scope";
import { DEFAULT_LAYOUT_PARAMS } from "./render/force-layout";
import { LayoutDriver } from "./render/layout-driver";
import { buildScene, resolveGraphTheme } from "./render/scene";
import { IDENTITY_TRANSFORM } from "./render/svg-renderer";
import { createGraphViewRepository } from "./storage/graph-view-repository";
import { makeFakeEntities } from "./test/fake-entities";
import { HistoryReveal } from "./types/graph-view";

const {
	computeSnapshot,
	sceneOptionsFrom,
	persistViewCoords,
	tryLoadViewCoords,
	writeCreateLink,
	applyPersistedState,
	reconcileScene,
} = __testing;

function makeState(overrides: Partial<AppState> = {}): AppState {
	const theme = resolveGraphTheme();
	const scene = buildScene(canonicalBerlinPattern(), DEMO_GRAPH);
	const settings = {
		showUnmatched: true,
		showLabels: true,
		showArrows: true,
		showIcons: true,
		reveal: HistoryReveal.Eased,
	};
	const base: AppState = {
		pattern: canonicalBerlinPattern(),
		cutoffAt: null,
		isPlaying: false,
		playbackSpeed: 1,
		layoutNodes: new Map(),
		layoutParams: { ...DEFAULT_LAYOUT_PARAMS },
		renderer: null,
		scene,
		layout: new LayoutDriver({ ...DEFAULT_LAYOUT_PARAMS }),
		settings,
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
		theme,
		pinned: new Map(),
		transform: { ...IDENTITY_TRANSFORM },
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
		dataLoaded: false,
		pendingPersisted: null,
		clearHydrating: null,
		runtimeReady: false,
		bufferedVaultData: null,
	};
	return { ...base, ...overrides };
}

describe("computeSnapshot (canvas → chrome store contract)", () => {
	it("projects the canvas-driven fields the chrome reads", () => {
		const state = makeState({
			hoveredId: "person-a",
			pathMode: true,
			pathNodes: new Set(["a", "b"]),
			localRootId: "city-berlin",
			localDepth: 3,
			localDirection: LocalDirection.Out,
			cutoffAt: 123,
			isPlaying: true,
			playbackSpeed: 4,
			sidebarMode: SidebarMode.Settings,
			sidebarCollapsed: true,
		});
		const snap = computeSnapshot(state);
		expect(snap.hoveredId).toBe("person-a");
		expect(snap.pathMode).toBe(true);
		expect(snap.pathNodes).toEqual(["a", "b"]);
		expect(snap.localRootId).toBe("city-berlin");
		expect(snap.localDepth).toBe(3);
		expect(snap.localDirection).toBe(LocalDirection.Out);
		expect(snap.cutoffAt).toBe(123);
		expect(snap.isPlaying).toBe(true);
		expect(snap.playbackSpeed).toBe(4);
		expect(snap.sidebarMode).toBe(SidebarMode.Settings);
		expect(snap.sidebarCollapsed).toBe(true);
		expect(snap.reveal).toBe(HistoryReveal.Eased);
	});

	it("derives scene topology stats + counts from the live scene", () => {
		const state = makeState();
		const snap = computeSnapshot(state);
		expect(snap.totalNodeCount).toBe(state.scene.renderNodes.length);
		expect(snap.stats.visibleNodes).toBeGreaterThanOrEqual(0);
		expect(snap.stats.visibleEdges).toBeGreaterThanOrEqual(0);
		expect(snap.visibleNodeCount).toBeLessThanOrEqual(snap.totalNodeCount);
		expect(snap.bounds).toEqual(state.scene.bounds);
	});

	it("surfaces the path status only while Path view is on", () => {
		const off = computeSnapshot(
			makeState({ pathMode: false, pathStatus: { text: "x", warn: false } }),
		);
		expect(off.path).toBeNull();
		const on = computeSnapshot(
			makeState({ pathMode: true, pathStatus: { text: "2 hops", warn: false } }),
		);
		expect(on.path).toEqual({ text: "2 hops", warn: false });
	});
});

describe("sceneOptionsFrom", () => {
	it("threads cutoff + reveal + visibility flags into SceneOptions", () => {
		const theme = resolveGraphTheme();
		const opts = sceneOptionsFrom(
			500,
			{
				showUnmatched: false,
				showLabels: true,
				showArrows: true,
				showIcons: false,
				reveal: HistoryReveal.Strict,
			},
			theme,
		);
		expect(opts.cutoffAt).toBe(500);
		expect(opts.reveal).toBe(HistoryReveal.Strict);
		expect(opts.showUnmatched).toBe(false);
		expect(opts.showIcons).toBe(false);
		expect(opts.theme).toBe(theme);
	});
});

describe("per-view coordinate persistence (9.13.6, OQ-GR-2 (a))", () => {
	function boundGraphRecord() {
		return {
			id: "graph-1",
			name: "Bound graph",
			description: "",
			createdAt: 1,
			updatedAt: 1,
			pattern: canonicalBerlinPattern(),
		};
	}

	it("persistViewCoords writes the pinned map; tryLoadViewCoords restores it", async () => {
		const fake = makeFakeEntities();
		const viewRepo = createGraphViewRepository(fake.entities);
		const state = makeState({
			viewRepo,
			graphRecord: boundGraphRecord(),
			pinned: new Map([
				["n1", { x: 5, y: 6 }],
				["n2", { x: -7, y: 8.5 }],
			]),
		});

		await tryLoadViewCoords(state);
		expect(state.graphView).not.toBeNull();
		expect(state.graphView?.graphId).toBe("graph-1");
		await persistViewCoords(state);

		const restored = makeState({ viewRepo, graphRecord: boundGraphRecord() });
		await tryLoadViewCoords(restored);
		expect(restored.graphView?.id).toBe(state.graphView?.id);
		expect(restored.pinned.get("n1")).toEqual({ x: 5, y: 6 });
		expect(restored.pinned.get("n2")).toEqual({ x: -7, y: 8.5 });
	});

	it("is inert for unbound launches (no graphRecord → no view, no writes)", async () => {
		const fake = makeFakeEntities();
		const viewRepo = createGraphViewRepository(fake.entities);
		const state = makeState({ viewRepo, pinned: new Map([["n1", { x: 1, y: 2 }]]) });

		await tryLoadViewCoords(state);
		expect(state.graphView).toBeNull();
		await persistViewCoords(state);
		expect(fake.records.size).toBe(0);
		expect(fake.docs.size).toBe(0);
	});
});

describe("local view (reconcileScene scopes the rendered topology)", () => {
	it("renders the full graph when no root is focused", () => {
		const state = makeState({ localRootId: null });
		reconcileScene(state);
		expect(state.scene.renderNodes.length).toBe(DEMO_GRAPH.entities.length);
	});

	it("collapses to the root + its neighbours within the configured depth", () => {
		const state = makeState({
			localRootId: "ent_person_alice",
			localDepth: 1,
			localDirection: LocalDirection.Both,
		});
		reconcileScene(state);
		const ids = new Set(state.scene.renderNodes.map((n) => n.id));
		// Alice's depth-1 neighbourhood in DEMO_GRAPH: RWTH + Berlin.
		expect(ids.has("ent_person_alice")).toBe(true);
		expect(ids.has("ent_school_rwth")).toBe(true);
		expect(ids.has("ent_city_berlin")).toBe(true);
		// A node two hops away (Bob shares RWTH/Berlin with Alice) must NOT
		// appear at depth 1 — proof the scope actually shrank the topology.
		expect(ids.has("ent_person_bob")).toBe(false);
		expect(state.scene.renderNodes.length).toBeLessThan(DEMO_GRAPH.entities.length);
	});

	it("effectiveDb returns the whole graph while local mode is off (no root)", () => {
		const state = makeState({ localRootId: null });
		expect(__testing.effectiveDb(state)).toBe(DEMO_GRAPH);
	});

	it("widens the neighbourhood as depth increases", () => {
		const shallow = makeState({ localRootId: "ent_person_alice", localDepth: 1 });
		reconcileScene(shallow);
		const deep = makeState({ localRootId: "ent_person_alice", localDepth: 2 });
		reconcileScene(deep);
		expect(deep.scene.renderNodes.length).toBeGreaterThan(shallow.scene.renderNodes.length);
	});

	it("preserves the camera zoom/pan when only the local depth changes", () => {
		const state = makeState({
			localRootId: "ent_person_alice",
			localDepth: 1,
			transform: { k: 2.5, tx: 120, ty: -80 },
		});
		__testing.setLocalParams(state, { depth: 2 }, () => {});
		expect(state.localDepth).toBe(2);
		expect(state.transform).toEqual({ k: 2.5, tx: 120, ty: -80 });
	});

	it("resets the camera when the local root changes", () => {
		const state = makeState({
			localRootId: "ent_person_alice",
			localDepth: 1,
			transform: { k: 2.5, tx: 120, ty: -80 },
		});
		__testing.setLocalRoot(state, "ent_person_bob", () => {});
		expect(state.localRootId).toBe("ent_person_bob");
		expect(state.transform).toEqual(IDENTITY_TRANSFORM);
	});
});

describe("writeCreateLink (9.13.11 drag-to-create-link write path)", () => {
	it("writes the target id into the picked entityRef property on the source", async () => {
		const fake = makeFakeEntities();
		const source = await fake.entities.create("brainstorm/Note/v1", { name: "Source" });
		await fake.entities.create("brainstorm/Person/v1", { name: "Target" }, "target-1");
		const def: PropertyDef = {
			key: "about",
			name: "About",
			icon: null,
			valueType: ValueType.EntityRef,
		};
		const state = makeState();

		await writeCreateLink(state, fake.entities, def, source.id, "target-1", () => {});

		expect(fake.records.get(source.id)?.properties.about).toBe("target-1");
		expect(state.status?.kind).toBe("ready");
	});

	it("appends to a multi-valued def and reports already-linked as a no-op", async () => {
		const fake = makeFakeEntities();
		const source = await fake.entities.create("brainstorm/Note/v1", {
			related: [{ value: "t1" }],
		});
		const state = makeState();

		await writeCreateLink(state, fake.entities, RELATED_TO_DEF, source.id, "t2", () => {});
		expect(fake.records.get(source.id)?.properties.related).toEqual([
			{ value: "t1" },
			{ value: "t2" },
		]);

		await writeCreateLink(state, fake.entities, RELATED_TO_DEF, source.id, "t2", () => {});
		expect(fake.records.get(source.id)?.properties.related).toEqual([
			{ value: "t1" },
			{ value: "t2" },
		]);
	});

	it("surfaces a warn status when the write throws", async () => {
		const fake = makeFakeEntities();
		const state = makeState();
		await writeCreateLink(state, fake.entities, RELATED_TO_DEF, "missing-source", "t1", () => {});
		expect(state.status?.kind).toBe("warn");
	});
});

describe("applyPersistedState — empty-canvas self-heal", () => {
	function rawWith(history: PersistedState["history"]): PersistedState {
		const state = makeState();
		return {
			version: 8,
			settings: state.settings,
			forces: state.forces,
			sidebarMode: SidebarMode.Filters,
			sidebarCollapsed: false,
			pinned: {},
			...(history ? { history } : {}),
		};
	}

	it("resets a restored time cutoff that hides every node (DEMO_GRAPH entities are 2025)", () => {
		const state = makeState();
		expect(state.scene.renderNodes.length).toBeGreaterThan(0);
		// cutoffAt = 1ms epoch is long before any demo entity's createdAt, so the
		// reveal gate (`createdAt <= cutoffAt`) excludes everything.
		applyPersistedState(
			state,
			rawWith({
				enabled: true,
				startAt: null,
				endAt: null,
				cutoffAt: 1,
				speed: 1,
				reveal: HistoryReveal.Eased,
			}),
		);
		expect(state.cutoffAt).toBeNull();
		expect(state.scene.renderNodes.length).toBeGreaterThan(0);
	});

	it("keeps a valid cutoff that still reveals nodes", () => {
		const state = makeState();
		// A cutoff far in the future reveals every (2025) entity → not stranded.
		const future = Date.parse("2030-01-01T00:00:00Z");
		applyPersistedState(
			state,
			rawWith({
				enabled: true,
				startAt: null,
				endAt: null,
				cutoffAt: future,
				speed: 1,
				reveal: HistoryReveal.Eased,
			}),
		);
		expect(state.cutoffAt).toBe(future);
		expect(state.scene.renderNodes.length).toBeGreaterThan(0);
	});
});
