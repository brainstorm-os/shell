/**
 * Graph canvas controller (9.13.16 Stage 1) — the self-contained imperative
 * core extracted out of `app.ts`. It owns ONLY the canvas surface: the Pixi
 * lifecycle, the rAF render/tick loop, the off-thread force simulation, every
 * pointer/drag/hover/pan/zoom handler, scene build + reconcile, the
 * visibility-pause, the vault data hookup, persistence, theme tracking, and the
 * `__graphProbe` diagnostic surface.
 *
 * The fragile fragments (rAF loop + `geometryDirty` edge gate, the d3-force
 * simulation, the DUAL-source visibility pause, `destroyPixi { texture: false }`)
 * are moved here BYTE-FOR-BYTE from the previous `app.ts` — Stage 1 is a pure
 * refactor: the canvas must behave identically.
 *
 * The chrome (header, sidebar pattern editor, force sliders, settings toggles,
 * legend, scrubber/history popover) stays imperative in `app.ts` for now and
 * drives this controller through two surfaces:
 *   - a plain observer **store** (`subscribe` / `getSnapshot`) of canvas-driven
 *     values the chrome reads (Stage 2 wraps it with `useSyncExternalStore`);
 *   - imperative **command methods** the chrome calls instead of mutating the
 *     shared `AppState` directly.
 *
 * `getState()` exposes the live `AppState` for the chrome's read-only render
 * projections (pattern / settings / scene / db); all MUTATIONS route through the
 * command methods so Stage 2 can swap the chrome without reaching into state.
 */

import { openEntity } from "@brainstorm/sdk";
import type { PropertyDef } from "@brainstorm/sdk-types";
import { type LiveRegionHandle, attachLiveRegion } from "@brainstorm/sdk/a11y";
import { IconName } from "@brainstorm/sdk/icon";
import {
	type AnchoredMenuItem,
	type ObjectMenuExtraItem,
	type ObjectMenuRuntime,
	type ObjectMenuTriggerHandle,
	attachObjectMenuTrigger,
	closeObjectMenu,
	openAnchoredMenu,
	openObjectMenu,
} from "@brainstorm/sdk/object-menu";
import { SelectionModifier, modifierFromEvent } from "@brainstorm/sdk/selection";
import { attachShortcut } from "@brainstorm/sdk/shortcut";

import { plural, t } from "./i18n/t";
import {
	SpatialDirection,
	focusableNodes,
	initialFocus,
	sequentialFocusStep,
	spatialFocusStep,
} from "./keyboard/canvas-focus";
import { GRAPH_CHORDS, GraphAction, KEYBOARD_ZOOM_STEP } from "./keyboard/chords";
import { NodeClickAction, singleClickAction } from "./logic/click-gestures";
import {
	NodeDragKind,
	RELATED_TO_DEF,
	applicableLinkDefs,
	detectDragKind,
	nextRefValue,
} from "./logic/create-link";
import { setupGraphPresence } from "./logic/graph-presence-bind";
import { applyNodeSelection, clearNodeSelection } from "./logic/graph-selection";
import type { NodeCoord } from "./logic/graph-view-yjs-codec";
import { backfillCreatedAt } from "./logic/history-backfill";
import { captureHistoryState, restoreHistoryState } from "./logic/history-state";
import type { EntityRow, InMemoryGraph } from "./logic/in-memory-graph";
import {
	LinkCategory,
	linkCategory,
	linkReasonLabel,
	linkReasonShortLabel,
} from "./logic/link-reason";
import {
	DEFAULT_LOCAL_DEPTH,
	DEFAULT_LOCAL_DIRECTION,
	LocalDirection,
	clampLocalDepth,
	localScope,
} from "./logic/local-scope";
import { isStaleEmptyPattern } from "./logic/match-pattern";
import { inspectorProperties } from "./logic/node-properties";
import { defaultPattern, isUsablePattern } from "./logic/pattern-edit";
import { CURRENT_PERSISTED_VERSION, shouldRestorePersisted } from "./logic/persisted-version";
import { allShortestPaths, buildAdjacency, pathHops, shortestPath } from "./logic/shortest-path";
import { focusNodeTransform } from "./render/focus-node";
import {
	DEFAULT_LAYOUT_PARAMS,
	type LayoutEdge,
	type LayoutNode,
	type LayoutParams,
	seedPositions,
} from "./render/force-layout";
import { LayoutDriver } from "./render/layout-driver";
import { rawNodeLabel } from "./render/node-label";
import { type Renderer, chooseRenderer, mountRenderer } from "./render/renderer";
import {
	EASE_WINDOW_MS,
	type GraphTheme,
	RECENT_WINDOW_MS,
	type Scene,
	type SceneOptions,
	buildScene,
	resolveGraphTheme,
	sceneStats,
} from "./render/scene";
import {
	ARROW_HIDE_BELOW_K,
	type CameraTransform,
	HOVER_DIM_ALPHA,
	IDENTITY_TRANSFORM,
	type RenderEdge,
	type Snapshot,
} from "./render/svg-renderer";
import {
	type GraphRecord,
	type GraphRepository,
	createGraphRepository,
} from "./storage/graph-repository";
import {
	type GraphViewRecord,
	type GraphViewRepository,
	createGraphViewRepository,
} from "./storage/graph-view-repository";
import { type EntitiesService, getGraphEntitiesRuntime } from "./storage/runtime";
import { type HistoryAnimationState, HistoryReveal } from "./types/graph-view";
import type { GraphPattern } from "./types/pattern";

const SCRUBBER_STEPS = 1000;
const PLAYBACK_SPEEDS = [1, 2, 4, 8, 16] as const;

/** Wall-clock seconds 1× playback takes to cover the entire dataset range. */
const PLAYBACK_FULL_RANGE_SECONDS_AT_1X = 10;

const EMPTY_GRAPH: InMemoryGraph = { entities: [], links: [] };

export type GraphSettings = {
	showUnmatched: boolean;
	showLabels: boolean;
	showArrows: boolean;
	showIcons: boolean;
	reveal: HistoryReveal;
};

export type ForceSettings = {
	charge: number;
	chargeDistanceMax: number;
	linkDistance: number;
	centerStrength: number;
	collidePadding: number;
	collideStrength: number;
	velocityDecay: number;
	maxSpeed: number;
};

type DragState = {
	pointerId: number;
	nodeId: string;
};

/** An in-flight drag-to-create-link gesture (9.13.11): started from a
 *  node's rim ("edge handle") or via Alt-drag, finished by releasing over
 *  the target node. */
type LinkDragState = {
	pointerId: number;
	sourceId: string;
};

export enum SidebarMode {
	Filters = "filters",
	Settings = "settings",
}

/** Shape persisted to `storage.kv` under the `graph:state` key. */
export type PersistedState = {
	version: 2 | 3 | 4 | 5 | 6 | 7 | 8;
	presetId?: string | null;
	pattern?: GraphPattern;
	settings: GraphSettings;
	forces: ForceSettings;
	sidebarMode: SidebarMode;
	sidebarCollapsed: boolean;
	pinned: Record<string, { x: number; y: number }>;
	transform?: CameraTransform;
	localRootId?: string | null;
	localDepth?: number;
	localDirection?: LocalDirection;
	history?: HistoryAnimationState;
};

export type AppState = {
	pattern: GraphPattern;
	cutoffAt: number | null;
	isPlaying: boolean;
	playbackSpeed: number;
	layoutNodes: Map<string, LayoutNode>;
	layoutParams: LayoutParams;
	renderer: Renderer | null;
	scene: Scene;
	layout: LayoutDriver;
	settings: GraphSettings;
	forces: ForceSettings;
	drag: DragState | null;
	linkDrag: LinkDragState | null;
	hoveredId: string | null;
	kbFocusId: string | null;
	/** 9.13.11 — click-selected node ids (multi-select). Drives the inspector
	 *  + the focus-alpha emphasis (selected + neighbours bright, rest dim). */
	selectedIds: Set<string>;
	/** Range-selection anchor (last plainly-selected / toggled-on node). */
	selectionAnchor: string | null;
	focusAlphaByNode: Map<string, number>;
	focusAlphaByEdge: Map<string, number>;
	db: InMemoryGraph;
	sidebarMode: SidebarMode;
	sidebarCollapsed: boolean;
	theme: GraphTheme;
	pinned: Map<string, { x: number; y: number }>;
	transform: CameraTransform;
	pan: {
		pointerId: number;
		startTx: number;
		startTy: number;
		startX: number;
		startY: number;
	} | null;
	localRootId: string | null;
	localDepth: number;
	localDirection: LocalDirection;
	pathMode: boolean;
	pathStart: string | null;
	pathNodes: Set<string>;
	pathStatus: { text: string; warn: boolean } | null;
	lastPaint: {
		k: number;
		tx: number;
		ty: number;
		hoveredId: string | null;
		arrowLod: boolean;
	} | null;
	focusAnimating: boolean;
	forceRepaint: boolean;
	pendingFitAfterSettle: boolean;
	layoutSettling: boolean;
	rafId: number | null;
	disposed: boolean;
	/** Owned by `bindCanvasResize`; disconnected on dispose so a stale
	 *  observer can't resize a destroyed Pixi renderer (StrictMode's dev
	 *  double-mount leaks one observer per discarded controller otherwise). */
	resizeObserver: ResizeObserver | null;
	hidden: boolean;
	frameCount: number;
	graphRecord: GraphRecord | null;
	graphRepo: GraphRepository | null;
	/** The bound Graph's default `GraphView/v1` — owns the per-view node
	 *  coordinates (OQ-GR-2 (a)). Null for unbound launches (kv persistence
	 *  stays the default there, mirroring 9.13.2's posture). */
	graphView: GraphViewRecord | null;
	viewRepo: GraphViewRepository | null;
	status: { text: string; kind: "ready" | "warn" } | null;
	dataLoaded: boolean;
	pendingPersisted: PersistedState | null;
	clearHydrating: (() => void) | null;
	runtimeReady: boolean;
	bufferedVaultData: VaultSnapshot | null;
	/** PRES-3d — republish selection into the canvas presence channel. */
	presenceRepublish?: () => void;
	presenceBindGraph?: (graphEntityId: string | null) => void;
};

/** The canvas-driven snapshot the chrome subscribes to. Stage 2's React wraps
 *  this in `useSyncExternalStore`; Stage 1's imperative chrome reads it via
 *  `getSnapshot()` + `subscribe()`. Plain values only (no Maps/Sets) so the
 *  identity changes on every emit and a `===` comparison is a valid gate. */
export type CanvasSnapshot = {
	hoveredId: string | null;
	kbFocusId: string | null;
	/** 9.13.11 — click-selected node ids (drives the editable inspector). */
	selectedIds: readonly string[];
	pathMode: boolean;
	pathNodes: readonly string[];
	localRootId: string | null;
	localDepth: number;
	localDirection: LocalDirection;
	cutoffAt: number | null;
	isPlaying: boolean;
	playbackSpeed: number;
	reveal: HistoryReveal;
	sidebarMode: SidebarMode;
	sidebarCollapsed: boolean;
	graphRecord: GraphRecord | null;
	/** Scene topology stats (`sceneStats`) — bindings / visible nodes / edges. */
	stats: { bindings: number; visibleNodes: number; visibleEdges: number };
	/** Total render-node count + revealed count at the current cutoff. */
	visibleNodeCount: number;
	totalNodeCount: number;
	bounds: { min: number; max: number } | null;
	transform: CameraTransform;
	/** Path-view status line for the chrome's status pill: the pick hint while
	 *  selecting, or the hop / no-path result after the second pick. Null when
	 *  Path view is off (the chrome clears the pill). */
	path: { text: string; warn: boolean } | null;
	/** Status-pill content (load / vault / pattern advisories). Null hides the
	 *  pill. The chrome renders Path-view status (`path`) over this when active. */
	status: { text: string; kind: "ready" | "warn" } | null;
};

export type GraphCanvasController = {
	/** Subscribe to canvas-driven state changes; returns an unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** Current canvas-driven snapshot (referentially stable until the next emit). */
	getSnapshot(): CanvasSnapshot;
	/** Live `AppState` for the chrome's read-only render projections (pattern,
	 *  settings, scene, db). Never mutate it — use the commands. */
	getState(): AppState;
	/** 9.13.11 — write one property of a selected node (the editable inspector).
	 *  Optimistic in-memory patch + the authoritative `entities.update`. */
	updateNodeProperty(id: string, key: string, value: unknown): Promise<void>;
	/** Replace the editable pattern + re-match. `reseed:false` keeps the layout
	 *  (display-name-only edits). */
	setPattern(next: GraphPattern, options?: { reseed: boolean }): void;
	setSettings(patch: Partial<GraphSettings>): void;
	setForces(patch: Partial<ForceSettings>): void;
	setReveal(reveal: HistoryReveal): void;
	/** Rebuild the scene from current settings/pattern without re-seeding the
	 *  layout — for settings toggles that only reshade (show-unmatched, icons). */
	reconcileScene(): void;
	setPlaybackSpeed(speed: number): void;
	/** Set the local-view depth: re-scopes live when a local root is active,
	 *  else remembers it for the next local view. */
	setLocalDepth(depth: number): void;
	/** Set the history cutoff fraction (0..1, ≥1 = "Now"); pauses playback. */
	setCutoffFraction(fraction: number): void;
	togglePlayback(): void;
	zoomIn(): void;
	zoomOut(): void;
	resetCamera(): void;
	/** Fit the camera so every laid-out node is in view (the survey framing the
	 *  one-time bootstrap runs). A no-op until the layout has positions. */
	fitToContent(): void;
	resetLayout(): void;
	setSidebar(mode: SidebarMode, collapsed: boolean): void;
	/** Enter local-graph mode (the Settings toggle). Roots on the current
	 *  selection/hover, else the most-connected node, so the scoped view is
	 *  immediately meaningful. A no-op when the graph has no nodes. */
	enterLocalView(): void;
	setLocalRoot(rootId: string | null): void;
	setLocalParams(patch: { depth?: number; direction?: LocalDirection }): void;
	setPathMode(on: boolean): void;
	pickPathEndpoint(nodeId: string): void;
	/** Export inputs the chrome serialises. */
	effectiveDb(): InMemoryGraph;
	svgExportInput(): SvgExportInput;
	/** Persist now (debounced) + persist the bound Graph/v1 entity. */
	schedulePersist(): void;
	scheduleGraphEntityPersist(): void;
	/** Force one repaint (chrome toggles that only reshade existing nodes). */
	requestRepaint(): void;
	/** Mirror label/arrow settings onto the renderer element (CSS parity). */
	applySettingsToSvg(): void;
	/** Run the one-time bootstrap (persisted state, launch graph, runtime
	 *  intents, theme tracking); called once after the runtime is ready. */
	hydrateFromRuntime(opts: HydrateCallbacks): void;
	/** Feed the live vault snapshot (React's `useVaultEntities`). The first call
	 *  runs the post-load bootstrap (launch graph + fit + focus); subsequent
	 *  calls reshade without refitting the camera (preserves the user's view). */
	setVaultData(snapshot: VaultDataSnapshot): void;
	/** Tear down rAF + worker + Pixi (idempotent). */
	dispose(): void;
};

export type SvgExportNode = {
	id: string;
	x: number;
	y: number;
	radius: number;
	color: string;
	alpha: number;
	label: string;
};
export type SvgExportEdge = {
	sourceId: string;
	destId: string;
	color: string;
	alpha: number;
};
export type SvgExportInput = { nodes: SvgExportNode[]; edges: SvgExportEdge[] };

/** The chrome's runtime hand-off so the controller can run the one-time
 *  bootstrap (persisted state, launch graph, runtime intents, theme) without
 *  reaching back into the React chrome. Vault data is fed in separately via
 *  `setVaultData` (Stage 3: React owns the `useVaultEntities` subscription). */
export type HydrateCallbacks = {
	runtime: GraphRuntime | null;
	/** Cleared after the first paint settles (drops the `data-hydrating` veil). */
	clearHydrating(): void;
};

/** The vault snapshot shape React feeds in via `setVaultData`. Re-exported so
 *  the React chrome can adapt the shared `useVaultEntities` snapshot to it. */
export type VaultDataSnapshot = VaultSnapshot;

/* ── Runtime shapes (vault data hookup) ─────────────────────────────────── */

type VaultEntityShape = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	ownerAppId: string;
};
type VaultLinkShape = {
	id: string;
	sourceEntityId: string;
	destEntityId: string;
	linkType: string;
	detail?: string;
	createdAt: number;
	deletedAt: null;
};
type PatternQueryReply =
	| { ok: true; snapshot: VaultSnapshot }
	| {
			ok: false;
			error: { kind: "pattern-too-expensive" | "pattern-invalid"; message: string };
	  };
type VaultSnapshot = {
	entities: VaultEntityShape[];
	links: VaultLinkShape[];
};
type GraphLifecycleEvent = {
	type: string;
	intent?: { verb?: string; payload?: { entityId?: unknown } };
};
export type GraphRuntime = {
	on(event: "ready", h: () => void): void;
	on(event: "intent", h: (event: GraphLifecycleEvent) => void): void;
	app?: { id: string };
	launch?: { reason: string; entityId?: string };
	capabilities?: readonly string[];
	services?: {
		vaultEntities?: {
			list(): Promise<VaultSnapshot>;
			queryPattern?(pattern: GraphPattern): Promise<PatternQueryReply>;
		};
		intents?: {
			dispatch(intent: { verb: string; payload: Record<string, unknown> }): Promise<unknown>;
		};
		properties?: {
			list(): Promise<{ properties: Readonly<Record<string, PropertyDef>> }>;
			getProperty(key: string): Promise<PropertyDef | null>;
			setProperty(def: PropertyDef): Promise<void>;
		};
		dashboard?: {
			pin?(t: { entityId: string }): Promise<boolean>;
			unpin?(t: { entityId: string }): Promise<boolean>;
			isPinned?(t: { entityId: string }): Promise<boolean>;
		};
		files?: {
			requestSave(opts?: {
				readonly title?: string;
				readonly filters?: readonly {
					readonly name: string;
					readonly extensions: readonly string[];
				}[];
				readonly suggestedName?: string;
			}): Promise<{ readonly handleId: string; readonly displayName: string } | null>;
			write(
				handle: { readonly handleId: string; readonly displayName: string },
				data: Uint8Array | ArrayBuffer,
			): Promise<void>;
		};
	};
};

function getRuntime(): GraphRuntime | null {
	return (window as unknown as { brainstorm?: GraphRuntime }).brainstorm ?? null;
}

/* ── Camera constants ───────────────────────────────────────────────────── */

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 10;
const ZOOM_WHEEL_SENSITIVITY = 0.0015;
const FIT_PADDING = 0.88;
const KEYBOARD_PAN_FRACTION = 0.15;

/* ── Hover / edge-hit constants ─────────────────────────────────────────── */

const PREVIEW_DWELL_MS = 450;
const FOCUS_FADE_TIME_CONSTANT_MS = 180;
const EDGE_HIT_THRESHOLD_PX = 6;
const EDGE_HIT_THRESHOLD_SQ = EDGE_HIT_THRESHOLD_PX * EDGE_HIT_THRESHOLD_PX;
const EDGE_HIT_MAX_EDGES = 6000;

const STORAGE_KEY = "graph:state";

type StorageBag = {
	put(key: string, value: unknown): Promise<unknown>;
	get<T>(key: string): Promise<T | null>;
};

function getStorage(): StorageBag | null {
	const services = getRuntime()?.services as
		| { storage?: StorageBag; settings?: StorageBag }
		| undefined;
	return services?.settings ?? services?.storage ?? null;
}

export type GraphCanvasControllerOptions = {
	container: HTMLElement;
	/** The chrome callback bundle for status / chrome re-render during hydrate.
	 *  Optional at construction; supplied via `hydrateFromRuntime`. */
};

/** Stand up the controller: mount Pixi, prime the layout, install the canvas
 *  handlers + visibility pause + `__graphProbe`, and start the rAF loop. */
export async function createGraphCanvasController(
	opts: GraphCanvasControllerOptions,
): Promise<GraphCanvasController> {
	const { container } = opts;

	const layoutParams = computeLayoutParams(container);
	const initialPattern = defaultPattern();

	const initialSettings: GraphSettings = {
		showUnmatched: true,
		showLabels: true,
		showArrows: true,
		showIcons: true,
		reveal: HistoryReveal.Eased,
	};
	const initialForces: ForceSettings = {
		charge: DEFAULT_LAYOUT_PARAMS.charge,
		chargeDistanceMax: DEFAULT_LAYOUT_PARAMS.chargeDistanceMax,
		linkDistance: DEFAULT_LAYOUT_PARAMS.linkDistance,
		centerStrength: DEFAULT_LAYOUT_PARAMS.centerStrength,
		collidePadding: DEFAULT_LAYOUT_PARAMS.collidePadding,
		collideStrength: DEFAULT_LAYOUT_PARAMS.collideStrength,
		velocityDecay: DEFAULT_LAYOUT_PARAMS.velocityDecay,
		maxSpeed: DEFAULT_LAYOUT_PARAMS.maxSpeed,
	};
	const initialTheme = resolveGraphTheme();
	const initialScene = buildScene(
		initialPattern,
		EMPTY_GRAPH,
		sceneOptionsFrom(null, initialSettings, initialTheme),
	);
	const layoutNodes = primeLayout(initialScene, layoutParams);
	const layout = new LayoutDriver(layoutParams);

	const rendererKind = chooseRenderer();
	const stateRef: { current: AppState | null } = { current: null };
	const renderer = await mountRenderer(
		rendererKind,
		container,
		layoutParams.width,
		layoutParams.height,
		() => {
			if (stateRef.current) stateRef.current.forceRepaint = true;
		},
	);

	const state: AppState = {
		pattern: initialPattern,
		cutoffAt: null,
		isPlaying: false,
		playbackSpeed: 1,
		layoutNodes,
		layoutParams,
		renderer,
		scene: initialScene,
		layout,
		settings: initialSettings,
		forces: initialForces,
		drag: null,
		linkDrag: null,
		db: EMPTY_GRAPH,
		sidebarMode: SidebarMode.Filters,
		sidebarCollapsed: false,
		theme: initialTheme,
		pinned: new Map(),
		hoveredId: null,
		kbFocusId: null,
		selectedIds: new Set(),
		selectionAnchor: null,
		focusAlphaByNode: new Map(),
		focusAlphaByEdge: new Map(),
		transform: { ...IDENTITY_TRANSFORM },
		pan: null,
		localRootId: null,
		localDepth: DEFAULT_LOCAL_DEPTH,
		localDirection: DEFAULT_LOCAL_DIRECTION,
		pathMode: false,
		pathStart: null,
		pathNodes: new Set<string>(),
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
		graphRepo: (() => {
			const runtime = getGraphEntitiesRuntime();
			return runtime?.entities ? createGraphRepository(runtime.entities) : null;
		})(),
		graphView: null,
		viewRepo: (() => {
			const runtime = getGraphEntitiesRuntime();
			return runtime?.entities ? createGraphViewRepository(runtime.entities) : null;
		})(),
		status: null,
		dataLoaded: false,
		pendingPersisted: null,
		clearHydrating: null,
		runtimeReady: false,
		bufferedVaultData: null,
	};
	stateRef.current = state;

	const presenceBind = setupGraphPresence({
		container,
		getState: () => state,
		rendererElement: renderer.element,
	});
	state.presenceRepublish = () => presenceBind.republish();
	state.presenceBindGraph = (graphEntityId) => presenceBind.bindGraph(graphEntityId);

	/* ── Observer store ──────────────────────────────────────────────────── */

	const listeners = new Set<() => void>();
	let snapshot: CanvasSnapshot = computeSnapshot(state);
	const emit = (): void => {
		snapshot = computeSnapshot(state);
		for (const l of listeners) l();
	};
	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	const getSnapshot = (): CanvasSnapshot => snapshot;

	/* ── Diagnostic probe (Playwright specs depend on this) ──────────────── */

	if (typeof window !== "undefined") {
		(window as unknown as { __graphProbe?: unknown }).__graphProbe = {
			nodes: () =>
				Array.from(state.layoutNodes, ([id, n]) => ({
					id,
					x: n.x,
					y: n.y,
					vx: n.vx,
					vy: n.vy,
					fx: n.fx,
					fy: n.fy,
				})),
			edges: () =>
				state.scene.renderEdges.map((e) => ({
					source: e.link.sourceEntityId,
					target: e.link.destEntityId,
				})),
			canvas: () => state.renderer?.element ?? null,
			frames: () => state.frameCount,
			hidden: () => state.hidden,
			worldToClient: (x: number, y: number) =>
				state.renderer?.nodeToClient(state.transform, x, y) ?? { x: 0, y: 0 },
			setPathMode: (on: boolean) => {
				if (state.pathMode !== on) togglePathMode(state, emit);
			},
			pathPick: (id: string) => handlePathPick(state, id, emit),
			pathNodeIds: () => Array.from(state.pathNodes),
			selectedIds: () => Array.from(state.selectedIds),
			selectNode: (id: string) => selectSingleNode(state, id, emit),
		};
	}

	/* ── Lifecycle + visibility pause (DUAL-source) ──────────────────────── */

	if (typeof window !== "undefined") {
		window.addEventListener(
			"pagehide",
			() => {
				state.disposed = true;
				if (state.rafId !== null) {
					cancelAnimationFrame(state.rafId);
					state.rafId = null;
				}
				state.layout.dispose();
				state.renderer?.destroy();
				closeObjectMenu();
				hideLinkDragLine();
				previewMenuTrigger?.dispose();
				previewMenuTrigger = null;
				presenceBind.dispose();
			},
			{ once: true },
		);

		let occluded = document.visibilityState === "hidden";
		let parked = false;
		const recomputeHidden = (): void => {
			const nowHidden = occluded || parked;
			if (state.disposed || nowHidden === state.hidden) return;
			state.hidden = nowHidden;
			if (nowHidden) {
				if (state.rafId !== null) {
					cancelAnimationFrame(state.rafId);
					state.rafId = null;
				}
			} else if (state.rafId === null) {
				state.forceRepaint = true;
				startAnimationLoop(state, emit);
			}
		};
		document.addEventListener("visibilitychange", () => {
			occluded = document.visibilityState === "hidden";
			recomputeHidden();
		});
		window.addEventListener("brainstorm:app-visibility", (e) => {
			parked = !(e as CustomEvent<{ visible: boolean }>).detail.visible;
			recomputeHidden();
		});
	}

	/* ── Canvas handlers ─────────────────────────────────────────────────── */

	applySettingsToSvg(state);
	bindCanvasDrag(state, emit);
	bindCanvasHover(state, emit);
	bindCanvasClick(state, emit);
	bindCanvasContextMenu(state, emit);
	bindCanvasZoomAndPan(state, emit);
	bindCanvasResize(state, container);
	bindGlobalKeyboard(state, emit);
	bindCanvasFocusKeyboard(state, container, emit);
	startAnimationLoop(state, emit);

	/* ── Command surface ─────────────────────────────────────────────────── */

	const controller: GraphCanvasController = {
		subscribe,
		getSnapshot,
		getState: () => state,
		updateNodeProperty: async (id, key, value) => {
			// Optimistic local patch so the inspector reflects the edit at once;
			// the vault write is authoritative and reconciles on the next push.
			const node = state.scene.renderNodes.find((n) => n.id === id);
			if (node) {
				(node.entity.properties as Record<string, unknown>)[key] = value;
				emit();
			}
			const runtime = getGraphEntitiesRuntime();
			if (!runtime?.entities) return;
			try {
				await runtime.entities.update(id, { [key]: value });
			} catch (error) {
				console.warn("[graph] inspector property write failed:", error);
			}
		},
		setPattern: (next, options) => {
			applyPatternChange(state, next, options ?? { reseed: true });
			emit();
		},
		setSettings: (patch) => {
			Object.assign(state.settings, patch);
			emit();
		},
		setForces: (patch) => {
			Object.assign(state.forces, patch);
			applyForcesAndReheat(state);
			emit();
		},
		setReveal: (reveal) => {
			state.settings.reveal = reveal;
			reconcileScene(state);
			schedulePersist(state);
			emit();
		},
		reconcileScene: () => {
			reconcileScene(state);
			emit();
		},
		setPlaybackSpeed: (speed) => {
			state.playbackSpeed = speed;
			emit();
		},
		setLocalDepth: (depth) => {
			const next = clampLocalDepth(depth);
			if (state.localRootId !== null) {
				setLocalParams(state, { depth: next }, emit);
			} else {
				state.localDepth = next;
				schedulePersist(state);
				emit();
			}
		},
		setCutoffFraction: (fraction) => {
			const bounds = state.scene.bounds;
			if (!bounds) return;
			state.cutoffAt = fraction >= 1 ? null : bounds.min + (bounds.max - bounds.min) * fraction;
			state.isPlaying = false;
			reconcileScene(state);
			emit();
		},
		togglePlayback: () => {
			togglePlayback(state, emit);
		},
		zoomIn: () => {
			const c = canvasCenter(state);
			zoomAround(state, c.x, c.y, KEYBOARD_ZOOM_STEP, emit);
		},
		zoomOut: () => {
			const c = canvasCenter(state);
			zoomAround(state, c.x, c.y, 1 / KEYBOARD_ZOOM_STEP, emit);
		},
		resetCamera: () => {
			resetCamera(state);
			emit();
		},
		fitToContent: () => {
			fitTransformToContent(state);
			schedulePersist(state);
			emit();
		},
		resetLayout: () => {
			state.pinned.clear();
			state.layoutNodes.clear();
			reconcileScene(state);
			schedulePersist(state);
			scheduleViewCoordsPersist(state);
			emit();
		},
		setSidebar: (mode, collapsed) => {
			state.sidebarMode = mode;
			state.sidebarCollapsed = collapsed;
			schedulePersist(state);
			emit();
		},
		enterLocalView: () => {
			const root = pickDefaultLocalRoot(state);
			if (root !== null) setLocalRoot(state, root, emit);
		},
		setLocalRoot: (rootId) => {
			setLocalRoot(state, rootId, emit);
		},
		setLocalParams: (patch) => {
			setLocalParams(state, patch, emit);
		},
		setPathMode: (on) => {
			if (state.pathMode !== on) togglePathMode(state, emit);
		},
		pickPathEndpoint: (nodeId) => {
			handlePathPick(state, nodeId, emit);
		},
		effectiveDb: () => effectiveDb(state),
		svgExportInput: () => buildSvgExportInput(state),
		schedulePersist: () => schedulePersist(state),
		scheduleGraphEntityPersist: () => scheduleGraphEntityPersist(state),
		requestRepaint: () => {
			state.forceRepaint = true;
		},
		applySettingsToSvg: () => applySettingsToSvg(state),
		hydrateFromRuntime: (callbacks) => hydrateFromRuntime(state, callbacks, emit),
		setVaultData: (snapshot) => {
			void applyVaultData(state, snapshot, emit);
		},
		dispose: () => {
			state.disposed = true;
			if (state.rafId !== null) {
				cancelAnimationFrame(state.rafId);
				state.rafId = null;
			}
			state.resizeObserver?.disconnect();
			state.resizeObserver = null;
			state.layout.dispose();
			state.renderer?.destroy();
			hideLinkDragLine();
		},
	};

	return controller;
}

/* ── Snapshot computation ───────────────────────────────────────────────── */

function computeSnapshot(state: AppState): CanvasSnapshot {
	const stats = sceneStats(state.scene);
	const visibleNodeCount = state.scene.renderNodes.filter((n) => n.alpha > 0.05).length;
	return {
		hoveredId: state.hoveredId,
		kbFocusId: state.kbFocusId,
		selectedIds: Array.from(state.selectedIds),
		pathMode: state.pathMode,
		pathNodes: Array.from(state.pathNodes),
		localRootId: state.localRootId,
		localDepth: state.localDepth,
		localDirection: state.localDirection,
		cutoffAt: state.cutoffAt,
		isPlaying: state.isPlaying,
		playbackSpeed: state.playbackSpeed,
		reveal: state.settings.reveal,
		sidebarMode: state.sidebarMode,
		sidebarCollapsed: state.sidebarCollapsed,
		graphRecord: state.graphRecord,
		stats: {
			bindings: stats.bindings,
			visibleNodes: stats.visibleNodes,
			visibleEdges: stats.visibleEdges,
		},
		visibleNodeCount,
		totalNodeCount: state.scene.renderNodes.length,
		bounds: state.scene.bounds,
		transform: state.transform,
		path: state.pathMode ? state.pathStatus : null,
		status: state.status,
	};
}

/* ── Layout sizing + priming ────────────────────────────────────────────── */

function computeLayoutParams(container: HTMLElement): LayoutParams {
	const rect = container.getBoundingClientRect();
	const width = Math.max(400, rect.width || 800);
	const height = Math.max(300, rect.height || 600);
	return { ...DEFAULT_LAYOUT_PARAMS, width, height };
}

function primeLayout(scene: Scene, params: LayoutParams): Map<string, LayoutNode> {
	const ids = scene.renderNodes.map((n) => n.id);
	const seeded = seedPositions(ids, params, 7);
	const radiusById = new Map(scene.renderNodes.map((n) => [n.id, n.radius] as const));
	const out = new Map<string, LayoutNode>();
	for (const node of seeded) {
		const r = radiusById.get(node.id);
		if (r !== undefined) node.radius = r;
		out.set(node.id, node);
	}
	return out;
}

function sceneEdges(scene: Scene): LayoutEdge[] {
	return scene.renderEdges.map((e) => ({
		source: e.link.sourceEntityId,
		target: e.link.destEntityId,
	}));
}

function neighbourSeedPositions(
	newIds: string[],
	scene: Scene,
	existing: Map<string, LayoutNode>,
): Map<string, { x: number; y: number }> {
	if (newIds.length === 0) return new Map();
	const newSet = new Set(newIds);
	const neighboursByNew = new Map<string, string[]>();
	const record = (newId: string, anchorId: string): void => {
		const list = neighboursByNew.get(newId);
		if (list) list.push(anchorId);
		else neighboursByNew.set(newId, [anchorId]);
	};
	for (const e of scene.renderEdges) {
		const s = e.link.sourceEntityId;
		const tt = e.link.destEntityId;
		const sIsNew = newSet.has(s);
		const tIsNew = newSet.has(tt);
		if (sIsNew && !tIsNew && existing.has(tt)) record(s, tt);
		else if (tIsNew && !sIsNew && existing.has(s)) record(tt, s);
	}
	const out = new Map<string, { x: number; y: number }>();
	for (const [id, neighbours] of neighboursByNew) {
		let sx = 0;
		let sy = 0;
		let n = 0;
		for (const nid of neighbours) {
			const ln = existing.get(nid);
			if (!ln) continue;
			sx += ln.x;
			sy += ln.y;
			n += 1;
		}
		if (n === 0) continue;
		const jitter = (): number => (Math.random() * 2 - 1) * 8;
		out.set(id, { x: sx / n + jitter(), y: sy / n + jitter() });
	}
	return out;
}

function reconcileLayout(state: AppState, scene: Scene): void {
	const wanted = new Set(scene.renderNodes.map((n) => n.id));
	let topologyChanged = false;
	for (const id of Array.from(state.layoutNodes.keys())) {
		if (!wanted.has(id)) {
			state.layoutNodes.delete(id);
			topologyChanged = true;
		}
	}
	const newIds = scene.renderNodes.map((n) => n.id).filter((id) => !state.layoutNodes.has(id));
	if (newIds.length > 0) {
		const seeded = seedPositions(newIds, state.layoutParams, state.layoutNodes.size + 13);
		const neighbourSeed = neighbourSeedPositions(newIds, scene, state.layoutNodes);
		for (const node of seeded) {
			const near = neighbourSeed.get(node.id);
			if (near) {
				node.x = near.x;
				node.y = near.y;
			}
			state.layoutNodes.set(node.id, node);
		}
		topologyChanged = true;
	}
	for (const rn of scene.renderNodes) {
		const layoutNode = state.layoutNodes.get(rn.id);
		if (layoutNode) layoutNode.radius = rn.radius;
	}
	for (const [id, pos] of state.pinned) {
		if (state.drag?.nodeId === id) continue;
		const node = state.layoutNodes.get(id);
		if (!node) continue;
		node.x = pos.x;
		node.y = pos.y;
		node.fx = pos.x;
		node.fy = pos.y;
	}
	const reheat = topologyChanged ? (state.isPlaying ? 0.3 : 1) : 0;
	if (reheat === 1 && state.layoutNodes.size > 0) state.layoutSettling = true;
	state.layout.reset(state.layoutNodes, sceneEdges(scene), reheat);
}

/* ── Animation loop (rAF + geometryDirty gate) ──────────────────────────── */

function startAnimationLoop(state: AppState, emit: () => void): void {
	let last = performance.now();
	let wasWarm = false;
	const step = (now: number) => {
		const dt = Math.min(64, now - last);
		last = now;
		state.frameCount += 1;

		if (state.isPlaying) {
			advancePlayback(state, dt, emit);
		}

		const simWarm = state.layout.pump(state.layoutNodes);
		if (state.pendingFitAfterSettle && wasWarm && !simWarm && !state.drag) {
			state.pendingFitAfterSettle = false;
			fitTransformToContent(state);
			state.forceRepaint = true;
			schedulePersist(state);
		}
		if (state.layoutSettling && wasWarm && !simWarm) {
			state.layoutSettling = false;
			state.forceRepaint = true;
		}
		wasWarm = simWarm;
		if (state.drag) {
			state.layout.reheat(0.05);
		}

		if (state.renderer) {
			const hoveredId = state.drag ? null : (state.hoveredId ?? state.kbFocusId);
			const tf = state.transform;
			const lp = state.lastPaint;
			const cameraMoved = lp === null || lp.k !== tf.k || lp.tx !== tf.tx || lp.ty !== tf.ty;
			const hoverChanged = lp === null || lp.hoveredId !== hoveredId;
			const interactive = simWarm || state.drag !== null || state.pan !== null || state.isPlaying;
			const arrowLod = tf.k >= ARROW_HIDE_BELOW_K;
			const geometryDirty =
				lp === null ||
				simWarm ||
				state.drag !== null ||
				state.isPlaying ||
				hoverChanged ||
				state.focusAnimating ||
				state.forceRepaint ||
				lp.arrowLod !== arrowLod;
			if (interactive || cameraMoved || hoverChanged || state.focusAnimating || state.forceRepaint) {
				advanceFocusAlpha(state, hoveredId, dt);
				state.renderer.paint(buildSnapshot(state, hoveredId), geometryDirty);
				state.forceRepaint = false;
				state.lastPaint = { k: tf.k, tx: tf.tx, ty: tf.ty, hoveredId, arrowLod };
			}
			if (state.graphRecord) presenceBind.paint();
		}

		if (state.disposed || state.hidden) {
			state.rafId = null;
			return;
		}
		state.rafId = requestAnimationFrame(step);
	};
	if (state.rafId !== null) return;
	state.rafId = requestAnimationFrame(step);
}

function togglePlayback(state: AppState, emit: () => void): void {
	const bounds = state.scene.bounds;
	if (state.isPlaying) {
		state.isPlaying = false;
		state.cutoffAt = null;
	} else {
		state.isPlaying = true;
		if (bounds) state.cutoffAt = bounds.min - 1;
	}
	reconcileScene(state);
	emit();
}

function advancePlayback(state: AppState, dt: number, emit: () => void): void {
	const bounds = state.scene.bounds;
	if (!bounds) return;
	const span = Math.max(1, bounds.max - bounds.min);
	const msPerSecond = (span / PLAYBACK_FULL_RANGE_SECONDS_AT_1X) * state.playbackSpeed;
	const current = state.cutoffAt ?? bounds.min;
	const next = current + (dt / 1000) * msPerSecond;
	if (next >= bounds.max) {
		state.cutoffAt = bounds.max;
		state.isPlaying = false;
		emit();
	} else {
		state.cutoffAt = next;
	}
	reconcileScene(state);
	emit();
}

function buildSnapshot(state: AppState, hoveredId: string | null): Snapshot {
	return {
		nodes: state.layoutNodes,
		renderNodes: state.scene.renderNodes,
		renderEdges: state.scene.renderEdges,
		width: state.layoutParams.width,
		height: state.layoutParams.height,
		transform: state.transform,
		hoveredId,
		focusAlphaByNode: state.focusAlphaByNode,
		focusAlphaByEdge: state.focusAlphaByEdge,
		showLabels: state.settings.showLabels && !state.isPlaying && !state.layoutSettling,
		showArrows: state.settings.showArrows,
	};
}

function currentSnapshot(state: AppState): Snapshot {
	return buildSnapshot(state, state.drag ? null : state.hoveredId);
}

function reconcileScene(state: AppState): void {
	const db = effectiveDb(state);
	state.scene = buildScene(
		state.pattern,
		db,
		sceneOptionsFrom(state.cutoffAt, state.settings, state.theme),
	);
	reconcileLayout(state, state.scene);
	state.forceRepaint = true;
}

function effectiveDb(state: AppState): InMemoryGraph {
	if (state.localRootId === null) return state.db;
	const scoped = localScope(state.db, state.localRootId, {
		depth: state.localDepth,
		direction: state.localDirection,
	});
	if (!scoped) {
		state.localRootId = null;
		return state.db;
	}
	return scoped;
}

function sceneOptionsFrom(
	cutoffAt: number | null,
	settings: GraphSettings,
	theme: GraphTheme,
): SceneOptions {
	return {
		cutoffAt,
		reveal: settings.reveal,
		easeWindowMs: EASE_WINDOW_MS,
		recentWindowMs: RECENT_WINDOW_MS,
		showUnmatched: settings.showUnmatched,
		showIcons: settings.showIcons,
		theme,
	};
}

function applyPatternChange(
	state: AppState,
	next: GraphPattern,
	options: { reseed: boolean } = { reseed: true },
): void {
	state.pattern = next;
	if (options.reseed) {
		state.cutoffAt = null;
		state.layoutNodes.clear();
		reconcileScene(state);
	}
	schedulePersist(state);
	scheduleGraphEntityPersist(state);
}

function applyForcesAndReheat(state: AppState): void {
	state.layoutParams = { ...state.layoutParams, ...state.forces };
	state.layout.setParams(state.layoutParams);
	state.layout.reheat(0.6);
	schedulePersist(state);
}

/* ── SVG export input ───────────────────────────────────────────────────── */

function buildSvgExportInput(state: AppState): SvgExportInput {
	const nodes: SvgExportNode[] = [];
	for (const rn of state.scene.renderNodes) {
		const p = state.layoutNodes.get(rn.id);
		if (!p) continue;
		nodes.push({
			id: rn.id,
			x: p.x,
			y: p.y,
			radius: rn.radius,
			color: rn.color,
			alpha: rn.alpha,
			label: rawNodeLabel(rn.entity),
		});
	}
	const edges: SvgExportEdge[] = state.scene.renderEdges.map((re) => ({
		sourceId: re.link.sourceEntityId,
		destId: re.link.destEntityId,
		color: re.color,
		alpha: re.alpha,
	}));
	return { nodes, edges };
}

/* ── Settings → renderer CSS parity ─────────────────────────────────────── */

function applySettingsToSvg(state: AppState): void {
	const el = state.renderer?.element;
	if (!el) return;
	el.dataset.showLabels = String(state.settings.showLabels);
	el.dataset.showArrows = String(state.settings.showArrows);
}

/* ── Node drag ──────────────────────────────────────────────────────────── */

function bindCanvasDrag(state: AppState, emit: () => void): void {
	const renderer = state.renderer;
	if (!renderer) return;
	const el = renderer.element;

	el.addEventListener("pointerdown", (event: PointerEvent) => {
		if (event.button !== 0) return;
		const nodeId = renderer.pickNode(currentSnapshot(state), event.clientX, event.clientY);
		if (!nodeId) return;
		const node = state.layoutNodes.get(nodeId);
		if (!node) return;
		event.preventDefault();
		event.stopPropagation();
		const center = renderer.nodeToClient(state.transform, node.x, node.y);
		const kind = detectDragKind({
			distPx: Math.hypot(event.clientX - center.x, event.clientY - center.y),
			radiusPx: node.radius * state.transform.k,
			altKey: event.altKey,
		});
		el.setPointerCapture(event.pointerId);
		if (kind === NodeDragKind.Link) {
			el.dataset.linking = "true";
			state.linkDrag = { pointerId: event.pointerId, sourceId: nodeId };
			updateLinkDragLine(state, event.clientX, event.clientY);
			return;
		}
		el.dataset.dragging = "true";
		state.pendingFitAfterSettle = false;
		state.drag = { pointerId: event.pointerId, nodeId };
		node.fx = node.x;
		node.fy = node.y;
		state.layout.setFixed(nodeId, node.x, node.y);
		state.layout.reheat(0.05);
	});

	el.addEventListener("pointermove", (event: PointerEvent) => {
		if (state.linkDrag && event.pointerId === state.linkDrag.pointerId) {
			updateLinkDragLine(state, event.clientX, event.clientY);
			const picked = renderer.pickNode(currentSnapshot(state), event.clientX, event.clientY);
			const targetId = picked === state.linkDrag.sourceId ? null : picked;
			if (state.hoveredId !== targetId) {
				state.hoveredId = targetId;
				emit();
			}
			return;
		}
		if (!state.drag || event.pointerId !== state.drag.pointerId) return;
		const node = state.layoutNodes.get(state.drag.nodeId);
		if (!node) return;
		const point = renderer.clientToWorldPoint(state.transform, event.clientX, event.clientY);
		node.fx = point.x;
		node.fy = point.y;
		node.x = point.x;
		node.y = point.y;
		state.layout.setFixed(state.drag.nodeId, point.x, point.y);
		state.layout.reheat(0.05);
	});

	const release = (event: PointerEvent) => {
		if (state.linkDrag && event.pointerId === state.linkDrag.pointerId) {
			const sourceId = state.linkDrag.sourceId;
			state.linkDrag = null;
			hideLinkDragLine();
			el.releasePointerCapture(event.pointerId);
			el.dataset.linking = "false";
			state.hoveredId = null;
			emit();
			if (event.type === "pointercancel") return;
			const targetId = renderer.pickNode(currentSnapshot(state), event.clientX, event.clientY);
			if (targetId && targetId !== sourceId) {
				void openCreateLinkMenu(state, sourceId, targetId, event.clientX, event.clientY, emit);
			}
			return;
		}
		if (!state.drag || event.pointerId !== state.drag.pointerId) return;
		const node = state.layoutNodes.get(state.drag.nodeId);
		if (node) {
			state.pinned.set(state.drag.nodeId, { x: node.x, y: node.y });
			schedulePersist(state);
			scheduleViewCoordsPersist(state);
		}
		el.releasePointerCapture(event.pointerId);
		el.dataset.dragging = "false";
		state.drag = null;
		emit();
	};
	el.addEventListener("pointerup", release);
	el.addEventListener("pointercancel", release);
}

/* ── Drag-to-create-link (9.13.11) ──────────────────────────────────────── */

// The rubber-band line is a DOM overlay (fixed, pointer-events: none) so the
// gesture feedback never touches the Pixi pipeline — the geometryDirty edge
// cache stays valid for the whole drag.
let linkDragOverlay: { svg: SVGSVGElement; line: SVGLineElement } | null = null;

function ensureLinkDragOverlay(): { svg: SVGSVGElement; line: SVGLineElement } {
	if (linkDragOverlay) return linkDragOverlay;
	const NS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("class", "link-drag-overlay");
	svg.setAttribute("aria-hidden", "true");
	const line = document.createElementNS(NS, "line");
	svg.appendChild(line);
	document.body.appendChild(svg);
	linkDragOverlay = { svg, line };
	return linkDragOverlay;
}

function updateLinkDragLine(state: AppState, clientX: number, clientY: number): void {
	const drag = state.linkDrag;
	const renderer = state.renderer;
	if (!drag || !renderer) return;
	const node = state.layoutNodes.get(drag.sourceId);
	if (!node) return;
	const from = renderer.nodeToClient(state.transform, node.x, node.y);
	const { line } = ensureLinkDragOverlay();
	line.setAttribute("x1", String(from.x));
	line.setAttribute("y1", String(from.y));
	line.setAttribute("x2", String(clientX));
	line.setAttribute("y2", String(clientY));
}

function hideLinkDragLine(): void {
	linkDragOverlay?.svg.remove();
	linkDragOverlay = null;
}

/** Release over a target node → fancy-menus popover at the drop point
 *  listing the typed links the vault catalog allows for the target
 *  (`entityRef` defs), plus the generic "Related to" fallback (ensured
 *  idempotently in the catalog so the shell's ref derivation projects the
 *  edge). Cursor menus pass the point — collapsed rect, no anchor. */
async function openCreateLinkMenu(
	state: AppState,
	sourceId: string,
	targetId: string,
	x: number,
	y: number,
	emit: () => void,
): Promise<void> {
	const entities = getGraphEntitiesRuntime()?.entities;
	if (!entities) {
		setStatus(state, t("link.unavailable"), "warn", emit);
		return;
	}
	const targetNode = state.scene.renderNodes.find((n) => n.id === targetId);
	if (!targetNode) return;
	const properties = getRuntime()?.services?.properties ?? null;
	let defs: PropertyDef[] = [];
	if (properties) {
		try {
			defs = Object.values((await properties.list()).properties);
		} catch (error) {
			console.warn("[graph] properties.list failed:", error);
		}
	}
	const applicable = applicableLinkDefs(defs, targetNode.entity.type);
	const items: AnchoredMenuItem[] = [
		{ label: t("link.menuTitle", { target: nodeLabelById(state, targetId) }), section: true },
		...applicable.map((def) => ({
			label: def.name,
			onSelect: () => {
				void writeCreateLink(state, entities, def, sourceId, targetId, emit);
			},
		})),
	];
	if (properties && !applicable.some((def) => def.key === RELATED_TO_DEF.key)) {
		items.push({
			label: RELATED_TO_DEF.name,
			onSelect: () => {
				void (async () => {
					try {
						const existing = await properties.getProperty(RELATED_TO_DEF.key);
						if (!existing) await properties.setProperty(RELATED_TO_DEF);
					} catch (error) {
						console.warn("[graph] related-to def ensure failed:", error);
					}
					await writeCreateLink(state, entities, RELATED_TO_DEF, sourceId, targetId, emit);
				})();
			},
		});
	}
	if (items.length === 1) {
		items.push({ label: t("link.noTypes"), disabled: true, hint: t("link.noTypesHint") });
	}
	openAnchoredMenu({ x, y }, items, { menuLabel: t("link.menuLabel") });
}

/** Write the picked link type: the target's id lands in the `entityRef`
 *  property on the source (`entities.update`); the shell derives the edge
 *  and the new link arrives through the live vault snapshot. */
async function writeCreateLink(
	state: AppState,
	entities: EntitiesService,
	def: PropertyDef,
	sourceId: string,
	targetId: string,
	emit: () => void,
): Promise<void> {
	const sourceLabel = nodeLabelById(state, sourceId);
	const targetLabel = nodeLabelById(state, targetId);
	try {
		const source = await entities.get(sourceId);
		const value = nextRefValue(def, source?.properties?.[def.key], targetId);
		if (value === null) {
			setStatus(state, t("link.already", { name: def.name }), "ready", emit);
			return;
		}
		await entities.update(sourceId, { [def.key]: value });
		setStatus(
			state,
			t("link.created", { source: sourceLabel, target: targetLabel, name: def.name }),
			"ready",
			emit,
		);
	} catch (error) {
		console.warn("[graph] link write failed:", error);
		setStatus(state, t("link.failed", { name: def.name }), "warn", emit);
	}
}

/* ── Hover preview + edge tooltip ───────────────────────────────────────── */

let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewedNodeId: string | null = null;
let previewMenuTrigger: ObjectMenuTriggerHandle | null = null;

/** Attach the shared ⋯ object-menu trigger to the hover-preview header once.
 *  Its `context()` resolves the *currently previewed* node at open time, so the
 *  one button serves every node. The preview card + its menu are canvas-owned
 *  (driven by hover), so the trigger lives here, not in the chrome. */
function ensurePreviewMenuTrigger(state: AppState, emit: () => void): void {
	if (previewMenuTrigger) return;
	const row = document.querySelector<HTMLElement>(".hover-preview__row");
	if (!row) return;
	previewMenuTrigger = attachObjectMenuTrigger(
		row,
		() => {
			if (!previewedNodeId) return null;
			const node = state.scene.renderNodes.find((n) => n.id === previewedNodeId);
			if (!node) return null;
			return {
				target: {
					entityId: node.entity.id,
					entityType: node.entity.type,
					label: rawNodeLabel(node.entity),
				},
				runtime: getRuntime() as ObjectMenuRuntime,
				extraItems: [localViewExtraItem(state, previewedNodeId, emit)],
				labels: {
					open: t("menu.open"),
					pin: t("menu.pin"),
					unpin: t("menu.unpin"),
					menuRegion: t("menu.region"),
				},
			};
		},
		{ moreActionsLabel: t("preview.moreActions") },
	);
	row.appendChild(previewMenuTrigger.moreButton);
}

function bindCanvasHover(state: AppState, emit: () => void): void {
	const renderer = state.renderer;
	if (!renderer) return;
	const el = renderer.element;

	const setHover = (id: string | null) => {
		if (state.hoveredId === id) return;
		state.hoveredId = id;
		if (previewTimer) {
			clearTimeout(previewTimer);
			previewTimer = null;
		}
		if (id) {
			previewTimer = setTimeout(() => {
				previewTimer = null;
				showHoverPreview(state, id, emit);
			}, PREVIEW_DWELL_MS);
		} else {
			hideHoverPreview();
		}
		emit();
	};

	el.addEventListener("pointermove", (event: PointerEvent) => {
		if (state.linkDrag) {
			// The link-drag pointermove (bindCanvasDrag) owns the target
			// highlight; suppress the dwell preview + edge tooltip here.
			if (previewTimer) {
				clearTimeout(previewTimer);
				previewTimer = null;
			}
			hideHoverPreview();
			hideEdgeTooltip();
			return;
		}
		if (state.drag) {
			setHover(null);
			hideEdgeTooltip();
			return;
		}
		const id = renderer.pickNode(currentSnapshot(state), event.clientX, event.clientY);
		setHover(id);
		if (id) {
			hideEdgeTooltip();
		} else {
			const edge = pickEdge(state, event.clientX, event.clientY);
			if (!edge) {
				hideEdgeTooltip();
			} else if (edge.id === edgeTooltipEdgeId) {
				positionEdgeTooltip(event.clientX, event.clientY);
			} else {
				edgeTooltipEdgeId = edge.id;
				showEdgeTooltip(state, edge, event.clientX, event.clientY);
			}
		}
	});
	el.addEventListener("pointerleave", () => {
		setHover(null);
		hideEdgeTooltip();
	});
}

function showHoverPreview(state: AppState, nodeId: string, emit: () => void): void {
	const popover = document.getElementById("hover-preview");
	if (!popover) return;
	const node = state.scene.renderNodes.find((n) => n.id === nodeId);
	const layout = state.layoutNodes.get(nodeId);
	const renderer = state.renderer;
	if (!node || !layout || !renderer) return;

	previewedNodeId = nodeId;
	ensurePreviewMenuTrigger(state, emit);

	const title = document.getElementById("hover-preview-title");
	const type = document.getElementById("hover-preview-type");
	const glyph = document.getElementById("hover-preview-glyph");
	const meta = document.getElementById("hover-preview-meta");
	if (title) title.textContent = rawNodeLabel(node.entity);
	if (type) type.textContent = shortType(node.entity.type);
	if (glyph) {
		glyph.textContent = node.glyph || "●";
		glyph.style.color = node.glyph ? "" : node.color;
	}
	if (meta) {
		const degree = countDegree(nodeId, state.scene);
		const subject = node.subjectName ?? t("preview.unmatched");
		const links = plural(degree, "preview.link", "preview.links", { count: degree });
		const breakdown = linkReasonBreakdown(nodeId, state.scene);
		meta.replaceChildren();
		const subjectSpan = document.createElement("span");
		subjectSpan.textContent = subject;
		const linksSpan = document.createElement("span");
		linksSpan.textContent = links;
		meta.append(subjectSpan, linksSpan);
		if (breakdown) {
			const breakdownSpan = document.createElement("span");
			breakdownSpan.textContent = breakdown;
			meta.append(breakdownSpan);
		}
	}
	fillPreviewProps(node.entity);

	const screen = renderer.nodeToClient(state.transform, layout.x, layout.y);
	const clientX = screen.x;
	const clientY = screen.y;
	const rect = renderer.element.getBoundingClientRect();
	const vbWidth = state.layoutParams.width || rect.width || 1;
	const radiusPx = node.radius * (rect.width / vbWidth) * state.transform.k;

	popover.style.left = "0px";
	popover.style.top = "0px";
	const pw = popover.offsetWidth;
	const ph = popover.offsetHeight;
	const margin = 12;
	const wantRight = clientX + radiusPx + margin + pw < window.innerWidth;
	const left = wantRight ? clientX + radiusPx + margin : clientX - radiusPx - margin - pw;
	const top = Math.max(8, Math.min(window.innerHeight - ph - 8, clientY - ph / 2));
	popover.style.left = `${Math.round(left)}px`;
	popover.style.top = `${Math.round(top)}px`;
	popover.setAttribute("aria-hidden", "false");
}

function fillPreviewProps(entity: EntityRow): void {
	const list = document.getElementById("hover-preview-props");
	if (!list) return;
	const rows = inspectorProperties(entity);
	list.innerHTML = "";
	if (rows.length === 0) {
		list.hidden = true;
		return;
	}
	for (const row of rows) {
		const pair = document.createElement("div");
		pair.className = "hover-preview__prop";
		const dt = document.createElement("dt");
		dt.textContent = row.label;
		const dd = document.createElement("dd");
		dd.textContent = row.value;
		pair.append(dt, dd);
		list.appendChild(pair);
	}
	list.hidden = false;
}

function hideHoverPreview(): void {
	const popover = document.getElementById("hover-preview");
	if (popover) popover.setAttribute("aria-hidden", "true");
	const props = document.getElementById("hover-preview-props");
	if (props) {
		props.innerHTML = "";
		props.hidden = true;
	}
	previewedNodeId = null;
}

function distanceSqToSegment(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	let tt = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
	tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
	const ex = px - (ax + tt * dx);
	const ey = py - (ay + tt * dy);
	return ex * ex + ey * ey;
}

function pickEdge(state: AppState, clientX: number, clientY: number): RenderEdge | null {
	const renderer = state.renderer;
	if (!renderer) return null;
	const edges = state.scene.renderEdges;
	if (edges.length === 0 || edges.length > EDGE_HIT_MAX_EDGES) return null;

	let best: RenderEdge | null = null;
	let bestDistSq = EDGE_HIT_THRESHOLD_SQ;
	for (const edge of edges) {
		const a = state.layoutNodes.get(edge.link.sourceEntityId);
		const b = state.layoutNodes.get(edge.link.destEntityId);
		if (!a || !b) continue;
		const sa = renderer.nodeToClient(state.transform, a.x, a.y);
		const sb = renderer.nodeToClient(state.transform, b.x, b.y);
		const distSq = distanceSqToSegment(clientX, clientY, sa.x, sa.y, sb.x, sb.y);
		if (distSq < bestDistSq) {
			bestDistSq = distSq;
			best = edge;
		}
	}
	return best;
}

function nodeLabelById(state: AppState, id: string): string {
	const node = state.scene.renderNodes.find((n) => n.id === id);
	return node ? rawNodeLabel(node.entity) : id;
}

let edgeTooltipEdgeId: string | null = null;

function showEdgeTooltip(
	state: AppState,
	edge: RenderEdge,
	clientX: number,
	clientY: number,
): void {
	const tip = document.getElementById("edge-tooltip");
	if (!tip) return;
	const reason = document.getElementById("edge-tooltip-reason");
	const ends = document.getElementById("edge-tooltip-ends");
	if (reason) reason.textContent = linkReasonLabel(edge.link);
	if (ends) {
		const source = nodeLabelById(state, edge.link.sourceEntityId);
		const dest = nodeLabelById(state, edge.link.destEntityId);
		const directed = linkCategory(edge.link.linkType) !== LinkCategory.SharedAttribute;
		ends.textContent = directed
			? t("reason.edgeDirected", { source, dest })
			: t("reason.edgeUndirected", { source, dest });
	}
	tip.setAttribute("aria-hidden", "false");
	positionEdgeTooltip(clientX, clientY);
}

function positionEdgeTooltip(clientX: number, clientY: number): void {
	const tip = document.getElementById("edge-tooltip");
	if (!tip) return;
	const margin = 14;
	const tw = tip.offsetWidth;
	const th = tip.offsetHeight;
	let left = clientX + margin;
	if (left + tw + 8 > window.innerWidth) left = clientX - margin - tw;
	let top = clientY + margin;
	if (top + th + 8 > window.innerHeight) top = clientY - margin - th;
	tip.style.left = `${Math.round(Math.max(8, left))}px`;
	tip.style.top = `${Math.round(Math.max(8, top))}px`;
}

function hideEdgeTooltip(): void {
	edgeTooltipEdgeId = null;
	const tip = document.getElementById("edge-tooltip");
	if (tip) tip.setAttribute("aria-hidden", "true");
}

function countDegree(nodeId: string, scene: Scene): number {
	let n = 0;
	for (const e of scene.renderEdges) {
		if (e.link.sourceEntityId === nodeId || e.link.destEntityId === nodeId) n += 1;
	}
	return n;
}

function linkReasonBreakdown(nodeId: string, scene: Scene): string {
	const counts = new Map<string, number>();
	for (const e of scene.renderEdges) {
		if (e.link.sourceEntityId !== nodeId && e.link.destEntityId !== nodeId) continue;
		const label = linkReasonShortLabel(e.link.linkType);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	if (counts.size === 0) return "";
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([label, count]) => t("reason.breakdownSegment", { label, count }))
		.join(" · ");
}

function shortType(typeId: string): string {
	const parts = typeId.split("/");
	if (parts.length >= 2) return parts[parts.length - 2] ?? typeId;
	return typeId;
}

function neighborsOf(nodeId: string, scene: Scene): Set<string> {
	const out = new Set<string>();
	for (const edge of scene.renderEdges) {
		if (edge.link.sourceEntityId === nodeId) out.add(edge.link.destEntityId);
		else if (edge.link.destEntityId === nodeId) out.add(edge.link.sourceEntityId);
	}
	return out;
}

function advanceFocusAlpha(state: AppState, hoveredId: string | null, dt: number): void {
	const pathActive = state.pathNodes.size > 0;
	// 9.13.11 — a non-empty click selection emphasises the selected nodes + their
	// neighbours (rest dim), reusing the Path/hover dimming with zero new render
	// code. Path view outranks selection; both outrank hover.
	const selectionActive = !pathActive && state.selectedIds.size > 0;
	const selectionBright: Set<string> | null = selectionActive ? new Set<string>() : null;
	if (selectionBright) {
		for (const id of state.selectedIds) {
			selectionBright.add(id);
			const ns = neighborsOf(id, state.scene);
			if (ns) for (const n of ns) selectionBright.add(n);
		}
	}
	const targetForUnfocused =
		pathActive || selectionActive || hoveredId !== null ? HOVER_DIM_ALPHA : 1;
	const neighbours = hoveredId ? neighborsOf(hoveredId, state.scene) : null;
	const factor = 1 - Math.exp(-dt / FOCUS_FADE_TIME_CONSTANT_MS);

	const SETTLE_EPSILON = 0.002;
	let maxGap = 0;

	const livingNodes = new Set<string>();
	for (const node of state.scene.renderNodes) {
		livingNodes.add(node.id);
		const target = pathActive
			? state.pathNodes.has(node.id)
				? 1
				: HOVER_DIM_ALPHA
			: selectionBright
				? selectionBright.has(node.id)
					? 1
					: HOVER_DIM_ALPHA
				: hoveredId === null || node.id === hoveredId || neighbours?.has(node.id)
					? 1
					: HOVER_DIM_ALPHA;
		const current = state.focusAlphaByNode.get(node.id) ?? targetForUnfocused;
		const gap = Math.abs(target - current);
		if (gap > maxGap) maxGap = gap;
		state.focusAlphaByNode.set(
			node.id,
			gap <= SETTLE_EPSILON ? target : current + (target - current) * factor,
		);
	}
	for (const id of Array.from(state.focusAlphaByNode.keys())) {
		if (!livingNodes.has(id)) state.focusAlphaByNode.delete(id);
	}

	const livingEdges = new Set<string>();
	for (const edge of state.scene.renderEdges) {
		livingEdges.add(edge.id);
		const sa = state.focusAlphaByNode.get(edge.link.sourceEntityId) ?? targetForUnfocused;
		const da = state.focusAlphaByNode.get(edge.link.destEntityId) ?? targetForUnfocused;
		const target = Math.max(sa, da);
		const current = state.focusAlphaByEdge.get(edge.id) ?? target;
		const gap = Math.abs(target - current);
		if (gap > maxGap) maxGap = gap;
		state.focusAlphaByEdge.set(
			edge.id,
			gap <= SETTLE_EPSILON ? target : current + (target - current) * factor,
		);
	}
	for (const id of Array.from(state.focusAlphaByEdge.keys())) {
		if (!livingEdges.has(id)) state.focusAlphaByEdge.delete(id);
	}
	state.focusAnimating = maxGap > SETTLE_EPSILON;
}

/* ── Camera (zoom + pan) ────────────────────────────────────────────────── */

function canvasCenter(state: AppState): { x: number; y: number } {
	const el = state.renderer?.element;
	if (!el) return { x: 0, y: 0 };
	const rect = el.getBoundingClientRect();
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function bindCanvasZoomAndPan(state: AppState, emit: () => void): void {
	const renderer = state.renderer;
	if (!renderer) return;
	const el = renderer.element;

	el.addEventListener(
		"wheel",
		(event: WheelEvent) => {
			event.preventDefault();
			const factor = Math.exp(-event.deltaY * ZOOM_WHEEL_SENSITIVITY);
			zoomAround(state, event.clientX, event.clientY, factor, emit);
		},
		{ passive: false },
	);

	el.addEventListener("pointerdown", (event: PointerEvent) => {
		if (event.button !== 0 && event.button !== 2) return;
		const onNode = renderer.pickNode(currentSnapshot(state), event.clientX, event.clientY);
		if (onNode) return;
		event.preventDefault();
		el.setPointerCapture(event.pointerId);
		el.dataset.panning = "true";
		state.pendingFitAfterSettle = false;
		state.pan = {
			pointerId: event.pointerId,
			startTx: state.transform.tx,
			startTy: state.transform.ty,
			startX: event.clientX,
			startY: event.clientY,
		};
	});
	el.addEventListener("pointermove", (event: PointerEvent) => {
		if (!state.pan || event.pointerId !== state.pan.pointerId) return;
		const rect = el.getBoundingClientRect();
		const vbWidth = state.layoutParams.width || rect.width || 1;
		const vbHeight = state.layoutParams.height || rect.height || 1;
		const dx = ((event.clientX - state.pan.startX) / rect.width) * vbWidth;
		const dy = ((event.clientY - state.pan.startY) / rect.height) * vbHeight;
		state.transform = {
			...state.transform,
			tx: state.pan.startTx + dx,
			ty: state.pan.startTy + dy,
		};
		emit();
	});
	const release = (event: PointerEvent) => {
		if (!state.pan || event.pointerId !== state.pan.pointerId) return;
		el.releasePointerCapture(event.pointerId);
		el.dataset.panning = "false";
		state.pan = null;
		schedulePersist(state);
	};
	el.addEventListener("pointerup", release);
	el.addEventListener("pointercancel", release);
}

function zoomAround(
	state: AppState,
	clientX: number,
	clientY: number,
	factor: number,
	emit: () => void,
): void {
	const el = state.renderer?.element;
	if (!el) return;
	const rect = el.getBoundingClientRect();
	const vbWidth = state.layoutParams.width || rect.width || 1;
	const vbHeight = state.layoutParams.height || rect.height || 1;
	const sx = ((clientX - rect.left) / rect.width) * vbWidth;
	const sy = ((clientY - rect.top) / rect.height) * vbHeight;
	const nextK = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.transform.k * factor));
	if (nextK === state.transform.k) return;
	state.pendingFitAfterSettle = false;
	const ratio = nextK / state.transform.k;
	state.transform = {
		k: nextK,
		tx: sx - (sx - state.transform.tx) * ratio,
		ty: sy - (sy - state.transform.ty) * ratio,
	};
	schedulePersist(state);
	emit();
}

function resetCamera(state: AppState): void {
	state.transform = { ...IDENTITY_TRANSFORM };
	schedulePersist(state);
}

function fitTransformToContent(state: AppState): void {
	if (state.layoutNodes.size === 0) return;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const n of state.layoutNodes.values()) {
		const r = n.radius;
		if (n.x - r < minX) minX = n.x - r;
		if (n.y - r < minY) minY = n.y - r;
		if (n.x + r > maxX) maxX = n.x + r;
		if (n.y + r > maxY) maxY = n.y + r;
	}
	const bw = Math.max(1, maxX - minX);
	const bh = Math.max(1, maxY - minY);
	const vw = state.layoutParams.width;
	const vh = state.layoutParams.height;
	const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(vw / bw, vh / bh) * FIT_PADDING));
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	state.transform = {
		k,
		tx: vw / 2 - cx * k,
		ty: vh / 2 - cy * k,
	};
}

function focusNodeById(state: AppState, id: string): boolean {
	const node = state.layoutNodes.get(id);
	if (!node) return false;
	const k = Math.max(state.transform.k, 1.1);
	state.transform = focusNodeTransform(
		node,
		{ width: state.layoutParams.width, height: state.layoutParams.height },
		k,
		{ min: ZOOM_MIN, max: ZOOM_MAX },
	);
	schedulePersist(state);
	return true;
}

function bindCanvasResize(state: AppState, container: HTMLElement): void {
	if (typeof ResizeObserver === "undefined") return;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	const observer = new ResizeObserver(() => {
		if (state.disposed) return;
		const rect = container.getBoundingClientRect();
		const width = Math.max(200, rect.width || state.layoutParams.width);
		const height = Math.max(200, rect.height || state.layoutParams.height);
		if (width === state.layoutParams.width && height === state.layoutParams.height) return;
		state.layoutParams = { ...state.layoutParams, width, height };
		state.renderer?.resize(width, height);
		// ResizeObserver callbacks run AFTER this frame's rAF, so the
		// resize-cleared backbuffer would composite as a blank frame —
		// visible node blinking for the whole window drag. Repaint
		// synchronously in the same frame. A resize is viewport-only
		// (node world positions are untouched; setParams is debounced
		// below), so the cached edge buffer is still valid — geometryDirty
		// stays false, and `lastPaint` is synced here instead of forcing a
		// second full repaint on the next rAF.
		if (state.renderer && !state.disposed) {
			const hoveredId = state.drag ? null : (state.hoveredId ?? state.kbFocusId);
			state.renderer.paint(buildSnapshot(state, hoveredId), false);
			const tf = state.transform;
			state.lastPaint = {
				k: tf.k,
				tx: tf.tx,
				ty: tf.ty,
				hoveredId,
				arrowLod: tf.k >= ARROW_HIDE_BELOW_K,
			};
		}
		// Re-centre the simulation only once the drag settles — `setParams`
		// warms the engine (alpha 0.3), so calling it per resize tick keeps
		// nodes drifting/jittering for as long as the user resizes.
		if (settleTimer !== undefined) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			if (state.disposed) return;
			state.layout.setParams(state.layoutParams);
		}, 200);
	});
	observer.observe(container);
	state.resizeObserver = observer;
}

/* ── Local view ─────────────────────────────────────────────────────────── */

/** Choose the node to centre local-graph mode on when it's switched on from
 *  Settings (no click to supply a root): the keyboard-focused or hovered node
 *  if the user is pointing at one, else the most-connected node so the scoped
 *  view lands on a hub rather than an arbitrary leaf. Null only when empty. */
function pickDefaultLocalRoot(state: AppState): string | null {
	if (state.kbFocusId && state.db.entities.some((e) => e.id === state.kbFocusId)) {
		return state.kbFocusId;
	}
	if (state.hoveredId && state.db.entities.some((e) => e.id === state.hoveredId)) {
		return state.hoveredId;
	}
	const degree = new Map<string, number>();
	for (const link of state.db.links) {
		if (link.deletedAt !== null) continue;
		degree.set(link.sourceEntityId, (degree.get(link.sourceEntityId) ?? 0) + 1);
		degree.set(link.destEntityId, (degree.get(link.destEntityId) ?? 0) + 1);
	}
	let best: string | null = null;
	let bestDegree = -1;
	for (const entity of state.db.entities) {
		if (entity.deletedAt !== null) continue;
		const d = degree.get(entity.id) ?? 0;
		if (d > bestDegree) {
			best = entity.id;
			bestDegree = d;
		}
	}
	return best;
}

function setLocalRoot(state: AppState, rootId: string | null, emit: () => void): void {
	state.localRootId = rootId;
	state.layoutNodes.clear();
	state.cutoffAt = null;
	resetCamera(state);
	reconcileScene(state);
	schedulePersist(state);
	emit();
}

function setLocalParams(
	state: AppState,
	patch: { depth?: number; direction?: LocalDirection },
	emit: () => void,
): void {
	if (state.localRootId === null) return;
	const nextDepth = patch.depth === undefined ? state.localDepth : clampLocalDepth(patch.depth);
	const nextDirection = patch.direction ?? state.localDirection;
	if (nextDepth === state.localDepth && nextDirection === state.localDirection) return;
	state.localDepth = nextDepth;
	state.localDirection = nextDirection;
	state.layoutNodes.clear();
	state.cutoffAt = null;
	reconcileScene(state);
	schedulePersist(state);
	emit();
}

/* ── Path view ──────────────────────────────────────────────────────────── */

function setPathHighlight(state: AppState, ids: readonly string[]): void {
	state.pathNodes = new Set(ids);
	state.forceRepaint = true;
}

function togglePathMode(state: AppState, emit: () => void): void {
	state.pathMode = !state.pathMode;
	state.pathStart = null;
	setPathHighlight(state, []);
	state.pathStatus = state.pathMode ? { text: t("path.hint.pickStart"), warn: false } : null;
	emit();
}

function handlePathPick(state: AppState, nodeId: string, emit: () => void): void {
	if (state.pathStart === null) {
		state.pathStart = nodeId;
		setPathHighlight(state, [nodeId]);
		state.pathStatus = { text: t("path.hint.pickEnd"), warn: false };
		emit();
		return;
	}
	const adjacency = buildAdjacency(
		state.scene.renderEdges.map((e) => ({
			source: e.link.sourceEntityId,
			dest: e.link.destEntityId,
		})),
	);
	const onPath = allShortestPaths(adjacency, state.pathStart, nodeId);
	const start = state.pathStart;
	state.pathStart = null;
	setPathHighlight(state, onPath ? Array.from(onPath) : []);
	const hops = onPath ? pathHops(shortestPath(adjacency, start, nodeId) ?? []) : 0;
	state.pathStatus = { text: pathStatusMessage(onPath, hops), warn: !onPath };
	emit();
}

function pathStatusMessage(onPath: ReadonlySet<string> | null, hops: number): string {
	if (!onPath) return t("path.hint.none");
	if (hops === 0) return t("path.hint.found");
	return plural(hops, "path.hint.hopsOne", "path.hint.hops", { count: hops });
}

/* ── Canvas click / dblclick / context-menu ─────────────────────────────── */

function bindCanvasClick(state: AppState, emit: () => void): void {
	const renderer = state.renderer;
	if (!renderer) return;
	const el = renderer.element;
	let down: { nodeId: string; x: number; y: number } | null = null;
	// 9.13.11 — an empty-space pointerdown is tracked so a low-drift release on
	// the background clears the selection (a drift past the threshold was a pan).
	let emptyDown: { x: number; y: number } | null = null;
	el.addEventListener("pointerdown", (event: PointerEvent) => {
		if (event.button !== 0 || state.linkDrag) {
			down = null;
			emptyDown = null;
			return;
		}
		const nodeId = renderer.pickNode(currentSnapshot(state), event.clientX, event.clientY);
		if (!nodeId) {
			down = null;
			emptyDown = { x: event.clientX, y: event.clientY };
			return;
		}
		down = { nodeId, x: event.clientX, y: event.clientY };
		emptyDown = null;
	});
	el.addEventListener("pointerup", (event: PointerEvent) => {
		const start = down;
		down = null;
		const empty = emptyDown;
		emptyDown = null;
		if (!start) {
			// Background click (not a pan) drops the selection.
			if (empty && state.selectedIds.size > 0) {
				const bgDrift = Math.hypot(event.clientX - empty.x, event.clientY - empty.y);
				if (bgDrift <= 3) {
					clearNodeSelectionInto(state);
					emit();
				}
			}
			return;
		}
		const drift = Math.hypot(event.clientX - start.x, event.clientY - start.y);
		if (drift > 3) return;
		const node = state.scene.renderNodes.find((n) => n.id === start.nodeId);
		if (!node) return;
		const action = singleClickAction({
			pathMode: state.pathMode,
			localMode: state.localRootId !== null,
			isCurrentRoot: state.localRootId === start.nodeId,
		});
		switch (action) {
			case NodeClickAction.PathPick:
				handlePathPick(state, start.nodeId, emit);
				return;
			case NodeClickAction.Traverse:
				setLocalRoot(state, start.nodeId, emit);
				return;
			case NodeClickAction.None:
				return;
			default: {
				// 9.13.11 — single click selects (multi-select via Shift/Mod);
				// double click opens (the dblclick listener below). Background
				// clicks + Escape clear the selection.
				const modifier = modifierFromEvent({
					shift: event.shiftKey,
					mod: event.metaKey || event.ctrlKey,
				});
				const order = state.scene.renderNodes.map((n) => n.id);
				const next = applyNodeSelection(
					{ selected: state.selectedIds, anchor: state.selectionAnchor },
					start.nodeId,
					modifier,
					order,
				);
				state.selectedIds = next.selected;
				state.selectionAnchor = next.anchor;
				state.forceRepaint = true;
				state.presenceRepublish?.();
				emit();
			}
		}
	});
}

function localViewExtraItem(
	state: AppState,
	nodeId: string,
	emit: () => void,
): ObjectMenuExtraItem {
	const isRoot = state.localRootId === nodeId;
	return {
		id: isRoot ? "local-exit" : "local-enter",
		label: isRoot ? t("menu.exitLocalView") : t("menu.enterLocalView"),
		icon: IconName.View,
		run: () => setLocalRoot(state, isRoot ? null : nodeId, emit),
	};
}

function openNodeObjectMenu(
	state: AppState,
	nodeId: string,
	x: number,
	y: number,
	emit: () => void,
): void {
	const node = state.scene.renderNodes.find((n) => n.id === nodeId);
	if (!node) return;
	void openObjectMenu(
		{ x, y },
		{
			target: {
				entityId: node.entity.id,
				entityType: node.entity.type,
				label: rawNodeLabel(node.entity),
			},
			runtime: getRuntime() as ObjectMenuRuntime,
			extraItems: [localViewExtraItem(state, nodeId, emit)],
			labels: {
				open: t("menu.open"),
				pin: t("menu.pin"),
				unpin: t("menu.unpin"),
				menuRegion: t("menu.region"),
			},
		},
	);
}

function bindCanvasContextMenu(state: AppState, emit: () => void): void {
	const renderer = state.renderer;
	if (!renderer) return;
	const el = renderer.element;
	el.addEventListener("contextmenu", (event: MouseEvent) => {
		event.preventDefault();
		const nodeId = renderer.pickNode(currentSnapshot(state), event.clientX, event.clientY);
		if (!nodeId) {
			if (state.localRootId !== null) setLocalRoot(state, null, emit);
			return;
		}
		openNodeObjectMenu(state, nodeId, event.clientX, event.clientY, emit);
	});
	el.addEventListener("dblclick", (event: MouseEvent) => {
		const nodeId = renderer.pickNode(currentSnapshot(state), event.clientX, event.clientY);
		if (!nodeId) return;
		event.preventDefault();
		const node = state.scene.renderNodes.find((n) => n.id === nodeId);
		if (node) {
			void openEntity(getRuntime(), {
				entityId: node.entity.id,
				entityType: node.entity.type,
			});
		}
	});
}

/* ── Keyboard (global chords + canvas focus) ────────────────────────────── */

function bindGlobalKeyboard(state: AppState, emit: () => void): void {
	const typingInField = (): boolean => {
		const el = document.activeElement;
		if (!(el instanceof HTMLElement)) return false;
		return (
			el.tagName === "INPUT" ||
			el.tagName === "TEXTAREA" ||
			el.tagName === "SELECT" ||
			el.isContentEditable
		);
	};

	attachShortcut(window, GRAPH_CHORDS[GraphAction.ToggleLocalView], () => {
		if (typingInField()) return;
		const hovered = state.hoveredId;
		if (hovered) {
			setLocalRoot(state, state.localRootId === hovered ? null : hovered, emit);
		} else if (state.localRootId !== null) {
			setLocalRoot(state, null, emit);
		}
	});
	attachShortcut(window, GRAPH_CHORDS[GraphAction.ExitLocalView], () => {
		if (state.localRootId !== null) setLocalRoot(state, null, emit);
	});
	attachShortcut(window, GRAPH_CHORDS[GraphAction.ZoomIn], () => {
		const c = canvasCenter(state);
		zoomAround(state, c.x, c.y, KEYBOARD_ZOOM_STEP, emit);
	});
	attachShortcut(window, GRAPH_CHORDS[GraphAction.ZoomOut], () => {
		const c = canvasCenter(state);
		zoomAround(state, c.x, c.y, 1 / KEYBOARD_ZOOM_STEP, emit);
	});
	attachShortcut(window, GRAPH_CHORDS[GraphAction.ZoomReset], () => {
		resetCamera(state);
		emit();
	});
	attachShortcut(window, GRAPH_CHORDS[GraphAction.TogglePlayback], () => {
		if (typingInField()) return;
		togglePlayback(state, emit);
	});
}

let kbLiveRegion: LiveRegionHandle | null = null;

function currentFocusRing(state: AppState) {
	return focusableNodes(state.scene.renderNodes, state.layoutNodes);
}

function panByScreen(state: AppState, dxClient: number, dyClient: number): void {
	const el = state.renderer?.element;
	if (!el) return;
	const rect = el.getBoundingClientRect();
	const vbWidth = state.layoutParams.width || rect.width || 1;
	const vbHeight = state.layoutParams.height || rect.height || 1;
	state.pendingFitAfterSettle = false;
	state.transform = {
		...state.transform,
		tx: state.transform.tx + (dxClient / (rect.width || 1)) * vbWidth,
		ty: state.transform.ty + (dyClient / (rect.height || 1)) * vbHeight,
	};
	schedulePersist(state);
}

function ensureNodeVisible(state: AppState, id: string): void {
	const node = state.layoutNodes.get(id);
	const el = state.renderer?.element;
	if (!node || !el) return;
	const screen = state.renderer?.nodeToClient(state.transform, node.x, node.y);
	if (!screen) return;
	const rect = el.getBoundingClientRect();
	const insetX = rect.width * 0.15;
	const insetY = rect.height * 0.15;
	const relX = screen.x - rect.left;
	const relY = screen.y - rect.top;
	const outside =
		relX < insetX || relX > rect.width - insetX || relY < insetY || relY > rect.height - insetY;
	if (!outside) return;
	state.transform = focusNodeTransform(
		node,
		{ width: state.layoutParams.width, height: state.layoutParams.height },
		state.transform.k,
		{ min: ZOOM_MIN, max: ZOOM_MAX },
	);
	state.pendingFitAfterSettle = false;
	schedulePersist(state);
}

function announceFocus(state: AppState): void {
	if (!kbLiveRegion || state.kbFocusId === null) return;
	const ring = currentFocusRing(state);
	const index = ring.findIndex((n) => n.id === state.kbFocusId);
	if (index === -1) return;
	const count = neighborsOf(state.kbFocusId, state.scene).size;
	kbLiveRegion.announce(
		plural(count, "canvas.focusAnnounceOne", "canvas.focusAnnounce", {
			name: nodeLabelById(state, state.kbFocusId),
			index: index + 1,
			total: ring.length,
			count,
		}),
	);
}

function moveKbFocus(state: AppState, nextId: string | null, emit: () => void): void {
	if (nextId === null) return;
	state.kbFocusId = nextId;
	ensureNodeVisible(state, nextId);
	announceFocus(state);
	emit();
}

function bindCanvasFocusKeyboard(state: AppState, container: HTMLElement, emit: () => void): void {
	container.tabIndex = 0;
	container.setAttribute("role", "application");
	container.setAttribute("aria-label", t("canvas.ariaLabel"));
	container.setAttribute("aria-roledescription", t("canvas.roleDescription"));
	container.setAttribute(
		"aria-keyshortcuts",
		"Tab ArrowUp ArrowDown ArrowLeft ArrowRight Enter Escape",
	);

	if (!kbLiveRegion) {
		kbLiveRegion = attachLiveRegion(container, { className: "graph-canvas__live-region" });
	}

	container.addEventListener("focus", () => {
		if (state.kbFocusId === null) moveKbFocus(state, initialFocus(currentFocusRing(state)), emit);
		else announceFocus(state);
	});
	container.addEventListener("blur", () => {
		state.kbFocusId = null;
		kbLiveRegion?.announce("");
		emit();
	});

	const focusStep = (delta: 1 | -1) =>
		moveKbFocus(state, sequentialFocusStep(currentFocusRing(state), state.kbFocusId, delta), emit);
	attachShortcut(container, GRAPH_CHORDS[GraphAction.FocusNext], () => focusStep(1));
	attachShortcut(container, GRAPH_CHORDS[GraphAction.FocusPrev], () => focusStep(-1));

	const spatialStep = (direction: SpatialDirection) =>
		moveKbFocus(state, spatialFocusStep(currentFocusRing(state), state.kbFocusId, direction), emit);
	attachShortcut(container, GRAPH_CHORDS[GraphAction.FocusUp], () =>
		spatialStep(SpatialDirection.Up),
	);
	attachShortcut(container, GRAPH_CHORDS[GraphAction.FocusDown], () =>
		spatialStep(SpatialDirection.Down),
	);
	attachShortcut(container, GRAPH_CHORDS[GraphAction.FocusLeft], () =>
		spatialStep(SpatialDirection.Left),
	);
	attachShortcut(container, GRAPH_CHORDS[GraphAction.FocusRight], () =>
		spatialStep(SpatialDirection.Right),
	);

	const panStep = (dx: number, dy: number) => {
		const el = state.renderer?.element;
		const rect = el?.getBoundingClientRect();
		panByScreen(
			state,
			dx * (rect?.width ?? 0) * KEYBOARD_PAN_FRACTION,
			dy * (rect?.height ?? 0) * KEYBOARD_PAN_FRACTION,
		);
		emit();
	};
	attachShortcut(container, GRAPH_CHORDS[GraphAction.PanUp], () => panStep(0, 1));
	attachShortcut(container, GRAPH_CHORDS[GraphAction.PanDown], () => panStep(0, -1));
	attachShortcut(container, GRAPH_CHORDS[GraphAction.PanLeft], () => panStep(1, 0));
	attachShortcut(container, GRAPH_CHORDS[GraphAction.PanRight], () => panStep(-1, 0));

	attachShortcut(container, GRAPH_CHORDS[GraphAction.OpenFocused], () => {
		if (state.kbFocusId === null) return;
		const node = state.scene.renderNodes.find((n) => n.id === state.kbFocusId);
		if (!node) return;
		if (state.pathMode) {
			handlePathPick(state, node.id, emit);
			return;
		}
		void openEntity(getRuntime(), { entityId: node.entity.id, entityType: node.entity.type });
	});

	attachShortcut(container, GRAPH_CHORDS[GraphAction.ReleaseFocus], () => {
		state.kbFocusId = null;
		clearNodeSelectionInto(state);
		container.blur();
		emit();
	});
}

/** Replace the selection with a single node (the probe / programmatic path). */
function selectSingleNode(state: AppState, id: string, emit: () => void): void {
	const order = state.scene.renderNodes.map((n) => n.id);
	const next = applyNodeSelection(
		{ selected: state.selectedIds, anchor: state.selectionAnchor },
		id,
		SelectionModifier.None,
		order,
	);
	state.selectedIds = next.selected;
	state.selectionAnchor = next.anchor;
	state.forceRepaint = true;
	state.presenceRepublish?.();
	emit();
}

/** Drop the selection in place (Escape / background). Sets `forceRepaint` so the
 *  focus-alpha animates back to bright; the caller emits. */
function clearNodeSelectionInto(state: AppState): void {
	if (state.selectedIds.size === 0 && state.selectionAnchor === null) return;
	const cleared = clearNodeSelection();
	state.selectedIds = cleared.selected;
	state.selectionAnchor = cleared.anchor;
	state.forceRepaint = true;
	state.presenceRepublish?.();
}

/* ── Theme tracking ─────────────────────────────────────────────────────── */

function watchTokenChanges(state: AppState, emit: () => void): void {
	if (typeof MutationObserver === "undefined") return;
	const observer = new MutationObserver(() => {
		const next = resolveGraphTheme();
		if (sameTheme(state.theme, next)) return;
		state.theme = next;
		reconcileScene(state);
		emit();
	});
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
}

/** Set the status-pill content on the snapshot + emit so React re-renders. */
function setStatus(state: AppState, text: string, kind: "ready" | "warn", emit: () => void): void {
	state.status = text ? { text, kind } : null;
	emit();
}

function sameTheme(a: GraphTheme, b: GraphTheme): boolean {
	if (a.unmatched !== b.unmatched) return false;
	if (a.edge.matched !== b.edge.matched) return false;
	if (a.edge.unmatched !== b.edge.unmatched) return false;
	if (a.edge.body !== b.edge.body) return false;
	if (a.edge.reference !== b.edge.reference) return false;
	if (a.edge.shared !== b.edge.shared) return false;
	if (a.subjectPalette.length !== b.subjectPalette.length) return false;
	for (let i = 0; i < a.subjectPalette.length; i += 1) {
		if (a.subjectPalette[i] !== b.subjectPalette[i]) return false;
	}
	return true;
}

/* ── Persistence ────────────────────────────────────────────────────────── */

async function readPersistedRaw(): Promise<PersistedState | null> {
	const storage = getStorage();
	if (!storage) return null;
	try {
		const raw = await storage.get<PersistedState>(STORAGE_KEY);
		return shouldRestorePersisted(raw) ? (raw as PersistedState) : null;
	} catch (error) {
		console.warn("[graph] failed to load persisted state:", error);
		return null;
	}
}

function applyPersistedState(state: AppState, raw: PersistedState): void {
	state.settings = {
		showUnmatched: !!raw.settings.showUnmatched,
		showLabels: !!raw.settings.showLabels,
		showArrows: !!raw.settings.showArrows,
		showIcons: raw.settings.showIcons ?? state.settings.showIcons,
		reveal: raw.settings.reveal ?? state.settings.reveal,
	};
	if (raw.forces) {
		const f = raw.forces as Partial<ForceSettings>;
		const num = (v: unknown, fallback: number): number =>
			typeof v === "number" && Number.isFinite(v) ? v : fallback;
		state.forces = {
			charge: num(f.charge, state.forces.charge),
			chargeDistanceMax: num(f.chargeDistanceMax, state.forces.chargeDistanceMax),
			linkDistance: num(f.linkDistance, state.forces.linkDistance),
			centerStrength: num(f.centerStrength, state.forces.centerStrength),
			collidePadding: num(f.collidePadding, state.forces.collidePadding),
			collideStrength: num(f.collideStrength, state.forces.collideStrength),
			velocityDecay: num(f.velocityDecay, state.forces.velocityDecay),
			maxSpeed: num(f.maxSpeed, state.forces.maxSpeed),
		};
		state.layoutParams = { ...state.layoutParams, ...state.forces };
		state.layout.setParams(state.layoutParams);
	}
	state.sidebarMode =
		raw.sidebarMode === SidebarMode.Settings ? SidebarMode.Settings : SidebarMode.Filters;
	state.sidebarCollapsed = !!raw.sidebarCollapsed;
	state.pinned = new Map(Object.entries(raw.pinned ?? {}));
	if (raw.pattern && isUsablePattern(raw.pattern)) {
		state.pattern = raw.pattern;
	}

	const rawT = raw.transform;
	if (rawT && Number.isFinite(rawT.k) && Number.isFinite(rawT.tx) && Number.isFinite(rawT.ty)) {
		state.transform = {
			k: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, rawT.k)),
			tx: rawT.tx,
			ty: rawT.ty,
		};
	}
	state.localRootId = raw.localRootId ?? null;
	state.localDepth = clampLocalDepth(raw.localDepth ?? DEFAULT_LOCAL_DEPTH);
	state.localDirection = Object.values(LocalDirection).includes(raw.localDirection as LocalDirection)
		? (raw.localDirection as LocalDirection)
		: DEFAULT_LOCAL_DIRECTION;

	const history = restoreHistoryState(raw.history);
	state.cutoffAt = history.cutoffAt;
	state.playbackSpeed = history.speed;
	state.settings.reveal = history.reveal;

	applySettingsToSvg(state);
	reconcileScene(state);

	// Self-heal a stale restored pattern: if the persisted constraints match
	// zero nodes while the vault actually has entities, they reference types /
	// links that no longer exist (a migrated or removed type URL). The SHOW
	// filter only offers toggles for types PRESENT in the vault, so the dead
	// constraint is invisible and unremovable — the canvas reads as permanently
	// blank with "no controls working". Fall back to show-everything.
	if (isStaleEmptyPattern(state.pattern, effectiveDb(state))) {
		state.pattern = defaultPattern();
		reconcileScene(state);
	}

	// Self-heal a blank canvas the user can't escape: a restored time cutoff
	// before every entity's `createdAt` (the scrubber was left in the past and
	// the vault changed underneath it), or a local-view focus that now reveals
	// nothing, hides ALL nodes — with no error and no obviously-stuck control.
	// The history-reveal gate (`createdAt <= cutoffAt`) and the pattern self-heal
	// above are independent, so a stale cutoff survives the pattern reset. If the
	// vault has entities but the scene renders none, drop the view-narrowing
	// (cutoff → Now, local focus → off) so the graph comes back.
	if (state.scene.renderNodes.length === 0 && state.db.entities.length > 0) {
		state.cutoffAt = null;
		state.localRootId = null;
		reconcileScene(state);
	}
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(state: AppState): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void persistState(state);
	}, 400);
}

async function persistState(state: AppState): Promise<void> {
	const storage = getStorage();
	if (!storage) return;
	const pinned: Record<string, { x: number; y: number }> = {};
	for (const [id, pos] of state.pinned) {
		pinned[id] = { x: pos.x, y: pos.y };
	}
	const payload: PersistedState = {
		version: CURRENT_PERSISTED_VERSION,
		pattern: state.pattern,
		settings: state.settings,
		forces: state.forces,
		sidebarMode: state.sidebarMode,
		sidebarCollapsed: state.sidebarCollapsed,
		pinned,
		transform: state.transform,
		localRootId: state.localRootId,
		localDepth: state.localDepth,
		localDirection: state.localDirection,
		history: captureHistoryState({
			cutoffAt: state.cutoffAt,
			speed: state.playbackSpeed,
			reveal: state.settings.reveal,
			bounds: state.scene.bounds,
		}),
	};
	try {
		await storage.put(STORAGE_KEY, payload);
	} catch (error) {
		console.warn("[graph] failed to persist state:", error);
	}
}

let graphEntityPersistTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleGraphEntityPersist(state: AppState): void {
	if (!state.graphRepo || !state.graphRecord) return;
	if (graphEntityPersistTimer) clearTimeout(graphEntityPersistTimer);
	graphEntityPersistTimer = setTimeout(() => {
		graphEntityPersistTimer = null;
		void persistGraphEntity(state);
	}, 400);
}

async function persistGraphEntity(state: AppState): Promise<void> {
	const repo = state.graphRepo;
	const record = state.graphRecord;
	if (!repo || !record) return;
	try {
		await repo.saveGraphPattern(record.id, state.pattern);
	} catch (error) {
		console.warn("[graph] failed to persist Graph/v1 pattern:", error);
	}
}

/* ── Per-view coordinate persistence (9.13.6, OQ-GR-2 (a)) ──────────────── */

let viewCoordsPersistTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleViewCoordsPersist(state: AppState): void {
	if (!state.viewRepo || !state.graphView) return;
	if (viewCoordsPersistTimer) clearTimeout(viewCoordsPersistTimer);
	viewCoordsPersistTimer = setTimeout(() => {
		viewCoordsPersistTimer = null;
		void persistViewCoords(state);
	}, 400);
}

/** Write the pinned node positions to the bound view's Y.Doc. Only pinned
 *  nodes carry user-meaningful coordinates (the force layout recomputes the
 *  rest), so the persisted set IS the pinned map. */
async function persistViewCoords(state: AppState): Promise<void> {
	const repo = state.viewRepo;
	const view = state.graphView;
	if (!repo || !view) return;
	const coords = new Map<string, NodeCoord>();
	for (const [id, pos] of state.pinned) {
		coords.set(id, { x: pos.x, y: pos.y, pinned: true });
	}
	await repo.saveViewCoords(view.id, coords);
}

/** Bind (or create) the Graph's default view and overlay its persisted
 *  coordinates onto the layout. View coordinates are the per-view truth for
 *  a bound graph — they overlay whatever the kv-persisted pinned map held. */
async function tryLoadViewCoords(state: AppState): Promise<void> {
	const repo = state.viewRepo;
	const graph = state.graphRecord;
	if (!repo || !graph) return;
	const view = await repo.ensureDefaultView(graph.id, t("view.defaultName"));
	if (!view) return;
	state.graphView = view;
	const coords = await repo.loadViewCoords(view.id);
	for (const [id, coord] of coords) {
		if (coord.pinned) state.pinned.set(id, { x: coord.x, y: coord.y });
	}
}

/* ── Vault data hookup ──────────────────────────────────────────────────── */

function vaultSnapshotToInMemoryGraph(snapshot: VaultSnapshot): InMemoryGraph {
	return {
		entities: snapshot.entities.map((e) => ({
			id: e.id,
			type: e.type,
			properties: e.properties,
			createdAt: e.createdAt,
			updatedAt: e.updatedAt,
			deletedAt: e.deletedAt,
		})),
		links: snapshot.links.map((l) => ({
			id: l.id,
			sourceEntityId: l.sourceEntityId,
			destEntityId: l.destEntityId,
			linkType: l.linkType,
			...(l.detail !== undefined ? { detail: l.detail } : {}),
			createdAt: l.createdAt,
			deletedAt: null,
		})),
	};
}

/** Feed the live vault snapshot in. The React chrome owns the
 *  `useVaultEntities` subscription (shared reactivity stack — no raw
 *  `onChange` loop here); this turns each delivered snapshot into the in-memory
 *  graph, reshades the scene, and resolves the pattern server-side. The FIRST
 *  delivery also runs the post-load bootstrap (re-assert persisted state →
 *  launch graph → fit → focus) and drops the hydrating veil. Later deliveries
 *  reshade WITHOUT refitting the camera (preserves the user's view). */
async function applyVaultData(
	state: AppState,
	snapshot: VaultSnapshot,
	emit: () => void,
): Promise<void> {
	// React feeds data continuously, but the post-load bootstrap (persisted
	// re-assert → launch graph → fit) must run only once the runtime's vault
	// session is open — so buffer the latest snapshot until `ready` fires.
	if (!state.runtimeReady) {
		state.bufferedVaultData = snapshot;
		return;
	}
	state.db = backfillCreatedAt(vaultSnapshotToInMemoryGraph(snapshot));
	const firstLoad = !state.dataLoaded;
	if (firstLoad) state.cutoffAt = null;
	reconcileScene(state);
	const count = snapshot.entities.length;
	if (count === 0) {
		setStatus(state, t("status.empty"), "warn", emit);
	} else {
		setStatus(
			state,
			t("status.count", {
				count,
				noun: plural(count, "status.entitySingular", "status.entityPlural"),
			}),
			"ready",
			emit,
		);
	}

	if (firstLoad) {
		state.dataLoaded = true;
		const raw = state.pendingPersisted;
		if (raw) {
			applyPersistedState(state, raw);
			state.pendingPersisted = null;
		}
		await tryLoadLaunchGraph(state);
		fitTransformToContent(state);
		state.pendingFitAfterSettle = true;
		applyLaunchContextNodeFocus(state);
		schedulePersist(state);
		state.clearHydrating?.();
		state.clearHydrating = null;
	}

	await resolvePatternServerSide(state, emit);
	emit();
}

async function resolvePatternServerSide(state: AppState, emit: () => void): Promise<void> {
	const runtime = getRuntime();
	const queryPattern = runtime?.services?.vaultEntities?.queryPattern;
	if (!queryPattern) return;
	if (!isUsablePattern(state.pattern)) return;
	try {
		const reply = await queryPattern.call(runtime?.services?.vaultEntities, state.pattern);
		if (reply.ok) return;
		if (reply.error.kind === "pattern-too-expensive") {
			setStatus(state, t("status.patternTooBroad", { message: reply.error.message }), "warn", emit);
		} else {
			setStatus(state, t("status.patternNotRunnable", { message: reply.error.message }), "warn", emit);
		}
	} catch (error) {
		console.warn("[graph] vaultEntities.queryPattern failed (client match stands)", error);
	}
}

async function tryLoadLaunchGraph(state: AppState): Promise<void> {
	const runtime = getRuntime();
	const launch = runtime?.launch;
	if (!launch || launch.reason !== "open-entity" || !launch.entityId) return;
	if (!state.graphRepo) return;
	let record: GraphRecord | null;
	try {
		record = await state.graphRepo.loadGraph(launch.entityId);
	} catch (error) {
		console.warn("[graph] loadGraph failed:", error);
		return;
	}
	if (!record) return;
	state.graphRecord = record;
	state.presenceBindGraph?.(record.id);
	state.pattern = record.pattern;
	state.cutoffAt = null;
	state.layoutNodes.clear();
	await tryLoadViewCoords(state);
	reconcileScene(state);
}

function applyLaunchContextNodeFocus(state: AppState): void {
	const launch = getRuntime()?.launch;
	if (!launch || launch.reason !== "open-entity" || !launch.entityId) return;
	if (state.graphRecord && state.graphRecord.id === launch.entityId) return;
	focusNodeById(state, launch.entityId);
}

function subscribeRuntimeIntents(state: AppState, emit: () => void): void {
	const runtime = getRuntime();
	runtime?.on?.("intent", (event) => {
		if (event.type !== "intent" || event.intent?.verb !== "open") return;
		const id = event.intent.payload?.entityId;
		if (typeof id !== "string" || !id) return;
		focusNodeById(state, id);
		emit();
	});
}

function hydrateFromRuntime(state: AppState, callbacks: HydrateCallbacks, emit: () => void): void {
	const runtime = getRuntime();
	if (!runtime) {
		setStatus(state, t("status.noVault"), "warn", emit);
		callbacks.clearHydrating();
		return;
	}
	state.clearHydrating = callbacks.clearHydrating;
	watchTokenChanges(state, emit);
	setStatus(state, t("status.loading"), "warn", emit);
	runtime.on("ready", () => {
		void (async () => {
			state.pendingPersisted = await readPersistedRaw();
			if (state.pendingPersisted) applyPersistedState(state, state.pendingPersisted);
			subscribeRuntimeIntents(state, emit);
			state.runtimeReady = true;
			const buffered = state.bufferedVaultData;
			state.bufferedVaultData = null;
			if (buffered) await applyVaultData(state, buffered, emit);
			emit();
		})();
	});
}

export const __testing = {
	SCRUBBER_STEPS,
	PLAYBACK_SPEEDS,
	computeSnapshot,
	sceneOptionsFrom,
	persistViewCoords,
	tryLoadViewCoords,
	writeCreateLink,
	applyPersistedState,
	reconcileScene,
	effectiveDb,
	setLocalParams,
	setLocalRoot,
};
