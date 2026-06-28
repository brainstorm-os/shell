/**
 * Whiteboard canvas engine — the imperative draw surface, selection model,
 * connector / node rendering, freehand / primitive drawing, and pointer-capture
 * interactions, extracted verbatim from the pre-React `app.ts` (9.17.21).
 *
 * The engine owns ONLY the canvas: it builds the canvas-wrap DOM (edge host,
 * camera-transformed canvas, node layer, edge-label overlay, alignment-guide
 * layer) into a host element React hands it, mounts the GPU Pixi edge layer,
 * and binds every gesture. Everything *around* the canvas — the app header,
 * the authoring toolbar, the zoom controls, the board-list sidebar chrome, the
 * Add / Style / Arrange / Export menus, the layers-panel toggle — is React
 * (`app.tsx`); the engine exposes imperative action methods those controls
 * call and a `subscribe()` snapshot they re-render from.
 *
 * The camera-paint split is preserved exactly: `paint()` rebuilds the node DOM
 * + board bounds (model changes); `paintCamera()` only writes the canvas
 * transform + zoom readout + GPU edge world-transform (pan / zoom pointermove),
 * never the node-DOM rebuild. Whiteboard has no per-frame rAF loop — `paint` /
 * `paintCamera` fire on demand — so there is no visibility/park pause to wire.
 *
 * Data source resolution:
 *   - **shell launch** (`window.brainstorm` present): hydrate from the shared
 *     entities service on `ready`; drag-ends persist via the repository. Save
 *     fires once on `pointerup`, not on every `pointermove`.
 *   - **standalone** (`window.brainstorm` undefined): start with the empty
 *     placeholder; "New board" creates an in-memory board for the page lifetime.
 */

import { openEntity } from "@brainstorm/sdk";
import { type LiveRegionHandle, attachLiveRegion } from "@brainstorm/sdk/a11y";
import {
	SaveDispositionKind,
	requestSaveBytes,
	suggestedFilename,
	svgToPng,
	textToBytes,
} from "@brainstorm/sdk/export-file";
import { IconName } from "@brainstorm/sdk/icon";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { type NavHistory, createNavHistory } from "@brainstorm/sdk/nav-history";
import { formatBrainstormEntityUri } from "@brainstorm/sdk/note-references";
import {
	type AnchoredMenuItem,
	type ObjectMenuContext,
	type ObjectMenuRuntime,
	openAnchoredMenu,
} from "@brainstorm/sdk/object-menu";
import { localPresenceName } from "@brainstorm/sdk/peer-presence";
import { attachResizable } from "@brainstorm/sdk/resizable";
import { mountSpellcheckMenuFromWindow } from "@brainstorm/sdk/spellcheck-menu";
import { type WhiteboardMessageKey, createT, pluralWith } from "./i18n/t";
import {
	type AlignKind,
	type AlignRect,
	type DistributeAxis,
	type Positions,
	alignRects,
	distributeRects,
} from "./logic/align";
import { filterAndSortBoards } from "./logic/board-list";
import {
	type ConnectorEnd,
	buildConnectorEdge,
	isValidConnectorDrop,
	nearestHandleSide,
} from "./logic/connector";
import {
	frameMoveDelta,
	groupBounds,
	nodesWithinFrame,
	resolveDragSet,
	translateNodes,
} from "./logic/containment";
import { polylineMidpoint } from "./logic/edge-path";
import {
	isBidirectional,
	setEdgeArrowHead,
	setEdgeBidirectional,
	setEdgeColor,
	setEdgeDashed,
	setEdgePathKind,
} from "./logic/edge-style";
import { type Point, positionForHandle } from "./logic/handle-positions";
import {
	type HistoryState,
	initialHistory,
	pushHistory,
	redo as redoHistory,
	undo as undoHistory,
} from "./logic/history";
import { PickImageKind, pickImage } from "./logic/image-pick";
import { buildInkGeometry } from "./logic/ink";
import { buildLayerList } from "./logic/layer-list";
import {
	type CanvasPoint,
	createEmbeddedNode,
	createFrameNode,
	createGroupNode,
	createImageNode,
	createInkNode,
	createShapeNode,
	createStickyNode,
	createTextNode,
} from "./logic/node-factory";
import {
	hasSticky,
	hasStyleableText,
	selectionBold,
	selectionItalic,
	setBoldFor,
	setFontFamilyFor,
	setItalicFor,
	setStickyFillFor,
	setTextColorFor,
	setTextSizeFor,
} from "./logic/node-style";
import {
	PRESENCE_FIELD,
	type RemotePeer,
	buildLocalPresence,
	presencePeers,
} from "./logic/presence";
import { createLocalAwareness } from "./logic/presence-channel";
import { plainToRich, richRunsEqual } from "./logic/rich-text";
import { selectionSummary, shouldSelectOnFocus } from "./logic/selection-announce";
import { SnapAxis, type SnapGuide, type SnapRect, computeSnap } from "./logic/snap";
import { resolveSpawnPoint } from "./logic/spawn-position";
import { buildNodeStyleItems, hasStyleTarget } from "./logic/style-menu";
import { BOARD_TEMPLATES, BoardTemplate, buildTemplate } from "./logic/templates";
import { type WorldRect, visibleNodeIds, worldViewport } from "./logic/viewport-cull";
import { type WhiteboardExportFormat, exportWhiteboard, toSVG } from "./logic/whiteboard-export";
import { type ZOrderOp, computeZOrder } from "./logic/z-order";
import { type EdgeRenderInput, edgePolyline, nearestEdgeId } from "./render/edge-geometry";
import { EmbedMountController, EmbedMountRegistry, embedCandidates } from "./render/embed-mount";
import { buildNodeContent } from "./render/node-dom";
import {
	type PixiEdgeHandles,
	mountPixiEdges,
	paintPixiEdges,
	resizePixiEdges,
} from "./render/pixi-edges";
import { type PresenceNodeRect, renderPresenceOverlay } from "./render/presence-overlay";
import { ActionId, bindShortcut } from "./shortcuts";
import { WHITEBOARD_TYPE, createEntitiesRepository } from "./storage/entities-repository";
import type { WhiteboardsRepository } from "./storage/repository";
import { getBrainstorm } from "./storage/runtime";
import {
	ARROW_HEADS,
	EDGE_COLORS,
	EDGE_PATH_KINDS,
	EdgeColor,
	HandleSide,
	type WhiteboardEdge,
	edgeColorToCss,
} from "./types/edge";
import {
	type EmbeddedNode,
	type FontFamily,
	NodeKind,
	ShapeKind,
	type StickyColor,
	type TextColor,
	type TextSize,
	type WhiteboardNode,
	isEmbedded,
	isFrame,
	isGroup,
	isSticky,
	isText,
} from "./types/node";
import type { Whiteboard } from "./types/whiteboard";
import { type BoardListViewHandle, renderBoardListView } from "./ui/board-list-view";
import { type FormatToolbarHandle, createFormatToolbar } from "./ui/format-toolbar";
import { type LayersPanelHandle, createLayersPanel } from "./ui/layers-panel";
import { beginInlineTextEdit } from "./ui/text-edit";

type DragState = {
	pointerId: number;
	nodeId: string;
	offsetX: number;
	offsetY: number;
	moved: boolean;
	startX: number;
	startY: number;
};

type ConnectorDrag = {
	pointerId: number;
	from: ConnectorEnd;
	toPoint: Point;
};

/** Authoring tools (instruments panel). */
export const ToolId = {
	Select: "select",
	Sticky: "sticky",
	Text: "text",
	Frame: "frame",
	Pen: "pen",
} as const;
export type ToolId = (typeof ToolId)[keyof typeof ToolId];

type AppState = {
	whiteboard: Whiteboard;
	edges: WhiteboardEdge[];
	zoom: number;
	pan: { x: number; y: number };
	drag: DragState | null;
	connector: ConnectorDrag | null;
	ink: { pointerId: number; points: Point[] } | null;
	selectedIds: Set<string>;
	editingNodeId: string | null;
	editingEdgeId: string | null;
	selectedEdgeId: string | null;
	readonly: boolean;
	tool: ToolId;
	repository: WhiteboardsRepository | null;
	allWhiteboards: Whiteboard[];
	allEdges: WhiteboardEdge[];
	navQuery: string;
};

const EMPTY_PLACEHOLDER_BOARD: Whiteboard = {
	id: "",
	name: "",
	icon: null,
	nodes: [],
	createdAt: 0,
	updatedAt: 0,
};

/** Host elements the React chrome hands the engine. Each is a plain `<div>`
 *  the engine fills with its imperative surface (the canvas, the layers panel,
 *  the live region, the board-list rows, the searchbar) so the surrounding
 *  chrome stays React while the canvas / SDK-DOM helpers stay imperative. */
export type EngineHosts = {
	/** Fills with the canvas-wrap (edge host + camera canvas + overlays). */
	canvas: HTMLElement;
	/** Fills with the layers-panel overlay. */
	layers: HTMLElement;
	/** Fills with the board-list rows / empty state. */
	navList: HTMLElement;
	/** The `#whiteboard-root` element — carries `data-navOpen` + the live region. */
	root: HTMLElement;
};

/** Chrome-relevant derived state the React header / sidebar render from. */
export type ChromeSnapshot = {
	boardId: string;
	boardName: string;
	boardIcon: Whiteboard["icon"];
	tool: ToolId;
	zoomPercent: number;
	canStyle: boolean;
	navOpen: boolean;
};

export type WhiteboardEngine = {
	/** Subscribe to chrome-snapshot changes (selection / tool / zoom / board). */
	subscribe(listener: () => void): () => void;
	getSnapshot(): ChromeSnapshot;
	/** Object-menu context for the open board (right-click + ⋯), or null. */
	boardContext(): ObjectMenuContext;
	objectMenuRuntime(): ObjectMenuRuntime;
	hasFilesService(): boolean;
	hasVaultEntities(): boolean;
	// Actions (called from React chrome) ────────────────────────────────────
	createSticky(): void;
	createText(): void;
	createFrame(): void;
	createShape(shape: ShapeKind): void;
	createRectangle(): void;
	createEllipse(): void;
	createGroupFromSelection(): void;
	placeImageFromFile(): Promise<void>;
	pickEntityToEmbed(anchor: HTMLElement): Promise<void>;
	alignSelection(kind: AlignKind): void;
	distributeSelection(axis: DistributeAxis): void;
	applyZOrder(op: ZOrderOp): void;
	setSelectionLocked(locked: boolean): void;
	/** Board-level read-only lock — when true the whole canvas rejects edits
	 *  (no create/move/resize/text-edit); pan, zoom, and selection still work. */
	setReadonly(readonly: boolean): void;
	setSelectionTextSize(size: TextSize): void;
	setSelectionStickyFill(color: StickyColor): void;
	setSelectionTextColor(color: TextColor): void;
	setSelectionFontFamily(font: FontFamily): void;
	toggleSelectionBold(): void;
	toggleSelectionItalic(): void;
	buildConnectorStyleItems(): AnchoredMenuItem[];
	styleMenuItems(): AnchoredMenuItem[];
	exportText(format: WhiteboardExportFormat): string;
	saveBoardAsFile(row: SaveRow): Promise<SaveDisposition>;
	undo(): void;
	redo(): void;
	zoomBy(factor: number): void;
	zoomTo(level: number): void;
	resetCamera(): void;
	setTool(next: ToolId): void;
	setLayersOpen(open: boolean): void;
	isLayersOpen(): boolean;
	setNavQuery(query: string): void;
	toggleNav(): void;
	createNewBoard(template?: BoardTemplate): void;
	/** The shared in-app back/forward history over open-board ids. The header
	 *  `<NavButtons>` subscribes to this for live disabled state and steps it;
	 *  the engine pushes onto it on every user board open (`openBoard`). */
	boardNav(): NavHistory<string>;
	/** Open a board id the user stepped to via back/forward WITHOUT re-recording
	 *  it (runs under the `applyingNavHistory` guard). This is `<NavButtons>`'s
	 *  `onNavigate` — the history step itself is done by `NavButtons`. */
	applyBoardLocation(id: string): void;
	/** Step to the previous / next board in the history (steps the history AND
	 *  applies), for the shared chords / mouse thumb buttons. */
	goBoardBack(): void;
	goBoardForward(): void;
	changeBoardIcon(): void;
	renameBoard(next: string): void;
	/** Re-read boards from the vault + repaint. Driven by the React
	 *  `useVaultEntities` snapshot — the shared reactivity stack — so a
	 *  cross-app write / dev reseed surfaces without a raw onChange loop. */
	refreshBoards(): void;
	/** Mount the GPU edge layer + run the initial boot/load. Call once after
	 *  the React tree (and its host refs) are committed. */
	start(): void;
	dispose(): void;
};

export type SaveRow = {
	labelKey: WhiteboardMessageKey;
	extension: string;
	filterName: string;
	encode: () => Uint8Array | Promise<Uint8Array>;
};

export type SaveDisposition =
	| { kind: typeof SaveDispositionKind.Saved }
	| { kind: typeof SaveDispositionKind.Cancelled }
	| { kind: typeof SaveDispositionKind.Failed; error: unknown };

const SNAP_THRESHOLD_PX = 6;
const EDGE_PICK_TOLERANCE_PX = 10;
const NAV_PREF_KEY = "whiteboard.navOpen";

/** Dev/test hook (parallel to Notes' `__brainstormNotesDev`): a Playwright
 *  synthetic pointer can't drive `setPointerCapture`, so node drags can't be
 *  exercised through real mouse events. This drives the *same* snap + move
 *  primitives the pointer loop uses, so the spec verifies the wired path. */
type WhiteboardDevGlobal = {
	nodeIds: () => string[];
	dragNodeBy: (id: string, dx: number, dy: number) => { x: number; y: number; guides: number };
	endDrag: () => void;
	connect: (sourceId: string, destId: string) => string | null;
	/** Perf/cull harness (9.17.20): seed a grid of N stickies and a full
	 *  reconcile, with no per-node focus churn. Returns the seeded ids. */
	seedGrid: (count: number, opts?: { cols?: number; cell?: number }) => string[];
	/** The node ids currently mounted in the DOM layer (post-cull). */
	mountedNodeIds: () => string[];
	/** Drive the camera (pan/zoom) the way the pan/zoom gestures do, running the
	 *  same `paintCamera` cull reconcile a real pan would. */
	setCamera: (camera: { panX: number; panY: number; zoom: number }) => void;
	/** A node's DOM element (for element-identity assertions across a drag). */
	nodeEl: (id: string) => HTMLElement | null;
	selectEdge: (id: string) => void;
	drawInk: (points: ReadonlyArray<{ x: number; y: number }>) => string | null;
	edgeState: (id: string) => {
		pathKind: string;
		arrowHead: string;
		sourceArrowHead: string | null;
		dashed: boolean;
		colorHint: string | null;
	} | null;
	/** Presence (9.17.19): inject a remote peer state (what the future
	 *  inbound transport adapter does) + read the rendered peers. */
	presence: {
		clientId: () => number;
		applyRemote: (clientId: number, state: Record<string, unknown> | null) => void;
		peers: () => Array<{ clientId: number; name: string; cursor: { x: number; y: number } | null }>;
	};
};

declare global {
	interface Window {
		__brainstormWhiteboardDev?: WhiteboardDevGlobal;
	}
}

// Stand up the fancy-menus runtime once so object / context menus open
// through the shared bridge (Stage 8.8). Idempotent across re-imports.
mountMenuHost();
// B11.16c — spellcheck suggestion menu for sticky / shape text editing.
mountSpellcheckMenuFromWindow();

const t = createT();

export function createWhiteboardEngine(hosts: EngineHosts): WhiteboardEngine {
	const root = hosts.root;

	const state: AppState = {
		// Fresh `nodes` array — a shallow spread would share the placeholder's
		// array across engine instances, leaking board-less spawns between them.
		whiteboard: { ...EMPTY_PLACEHOLDER_BOARD, nodes: [] },
		edges: [],
		zoom: 1,
		pan: { x: 0, y: 0 },
		drag: null,
		connector: null,
		ink: null,
		selectedIds: new Set<string>(),
		editingNodeId: null,
		editingEdgeId: null,
		selectedEdgeId: null,
		/** Board-level read-only lock (the board's synced `locked` property).
		 *  When true every mutation entry point no-ops; selection/pan/zoom stay. */
		readonly: false,
		tool: ToolId.Select,
		repository: null,
		allWhiteboards: [],
		allEdges: [],
		navQuery: "",
	};

	const wbNav = createNavHistory<string>({ initial: "" });
	let applyingNavHistory = false;

	const embedRegistry = new EmbedMountRegistry();

	let pixi: PixiEdgeHandles | null = null;
	let navListKeyboard: BoardListViewHandle | null = null;
	let pointerClient: { x: number; y: number } | null = null;
	let resizeObserver: ResizeObserver | null = null;
	let nudgePersistTimer: ReturnType<typeof setTimeout> | null = null;
	const unbinders: Array<() => void> = [];

	// ── Chrome subscription ──────────────────────────────────────────────────
	const listeners = new Set<() => void>();
	let snapshot: ChromeSnapshot = computeSnapshot();
	function computeSnapshot(): ChromeSnapshot {
		return {
			boardId: state.whiteboard.id,
			boardName: state.whiteboard.name,
			boardIcon: state.whiteboard.icon ?? null,
			tool: state.tool,
			zoomPercent: Math.round(state.zoom * 100),
			canStyle: hasStyleTarget(state.selectedIds, state.selectedEdgeId),
			navOpen: root.dataset.navOpen !== "false",
		};
	}
	function emitChrome(): void {
		const next = computeSnapshot();
		if (
			next.boardId === snapshot.boardId &&
			next.boardName === snapshot.boardName &&
			next.boardIcon === snapshot.boardIcon &&
			next.tool === snapshot.tool &&
			next.zoomPercent === snapshot.zoomPercent &&
			next.canStyle === snapshot.canStyle &&
			next.navOpen === snapshot.navOpen
		) {
			return;
		}
		snapshot = next;
		for (const l of listeners) l();
	}

	function objectMenuRuntime(): ObjectMenuRuntime {
		return (getBrainstorm() ?? {}) as unknown as ObjectMenuRuntime;
	}

	function boardContext(): ObjectMenuContext {
		const id = state.whiteboard.id;
		if (!id) return null;
		return {
			target: { entityId: id, entityType: WHITEBOARD_TYPE, label: state.whiteboard.name },
			runtime: objectMenuRuntime(),
		};
	}

	function buildEdgeInputs(): EdgeRenderInput[] {
		const byId = new Map(state.whiteboard.nodes.map((n) => [n.id, n] as const));
		const out: EdgeRenderInput[] = [];
		for (const edge of state.edges) {
			const source = byId.get(edge.sourceNodeId);
			const dest = byId.get(edge.destNodeId);
			if (source && dest && !source.hidden && !dest.hidden) out.push({ edge, source, dest });
		}
		return out;
	}

	// ── Canvas surface DOM (the only chrome the engine owns) ──────────────────
	const canvasWrap = document.createElement("div");
	canvasWrap.className = "whiteboard__canvas-wrap";

	const edgeHost = document.createElement("div");
	edgeHost.className = "whiteboard__edge-host";

	const canvas = document.createElement("div");
	canvas.className = "whiteboard__canvas";
	canvas.setAttribute("role", "application");
	canvas.setAttribute("aria-label", t("whiteboard.canvas.aria"));

	const edgeOverlay = document.createElement("div");
	edgeOverlay.className = "whiteboard__edge-overlay";

	const nodeLayer = document.createElement("div");
	nodeLayer.className = "whiteboard__nodes";

	const guideLayer = document.createElement("div");
	guideLayer.className = "whiteboard__guides";

	const presenceLayer = document.createElement("div");
	presenceLayer.className = "whiteboard__presence";
	presenceLayer.setAttribute("aria-hidden", "true");

	const zoomLevel = { textContent: "" } as { textContent: string };

	canvas.append(edgeOverlay, nodeLayer, guideLayer, presenceLayer);
	canvasWrap.append(edgeHost, canvas);
	canvasWrap.dataset.tool = state.tool;
	hosts.canvas.append(canvasWrap);

	const layersPanel: LayersPanelHandle = createLayersPanel({
		t,
		onClose: () => setLayersOpen(false),
		onToggleHidden: (id) => toggleNodeHidden(id),
		onSelectNode: (id) => selectFromLayer(id),
	});
	hosts.layers.append(layersPanel.element);

	const liveRegion: LiveRegionHandle = attachLiveRegion(root, {
		className: "whiteboard__live-region",
	});

	// ── Presence (9.17.19) ────────────────────────────────────────────────────
	// Session-local awareness channel; a real y-protocols `Awareness` bound by
	// the Stage-10 transport satisfies the same structural interface. Remote
	// states arrive via `applyRemoteState` (dev hook / future inbound adapter).
	const awareness = createLocalAwareness();
	const presenceName = localPresenceName();
	let presenceCursor: Point | null = null;
	let presenceCursorTimer: ReturnType<typeof setTimeout> | null = null;

	function publishPresence(): void {
		awareness.setLocalStateField(
			PRESENCE_FIELD,
			buildLocalPresence({
				clientId: awareness.clientID,
				name: presenceName,
				boardId: state.whiteboard.id,
				cursor: presenceCursor,
				selection: state.selectedIds,
			}),
		);
	}

	/** Trailing-coalesced cursor publish (~the broadcaster's OQ-204 cadence) —
	 *  pointermove floods must not fan one awareness change per event. */
	function schedulePresenceCursor(next: Point | null): void {
		presenceCursor = next;
		if (presenceCursorTimer !== null) return;
		presenceCursorTimer = setTimeout(() => {
			presenceCursorTimer = null;
			publishPresence();
		}, 50);
	}

	function currentPeers(): RemotePeer[] {
		return presencePeers(awareness.getStates(), awareness.clientID, state.whiteboard.id);
	}

	function paintPresence(): void {
		const rects = new Map<string, PresenceNodeRect>();
		for (const n of state.whiteboard.nodes) {
			if (!n.hidden) rects.set(n.id, { x: n.x, y: n.y, width: n.width, height: n.height });
		}
		renderPresenceOverlay(presenceLayer, currentPeers(), rects);
	}

	awareness.on("change", paintPresence);

	bindCanvasGestures(canvasWrap);
	bindConnectorAuthoring(canvasWrap);
	bindInkCapture(canvasWrap);
	bindCanvasDoubleClick(canvasWrap);

	const navResize = document.createElement("div");
	navResize.className = "whiteboard__nav-resize";
	navResize.setAttribute("role", "separator");
	navResize.setAttribute("aria-orientation", "vertical");
	navResize.setAttribute("aria-label", t("whiteboard.nav.resize"));
	navResize.tabIndex = 0;
	root.appendChild(navResize);
	attachResizable({
		handle: navResize,
		side: "left",
		defaultWidth: 248,
		min: 200,
		max: 420,
		storageKey: "whiteboard:sidebar-width",
		onWidth: (px) => {
			document.documentElement.style.setProperty("--whiteboard-nav-width", `${px}px`);
		},
	});

	function bootPixi(): void {
		const wrap = canvasWrap;
		void (async () => {
			try {
				pixi = await mountPixiEdges(edgeHost, wrap.clientWidth || 1, wrap.clientHeight || 1);
			} catch (err) {
				console.error("[whiteboard] Pixi edge renderer unavailable", err);
				pixi = null;
				return;
			}
			if (typeof ResizeObserver === "function") {
				resizeObserver = new ResizeObserver(() => {
					if (pixi) resizePixiEdges(pixi, wrap.clientWidth, wrap.clientHeight);
					paint();
				});
				resizeObserver.observe(wrap);
			}
			paint();
		})();
	}

	let paintedHeaderBoardId: string | null = null;

	/** Recompute + write the board (canvas + edge-overlay) extent from the node
	 *  bounds. Split out of `paint()` so the no-rebuild drag frame can keep the
	 *  scroll extent in step without a full node reconcile. */
	function paintBounds(): void {
		let maxX = 0;
		let maxY = 0;
		for (const n of state.whiteboard.nodes) {
			maxX = Math.max(maxX, n.x + n.width);
			maxY = Math.max(maxY, n.y + n.height);
		}
		const boardWidth = maxX + 80;
		const boardHeight = maxY + 80;
		canvas.style.width = `${boardWidth}px`;
		canvas.style.height = `${boardHeight}px`;
		edgeOverlay.style.width = `${boardWidth}px`;
		edgeOverlay.style.height = `${boardHeight}px`;
	}

	function paint(): void {
		paintBounds();
		canvas.style.setProperty("--wb-inv-zoom", String(1 / state.zoom));
		canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
		canvas.style.transformOrigin = "0 0";

		if (state.whiteboard.id !== paintedHeaderBoardId) paintedHeaderBoardId = state.whiteboard.id;
		paintEdges();
		paintNodes(nodeLayer);
		recordCullCamera();

		nodeLayer.dataset.edgeCount = String(state.edges.length);

		zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
		renderLayers();
		// publishPresence emits an awareness change, which repaints the
		// presence overlay against the fresh node rects.
		publishPresence();
		emitChrome();
	}

	// The camera at the last viewport-cull reconcile. When the camera drifts far
	// enough that the padded cull window could have changed the visible set, a
	// pan/zoom re-runs `paintNodes` to mount/unmount the delta — but the common
	// small pan only writes the transform (the 9.17.21 node-DOM-free fast path).
	let culledCamera: { panX: number; panY: number; zoom: number } | null = null;

	function recordCullCamera(): void {
		culledCamera = { panX: state.pan.x, panY: state.pan.y, zoom: state.zoom };
	}

	/** True once the camera has moved enough since the last cull that a near-edge
	 *  node could have crossed the padded viewport boundary. The cull pad is one
	 *  screenful, so half a screenful of drift is the safe re-cull trigger. */
	function cullStale(): boolean {
		if (!culledCamera) return true;
		if (culledCamera.zoom !== state.zoom) return true;
		const dx = Math.abs(state.pan.x - culledCamera.panX);
		const dy = Math.abs(state.pan.y - culledCamera.panY);
		const half = Math.min(canvasWrap.clientWidth, canvasWrap.clientHeight) / 2;
		return dx > half || dy > half;
	}

	function paintCamera(): void {
		canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
		canvas.style.setProperty("--wb-inv-zoom", String(1 / state.zoom));
		zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
		if (cullStale()) {
			paintNodes(nodeLayer);
			recordCullCamera();
		}
		paintEdges();
		positionFormatToolbar();
		emitChrome();
	}

	/** The per-frame paint for an active node / group drag (9.17.20): the node
	 *  elements already exist, so write their new geometry directly and repaint
	 *  the GPU edges + board extent — never the O(total-nodes) `paintNodes`
	 *  teardown. `applyDragDelta` may have moved a whole drag-set / frame's
	 *  members, so every mounted node is re-synced from its model (cheap: style
	 *  writes, no DOM creation). The full `paint()` runs once on pointerup. */
	function paintDragFrame(): void {
		const byId = new Map(state.whiteboard.nodes.map((n) => [n.id, n] as const));
		for (const el of nodeLayer.querySelectorAll<HTMLElement>(".whiteboard__node[data-node-id]")) {
			const id = el.dataset.nodeId;
			const node = id ? byId.get(id) : undefined;
			if (node) applyNodeBox(el, node);
		}
		paintBounds();
		paintEdges();
	}

	function paintEdges(): void {
		if (!pixi) return;
		const conn = state.connector;
		let ghost: { from: Point; to: Point } | null = null;
		if (conn) {
			const source = state.whiteboard.nodes.find((n) => n.id === conn.from.nodeId);
			if (source) {
				ghost = { from: positionForHandle(source, conn.from.side), to: conn.toPoint };
			}
		}
		paintPixiEdges(pixi, {
			camera: { zoom: state.zoom, pan: state.pan },
			edges: buildEdgeInputs().map((input) =>
				input.edge.id === state.editingEdgeId
					? { ...input, edge: { ...input.edge, label: null } }
					: input,
			),
			ghost,
			selectedEdgeId: state.selectedEdgeId,
			inkGhost: state.ink ? state.ink.points : null,
		});
	}

	function nearestEdgeAt(p: Point, tolerance: number): string | null {
		return nearestEdgeId(buildEdgeInputs(), p, tolerance);
	}

	/** Edge double-click resolves geometrically on the wrap (the GPU canvas is
	 *  pointer-inert); a bare-canvas double-click that misses every edge spawns
	 *  a sticky straight into inline edit (F-213 — the dogfood flow "double-
	 *  click, type" previously created nothing, so the typed head fell into the
	 *  window-level S/T/F creation chords). The editor takes focus synchronously
	 *  inside this handler, so every keystroke after the dblclick lands in the
	 *  node. Node dblclicks stop propagation before reaching the wrap. */
	function bindCanvasDoubleClick(wrap: HTMLElement): void {
		wrap.addEventListener("dblclick", (event) => {
			const p = screenToCanvas(event.clientX, event.clientY);
			const tolerance = EDGE_PICK_TOLERANCE_PX / state.zoom;
			const id = nearestEdgeAt(p, tolerance);
			if (id) {
				event.preventDefault();
				beginEditEdgeLabel(id);
				return;
			}
			const target = event.target as HTMLElement | null;
			const bareCanvas =
				event.target === wrap || target?.classList?.contains("whiteboard__canvas") === true;
			if (!bareCanvas) return;
			if (state.tool !== ToolId.Select) return;
			if (editingActive()) return;
			event.preventDefault();
			addNodeAndEdit(createStickyNode(resolveSpawnPoint(p, state.whiteboard.nodes)));
		});
	}

	/** The world rectangle currently on screen (drives viewport culling). */
	function currentWorldViewport(): WorldRect {
		return worldViewport(
			{ panX: state.pan.x, panY: state.pan.y, zoom: state.zoom },
			{ width: canvasWrap.clientWidth, height: canvasWrap.clientHeight },
		);
	}

	/** Padding (world units) around the screen viewport so a small pan doesn't
	 *  pop near-edge nodes in/out; one screenful at the current zoom. */
	function cullPadding(): number {
		return Math.max(canvasWrap.clientWidth, canvasWrap.clientHeight, 1) / state.zoom;
	}

	/** The set of node ids the DOM should mount: those intersecting the padded
	 *  viewport, plus the in-flight inline-edit node (which must never unmount
	 *  out from under the live editor even if it scrolls off-screen). A zero-size
	 *  wrap (jsdom / pre-layout) yields a degenerate viewport, so fall back to
	 *  mounting everything — culling only ever *reduces* work, never hides a
	 *  node that should be reachable. */
	function visibleSet(): Set<string> {
		const w = canvasWrap.clientWidth;
		const h = canvasWrap.clientHeight;
		if (w <= 0 || h <= 0) return new Set(state.whiteboard.nodes.map((n) => n.id));
		const visible = visibleNodeIds(state.whiteboard.nodes, currentWorldViewport(), cullPadding());
		if (state.editingNodeId) visible.add(state.editingNodeId);
		return visible;
	}

	/** Keyed diff reconcile (9.17.20): mount only visible nodes, keep element
	 *  identity (and thus the live editor / embed iframe / focus) for nodes whose
	 *  content signature is unchanged, rebuild only changed nodes, remove the
	 *  gone. Replaces the prior remove-all-then-append-all teardown, so discrete
	 *  repaints touch only what changed and off-screen nodes never mount. */
	function paintNodes(layer: HTMLElement): void {
		const editingId = state.editingNodeId;
		const visible = visibleSet();

		const existing = new Map<string, HTMLElement>();
		for (const child of Array.from(layer.children)) {
			const el = child as HTMLElement;
			const id = el.dataset.nodeId;
			if (id) existing.set(id, el);
			else el.remove();
		}

		// Build/refresh in model order so DOM order (and thus paint order) tracks
		// the node array; appendChild on an existing element just reorders it.
		for (const node of state.whiteboard.nodes) {
			if (node.hidden || !visible.has(node.id)) continue;
			const prev = existing.get(node.id);
			if (prev) {
				existing.delete(node.id);
				// Never re-seed the node under the live editor — the uncommitted
				// DOM text/caret lives on the existing subtree.
				if (node.id === editingId || prev.dataset.contentSig === nodeContentSignature(node)) {
					applyNodeBox(prev, node);
					layer.appendChild(prev);
					continue;
				}
				prev.remove();
			}
			layer.appendChild(renderNode(node));
		}

		// Whatever stayed in `existing` is no longer visible / present — remove
		// it (the editing node was force-included in `visible`, so it survives).
		for (const el of existing.values()) el.remove();

		const liveEmbedIds = new Set(
			state.whiteboard.nodes
				.filter((n) => isEmbedded(n) && !n.hidden && visible.has(n.id))
				.map((n) => n.id),
		);
		embedRegistry.reap(liveEmbedIds);
	}

	/** A stable string of every model field that affects a node's *content*
	 *  (body / classes / vars / aria) — i.e. everything `buildNodeContent` reads.
	 *  Geometry (x/y/width/height/zIndex), selection and lock are excluded: those
	 *  are written in place by {@link applyNodeBox}, so a pure move / select /
	 *  lock keeps the existing subtree (and its live editor / embed / focus).
	 *  When the signature changes the reconcile rebuilds the node fresh. */
	function nodeContentSignature(node: WhiteboardNode): string {
		const { x: _x, y: _y, width: _w, height: _h, zIndex: _z, locked: _l, ...content } = node;
		return JSON.stringify(content);
	}

	/** Write the geometry + selection/lock state onto an existing node element.
	 *  These are the only fields that change without touching content, so the
	 *  keyed reconcile + the no-rebuild drag path both write them in place
	 *  rather than recreating the subtree. */
	function applyNodeBox(el: HTMLElement, node: WhiteboardNode): void {
		el.style.left = `${node.x}px`;
		el.style.top = `${node.y}px`;
		el.style.width = `${node.width}px`;
		el.style.height = `${node.height}px`;
		if (node.zIndex !== undefined) el.style.zIndex = String(node.zIndex);
		else el.style.removeProperty("z-index");
		el.classList.toggle("whiteboard__node--selected", state.selectedIds.has(node.id));
		el.setAttribute("aria-selected", String(state.selectedIds.has(node.id)));
		el.classList.toggle("whiteboard__node--locked", node.locked === true);
	}

	function renderNode(node: WhiteboardNode): HTMLDivElement {
		const el = document.createElement("div");
		el.className = `whiteboard__node whiteboard__node--${node.kind}`;
		el.tabIndex = 0;
		el.dataset.nodeId = node.id;
		el.dataset.contentSig = nodeContentSignature(node);
		applyNodeBox(el, node);

		const content = buildNodeContent(document, node, t);
		for (const cls of content.extraClasses) el.classList.add(cls);
		for (const [prop, value] of Object.entries(content.vars)) el.style.setProperty(prop, value);
		for (const [attr, value] of Object.entries(content.aria)) el.setAttribute(attr, value);
		for (const child of content.children) el.appendChild(child);

		if (isEmbedded(node)) mountEmbed(node, el);

		for (const side of ["top", "right", "bottom", "left"] as const) {
			const handle = document.createElement("span");
			handle.className = `whiteboard__handle whiteboard__handle--${side}`;
			handle.setAttribute("aria-hidden", "true");
			handle.addEventListener("pointerdown", (event) => {
				if (event.button !== 0 || state.readonly) return;
				event.preventDefault();
				event.stopPropagation();
				canvasWrap.setPointerCapture?.(event.pointerId);
				state.connector = {
					pointerId: event.pointerId,
					from: { nodeId: node.id, side: side as HandleSide },
					toPoint: screenToCanvas(event.clientX, event.clientY),
				};
				paint();
			});
			el.appendChild(handle);
		}

		el.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			if (state.editingNodeId === node.id) return;
			event.preventDefault();
			(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
			selectFor(node);
			if (node.locked || state.readonly) {
				applySelectionClasses();
				return;
			}
			state.drag = {
				pointerId: event.pointerId,
				nodeId: node.id,
				offsetX: event.clientX - node.x * state.zoom,
				offsetY: event.clientY - node.y * state.zoom,
				moved: false,
				startX: node.x,
				startY: node.y,
			};
			applySelectionClasses();
		});

		el.addEventListener("pointermove", (event) => {
			if (!state.drag || state.drag.pointerId !== event.pointerId) return;
			if (state.drag.nodeId !== node.id) return;
			const rawX = Math.round((event.clientX - state.drag.offsetX) / state.zoom);
			const rawY = Math.round((event.clientY - state.drag.offsetY) / state.zoom);
			const snap = computeSnap(
				{ x: rawX, y: rawY, width: node.width, height: node.height },
				snapNeighbours(node),
				SNAP_THRESHOLD_PX / state.zoom,
			);
			renderGuides(snap.guides);
			const newX = rawX + snap.dx;
			const newY = rawY + snap.dy;
			const dx = newX - state.drag.startX;
			const dy = newY - state.drag.startY;
			if (dx === 0 && dy === 0) return;
			state.drag.moved = true;
			applyDragDelta(node, dx, dy);
			state.drag.startX = newX;
			state.drag.startY = newY;
			paintDragFrame();
		});

		const endDrag = (event: PointerEvent): void => {
			if (state.drag?.pointerId !== event.pointerId) return;
			const moved = state.drag.moved;
			state.drag = null;
			renderGuides([]);
			if (moved) persistBoard();
		};
		el.addEventListener("pointerup", endDrag);
		el.addEventListener("pointercancel", endDrag);

		el.addEventListener("dblclick", (event) => {
			if (isSticky(node) || isText(node)) {
				event.preventDefault();
				event.stopPropagation();
				beginEdit(node, el);
			}
		});

		el.addEventListener("focus", () => selectFromFocus(node));

		return el;
	}

	function mountEmbed(node: EmbeddedNode, el: HTMLElement): void {
		const runtime = getBrainstorm();
		const controller = embedRegistry.acquire(
			node.id,
			() =>
				EmbedMountController.create({
					entityRef: node.entityRef,
					entityType: node.entityType,
					services: {
						blocks: runtime?.services?.blocks,
						bp: runtime?.services?.bp,
					},
					callbacks: {
						navigate: (entityId, entityType) => void openEntity(runtime ?? {}, { entityId, entityType }),
						resize: (heightPx) => resizeEmbed(node.id, heightPx),
					},
					title: t("whiteboard.node.embedded.aria"),
				}),
			node.entityRef,
		);
		if (controller) el.appendChild(controller.container);
	}

	function resizeEmbed(nodeId: string, heightPx: number): void {
		const node = state.whiteboard.nodes.find((n) => n.id === nodeId);
		if (!node || !isEmbedded(node) || heightPx <= 0) return;
		if (Math.abs(node.height - heightPx) < 1) return;
		node.height = heightPx;
		const el = nodeLayer.querySelector<HTMLElement>(`.whiteboard__node[data-node-id="${nodeId}"]`);
		if (el) el.style.height = `${heightPx}px`;
		scheduleNudgePersist();
	}

	let formatToolbar: FormatToolbarHandle | null = null;
	let formatToolbarNodeId: string | null = null;

	function removeFormatToolbar(): void {
		formatToolbar?.destroy();
		formatToolbar = null;
		formatToolbarNodeId = null;
	}

	/** Pin the toolbar to the screen-space spot above the edited node (the
	 *  toolbar lives in the untransformed wrap so it keeps a constant size). */
	function positionFormatToolbar(): void {
		if (!formatToolbar || !formatToolbarNodeId) return;
		const node = state.whiteboard.nodes.find((n) => n.id === formatToolbarNodeId);
		if (!node) return;
		const left = node.x * state.zoom + state.pan.x;
		const top = node.y * state.zoom + state.pan.y - 40;
		formatToolbar.element.style.left = `${Math.max(4, left)}px`;
		formatToolbar.element.style.top = `${Math.max(4, top)}px`;
	}

	function beginEdit(node: WhiteboardNode, el: HTMLElement): void {
		if (state.readonly) return;
		if (!isSticky(node) && !isText(node)) return;
		// Re-entry (a dblclick landing on the node already mid-edit) would
		// re-seed the editor from the model — wiping the uncommitted DOM text —
		// and stack a second blur/chord listener set on the same body.
		if (state.editingNodeId === node.id) return;
		const body = el.querySelector<HTMLElement>(".whiteboard__node-body");
		if (!body) return;
		state.editingNodeId = node.id;
		const finish = (): void => {
			state.editingNodeId = null;
			removeFormatToolbar();
			paint();
		};
		const editor = beginInlineTextEdit(body, {
			text: node.text,
			rich: node.rich,
			ariaLabel: t("whiteboard.node.editor.aria"),
			onCommit: (next, rich) => {
				const richChanged = !richRunsEqual(
					rich ?? plainToRich(next),
					node.rich ?? plainToRich(node.text),
				);
				if (next !== node.text || richChanged) {
					node.text = next;
					if (rich) node.rich = rich;
					// biome-ignore lint/performance/noDelete: the codec keeps `rich` absent (not undefined) on unstyled nodes; exactOptionalPropertyTypes rejects an undefined assignment
					else delete node.rich;
					state.editingNodeId = null;
					removeFormatToolbar();
					persistBoard();
					paint();
					return;
				}
				finish();
			},
			onCancel: finish,
			onFormatState: (styles) => formatToolbar?.setStyles(styles),
		});
		formatToolbar = createFormatToolbar({ t, editor });
		formatToolbarNodeId = node.id;
		canvasWrap.appendChild(formatToolbar.element);
		positionFormatToolbar();
	}

	function edgeMidpoint(input: EdgeRenderInput): Point {
		const poly = edgePolyline(input);
		return polylineMidpoint(poly);
	}

	function buildEdgeLabelEditor(edge: WhiteboardEdge, mid: Point): HTMLInputElement {
		const input = document.createElement("input");
		input.type = "text";
		input.className = "whiteboard__edge-label-input";
		input.value = edge.label ?? "";
		input.setAttribute("aria-label", t("whiteboard.edge.label.aria"));
		input.placeholder = t("whiteboard.edge.label.placeholder");
		const width = Math.max(96, (edge.label?.length ?? 0) * 8 + 24);
		const height = 26;
		input.style.left = `${mid.x - width / 2}px`;
		input.style.top = `${mid.y - height / 2}px`;
		input.style.width = `${width}px`;
		input.style.height = `${height}px`;
		return input;
	}

	function beginEditEdgeLabel(edgeId: string): void {
		if (state.editingEdgeId === edgeId) return;
		const edge = state.edges.find((e) => e.id === edgeId);
		if (!edge) return;
		const renderInput = buildEdgeInputs().find((i) => i.edge.id === edgeId);
		if (!renderInput) return;
		state.editingEdgeId = edgeId;

		const input = buildEdgeLabelEditor(edge, edgeMidpoint(renderInput));
		edgeOverlay.replaceChildren(input);
		paint();
		input.focus();
		input.select();

		const teardown = (): void => {
			edgeOverlay.replaceChildren();
		};

		let done = false;
		const finish = (commit: boolean): void => {
			if (done) return;
			done = true;
			state.editingEdgeId = null;
			if (commit) {
				const next = input.value.trim();
				const value = next.length > 0 ? next : null;
				if (value !== edge.label) {
					edge.label = value;
					edge.updatedAt = Date.now();
					if (state.repository) void state.repository.saveEdge(edge);
					recordHistory();
				}
			}
			offCommit();
			offCancel();
			teardown();
			paint();
		};
		input.addEventListener("blur", () => finish(true));
		const offCommit = bindShortcut(
			ActionId.CommitEdit,
			(e) => {
				e.preventDefault();
				finish(true);
			},
			{ target: input, allowInTyping: true },
		);
		const offCancel = bindShortcut(
			ActionId.CancelEdit,
			(e) => {
				e.preventDefault();
				finish(false);
			},
			{ target: input, allowInTyping: true },
		);
	}

	function selectFor(node: WhiteboardNode): void {
		const set = resolveDragSet(node, state.whiteboard.nodes);
		state.selectedIds = new Set(set);
		if (isGroup(node)) state.selectedIds.add(node.id);
		if (state.selectedEdgeId) {
			state.selectedEdgeId = null;
			paintEdges();
		}
	}

	function selectEdge(id: string): void {
		state.selectedEdgeId = id;
		if (state.selectedIds.size > 0) state.selectedIds = new Set();
		applySelectionClasses();
		paint();
	}

	function clearSelection(): void {
		const had = state.selectedIds.size > 0 || state.selectedEdgeId !== null;
		state.selectedIds = new Set();
		state.selectedEdgeId = null;
		if (had) {
			applySelectionClasses();
			paint();
		}
	}

	function snapNeighbours(node: WhiteboardNode): SnapRect[] {
		const all = state.whiteboard.nodes;
		const moving = new Set<string>(resolveDragSet(node, all));
		moving.add(node.id);
		if (isFrame(node)) for (const c of nodesWithinFrame(node, all)) moving.add(c.id);
		return all
			.filter((n) => !moving.has(n.id) && !n.hidden)
			.map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }));
	}

	function renderGuides(guides: readonly SnapGuide[]): void {
		const layer = guideLayer;
		if (guides.length === 0) {
			if (layer.childElementCount) layer.replaceChildren();
			return;
		}
		const thickness = 1 / state.zoom;
		const els = guides.map((g) => {
			const line = document.createElement("div");
			line.className = "whiteboard__guide";
			if (g.axis === SnapAxis.Vertical) {
				line.style.left = `${g.pos}px`;
				line.style.top = `${g.from}px`;
				line.style.width = `${thickness}px`;
				line.style.height = `${g.to - g.from}px`;
			} else {
				line.style.left = `${g.from}px`;
				line.style.top = `${g.pos}px`;
				line.style.width = `${g.to - g.from}px`;
				line.style.height = `${thickness}px`;
			}
			return line;
		});
		layer.replaceChildren(...els);
	}

	function bindCanvasGestures(wrap: HTMLElement): void {
		wrap.addEventListener("pointermove", (event) => {
			pointerClient = { x: event.clientX, y: event.clientY };
			schedulePresenceCursor(screenToCanvas(event.clientX, event.clientY));
		});
		wrap.addEventListener("pointerleave", () => {
			pointerClient = null;
			schedulePresenceCursor(null);
		});

		wrap.addEventListener(
			"wheel",
			(event) => {
				event.preventDefault();
				if (event.ctrlKey) {
					const factor = Math.exp(-event.deltaY * 0.01);
					zoomAt(event.clientX, event.clientY, state.zoom * factor);
					return;
				}
				state.pan = {
					x: state.pan.x - event.deltaX,
					y: state.pan.y - event.deltaY,
				};
				paintCamera();
			},
			{ passive: false },
		);

		let panDrag: {
			pointerId: number;
			startX: number;
			startY: number;
			startPan: { x: number; y: number };
		} | null = null;

		wrap.addEventListener("pointerdown", (event) => {
			if (
				event.target !== wrap &&
				!(event.target as HTMLElement | null)?.classList?.contains("whiteboard__canvas")
			) {
				return;
			}
			if (event.button === 1 || (event.button === 0 && event.shiftKey)) {
				event.preventDefault();
				wrap.setPointerCapture(event.pointerId);
				wrap.classList.add("whiteboard__canvas-wrap--panning");
				panDrag = {
					pointerId: event.pointerId,
					startX: event.clientX,
					startY: event.clientY,
					startPan: { ...state.pan },
				};
				return;
			}
			if (event.button !== 0) return;
			// Read-only board: pan + selection stay, but no creation (Pen, sticky,
			// text, …). The Select tool's marquee/edge-pick below is selection-only.
			if (state.readonly && state.tool !== ToolId.Select) return;
			if (state.tool === ToolId.Pen) {
				event.preventDefault();
				wrap.setPointerCapture(event.pointerId);
				state.ink = {
					pointerId: event.pointerId,
					points: [screenToCanvas(event.clientX, event.clientY)],
				};
				return;
			}
			if (state.tool !== ToolId.Select) {
				event.preventDefault();
				placeToolAt(state.tool, screenToCanvas(event.clientX, event.clientY));
				setTool(ToolId.Select);
				return;
			}
			const p = screenToCanvas(event.clientX, event.clientY);
			const hitEdge = nearestEdgeAt(p, EDGE_PICK_TOLERANCE_PX / state.zoom);
			if (hitEdge) {
				selectEdge(hitEdge);
				return;
			}
			clearSelection();
		});

		wrap.addEventListener("pointermove", (event) => {
			if (!panDrag || panDrag.pointerId !== event.pointerId) return;
			state.pan = {
				x: panDrag.startPan.x + (event.clientX - panDrag.startX),
				y: panDrag.startPan.y + (event.clientY - panDrag.startY),
			};
			paintCamera();
		});

		const endPan = (event: PointerEvent): void => {
			if (!panDrag || panDrag.pointerId !== event.pointerId) return;
			panDrag = null;
			wrap.classList.remove("whiteboard__canvas-wrap--panning");
		};
		wrap.addEventListener("pointerup", endPan);
		wrap.addEventListener("pointercancel", endPan);
	}

	function zoomAt(screenX: number, screenY: number, nextZoom: number): void {
		const wrap = canvasWrap;
		const rect = wrap.getBoundingClientRect();
		const localX = screenX - rect.left;
		const localY = screenY - rect.top;
		const clamped = Math.max(0.25, Math.min(3, nextZoom));
		if (clamped === state.zoom) return;
		const cx = (localX - state.pan.x) / state.zoom;
		const cy = (localY - state.pan.y) / state.zoom;
		state.zoom = clamped;
		state.pan = {
			x: localX - cx * clamped,
			y: localY - cy * clamped,
		};
		paintCamera();
	}

	function screenToCanvas(clientX: number, clientY: number): Point {
		const rect = canvasWrap.getBoundingClientRect();
		return {
			x: (clientX - rect.left - state.pan.x) / state.zoom,
			y: (clientY - rect.top - state.pan.y) / state.zoom,
		};
	}

	function nodeAtCanvasPoint(p: Point): WhiteboardNode | null {
		let hit: WhiteboardNode | null = null;
		for (const n of state.whiteboard.nodes) {
			if (p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height) {
				hit = n;
			}
		}
		return hit;
	}

	function bindConnectorAuthoring(wrap: HTMLElement): void {
		wrap.addEventListener("pointermove", (event) => {
			const conn = state.connector;
			if (!conn || conn.pointerId !== event.pointerId) return;
			conn.toPoint = screenToCanvas(event.clientX, event.clientY);
			// Authoring only moves the ghost connector — repaint the GPU edges,
			// not the (unchanged) node DOM.
			paintEdges();
		});

		const finish = (event: PointerEvent): void => {
			const conn = state.connector;
			if (!conn || conn.pointerId !== event.pointerId) return;
			state.connector = null;
			const target = nodeAtCanvasPoint(screenToCanvas(event.clientX, event.clientY));
			if (target && isValidConnectorDrop(conn.from, target.id, state.edges)) {
				const toSide = nearestHandleSide(target, conn.toPoint);
				const edge = buildConnectorEdge({
					whiteboardId: state.whiteboard.id,
					from: conn.from,
					to: { nodeId: target.id, side: toSide },
					now: Date.now(),
				});
				state.edges.push(edge);
				state.allEdges.push(edge);
				if (state.repository) {
					state.whiteboard.updatedAt = Date.now();
					void state.repository.saveEdge(edge);
				}
				recordHistory();
			}
			paint();
		};
		wrap.addEventListener("pointerup", finish);
		wrap.addEventListener("pointercancel", finish);
	}

	function bindInkCapture(wrap: HTMLElement): void {
		wrap.addEventListener("pointermove", (event) => {
			const ink = state.ink;
			if (!ink || ink.pointerId !== event.pointerId) return;
			ink.points.push(screenToCanvas(event.clientX, event.clientY));
			paintEdges();
		});

		const finish = (event: PointerEvent): void => {
			const ink = state.ink;
			if (!ink || ink.pointerId !== event.pointerId) return;
			state.ink = null;
			const geometry = buildInkGeometry(ink.points);
			if (geometry) {
				addNode(createInkNode(geometry));
			} else {
				paint();
			}
			setTool(ToolId.Select);
		};
		wrap.addEventListener("pointerup", finish);
		wrap.addEventListener("pointercancel", finish);
	}

	function applyDragDelta(node: WhiteboardNode, dx: number, dy: number): void {
		const all = state.whiteboard.nodes;
		const deltas = isFrame(node)
			? frameMoveDelta(node, dx, dy, all)
			: translateNodes(resolveDragSet(node, all), dx, dy, all);
		const byId = new Map(all.map((n) => [n.id, n] as const));
		for (const [id, pos] of deltas) {
			const target = byId.get(id);
			if (!target) continue;
			target.x = pos.x;
			target.y = pos.y;
		}
	}

	type WhiteboardSnapshot = { whiteboard: Whiteboard; edges: WhiteboardEdge[] };

	let boardHistory: HistoryState<WhiteboardSnapshot> = initialHistory({
		whiteboard: { id: "", name: "", nodes: [], createdAt: 0, updatedAt: 0 },
		edges: [],
	});
	let restoringHistory = false;

	function currentSnapshot(): WhiteboardSnapshot {
		return {
			whiteboard: structuredClone(state.whiteboard),
			edges: structuredClone(state.edges),
		};
	}

	function resetHistory(): void {
		boardHistory = initialHistory(currentSnapshot());
	}

	function recordHistory(): void {
		if (restoringHistory) return;
		boardHistory = pushHistory(boardHistory, currentSnapshot());
	}

	function persistBoard(): void {
		if (!state.repository) return;
		state.whiteboard.updatedAt = Date.now();
		void state.repository.saveWhiteboard(state.whiteboard);
		recordHistory();
	}

	function scheduleNudgePersist(): void {
		if (nudgePersistTimer !== null) clearTimeout(nudgePersistTimer);
		nudgePersistTimer = setTimeout(() => {
			nudgePersistTimer = null;
			persistBoard();
		}, 200);
	}

	function restoreSnapshot(snap: WhiteboardSnapshot): void {
		restoringHistory = true;
		const prevEdges = state.edges;
		state.whiteboard = structuredClone(snap.whiteboard);
		const wi = state.allWhiteboards.findIndex((w) => w.id === state.whiteboard.id);
		if (wi >= 0) state.allWhiteboards[wi] = state.whiteboard;
		state.edges = structuredClone(snap.edges);
		state.allEdges = [
			...state.allEdges.filter((e) => e.whiteboardId !== state.whiteboard.id),
			...state.edges,
		];
		state.selectedIds = new Set();
		state.editingNodeId = null;
		state.editingEdgeId = null;
		state.selectedEdgeId = null;
		if (state.repository) {
			void state.repository.saveWhiteboard(state.whiteboard);
			const restoredIds = new Set(state.edges.map((e) => e.id));
			for (const edge of state.edges) void state.repository.saveEdge(edge);
			for (const edge of prevEdges) {
				if (!restoredIds.has(edge.id)) void state.repository.removeEdge(edge.id);
			}
		}
		paint();
		restoringHistory = false;
	}

	function undoBoard(): void {
		const step = undoHistory(boardHistory);
		if (!step) return;
		boardHistory = step.history;
		restoreSnapshot(step.present);
	}

	function redoBoard(): void {
		const step = redoHistory(boardHistory);
		if (!step) return;
		boardHistory = step.history;
		restoreSnapshot(step.present);
	}

	function viewportCenter(): CanvasPoint {
		const rect = canvasWrap.getBoundingClientRect();
		return screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
	}

	function spawnPoint(): CanvasPoint {
		const preferred = pointerClient
			? screenToCanvas(pointerClient.x, pointerClient.y)
			: viewportCenter();
		return resolveSpawnPoint(preferred, state.whiteboard.nodes);
	}

	function addNode(node: WhiteboardNode): void {
		state.whiteboard.nodes.push(node);
		state.selectedIds = new Set([node.id]);
		persistBoard();
		paint();
		const el = nodeLayer.querySelector<HTMLElement>(`.whiteboard__node[data-node-id="${node.id}"]`);
		el?.focus();
	}

	function addNodeAndEdit(node: WhiteboardNode): void {
		addNode(node);
		const el = nodeLayer.querySelector<HTMLElement>(`.whiteboard__node[data-node-id="${node.id}"]`);
		if (el) beginEdit(node, el);
	}

	function createSticky(): void {
		addNodeAndEdit(createStickyNode(spawnPoint()));
	}
	function createText(): void {
		addNodeAndEdit(createTextNode(spawnPoint()));
	}
	function createFrame(): void {
		addNode(createFrameNode(spawnPoint()));
	}
	function createShape(shape: ShapeKind): void {
		addNode(createShapeNode(spawnPoint(), shape));
	}
	function createRectangle(): void {
		createShape(ShapeKind.Rectangle);
	}
	function createEllipse(): void {
		createShape(ShapeKind.Ellipse);
	}

	async function placeImageFromFile(): Promise<void> {
		const files = getBrainstorm()?.services?.files;
		if (!files) return;
		const result = await pickImage(files, { title: t("whiteboard.add.imageDialogTitle") });
		const at = resolveSpawnPoint(viewportCenter(), state.whiteboard.nodes);
		switch (result.kind) {
			case PickImageKind.Picked:
				addNode(createImageNode(at, result.dataUrl));
				return;
			case PickImageKind.Cancelled:
				return;
			case PickImageKind.Unsupported:
				console.warn(`[whiteboard/image] unsupported file type: ${result.extension}`);
				return;
			case PickImageKind.TooLarge:
				console.warn(
					`[whiteboard/image] ${result.filename} is ${result.bytes} bytes (limit ${result.limit}) — not inlined`,
				);
				return;
			case PickImageKind.Failed:
				console.warn(`[whiteboard/image] read failed for ${result.filename}:`, result.error);
				return;
		}
	}

	async function pickEntityToEmbed(anchor: HTMLElement): Promise<void> {
		const vault = getBrainstorm()?.services?.vaultEntities;
		if (!vault) return;
		let snap: Awaited<ReturnType<typeof vault.list>>;
		try {
			snap = await vault.list();
		} catch (error) {
			console.warn("[whiteboard/embed] vaultEntities.list failed:", error);
			return;
		}
		const candidates = embedCandidates(snap.entities, state.whiteboard.id);
		if (candidates.length === 0) return;
		const rows: AnchoredMenuItem[] = candidates.map((c) => ({
			label: c.label,
			onSelect: () => embedEntity(c.id, c.type),
		}));
		const r = anchor.getBoundingClientRect();
		openAnchoredMenu({ x: r.left, y: r.bottom + 4 }, rows, {
			menuLabel: t("whiteboard.add.embed"),
			anchor,
		});
	}

	function embedEntity(entityId: string, entityType: string): void {
		addNode(createEmbeddedNode(viewportCenter(), formatBrainstormEntityUri(entityId), entityType));
	}

	function placeToolAt(tool: ToolId, at: CanvasPoint): void {
		const p = resolveSpawnPoint(at, state.whiteboard.nodes);
		switch (tool) {
			case ToolId.Sticky:
				addNodeAndEdit(createStickyNode(p));
				return;
			case ToolId.Text:
				addNodeAndEdit(createTextNode(p));
				return;
			case ToolId.Frame:
				addNode(createFrameNode(p));
				return;
			case ToolId.Pen:
				return;
			case ToolId.Select:
				return;
		}
	}

	function createGroupFromSelection(): void {
		const ids = [...state.selectedIds].filter((id) =>
			state.whiteboard.nodes.some((n) => n.id === id && !isGroup(n) && !isFrame(n)),
		);
		if (ids.length < 2) return;
		const group = createGroupNode(ids);
		const bounds = groupBounds(group, state.whiteboard.nodes);
		if (bounds) {
			group.x = bounds.x;
			group.y = bounds.y;
			group.width = bounds.width;
			group.height = bounds.height;
		}
		addNode(group);
	}

	function ungroupSelection(): void {
		const groups = state.whiteboard.nodes.filter((n) => state.selectedIds.has(n.id) && isGroup(n));
		if (groups.length === 0) return;
		const removed = new Set(groups.map((g) => g.id));
		state.whiteboard.nodes = state.whiteboard.nodes.filter((n) => !removed.has(n.id));
		state.selectedIds = new Set();
		persistBoard();
		paint();
	}

	function deleteSelection(): void {
		if (state.selectedEdgeId) {
			deleteSelectedEdge();
			return;
		}
		if (state.selectedIds.size === 0) return;
		const removed = state.selectedIds;
		state.whiteboard.nodes = state.whiteboard.nodes.filter((n) => !removed.has(n.id));
		const attached = (e: { sourceNodeId: string; destNodeId: string }) =>
			removed.has(e.sourceNodeId) || removed.has(e.destNodeId);
		for (const edge of state.allEdges.filter(attached)) {
			if (state.repository) void state.repository.removeEdge(edge.id);
		}
		state.edges = state.edges.filter((e) => !attached(e));
		state.allEdges = state.allEdges.filter((e) => !attached(e));
		const count = removed.size;
		state.selectedIds = new Set();
		persistBoard();
		paint();
		liveRegion.announce(
			pluralWith(t, count, "whiteboard.a11y.deleted.one", "whiteboard.a11y.deleted.other"),
		);
	}

	function deleteSelectedEdge(): void {
		const id = state.selectedEdgeId;
		if (!id) return;
		state.selectedEdgeId = null;
		state.edges = state.edges.filter((e) => e.id !== id);
		state.allEdges = state.allEdges.filter((e) => e.id !== id);
		if (state.repository) void state.repository.removeEdge(id);
		recordHistory();
		paint();
	}

	function nudgeSelection(dx: number, dy: number): void {
		if (state.selectedIds.size === 0) return;
		const moves = translateNodes(state.selectedIds, dx, dy, state.whiteboard.nodes);
		const byId = new Map(state.whiteboard.nodes.map((n) => [n.id, n] as const));
		for (const [id, pos] of moves) {
			const target = byId.get(id);
			if (!target) continue;
			target.x = pos.x;
			target.y = pos.y;
		}
		scheduleNudgePersist();
		paint();
		focusSelectedNode();
		announceSelection();
	}

	function selectedAlignRects(): AlignRect[] {
		const byId = new Map(state.whiteboard.nodes.map((n) => [n.id, n] as const));
		const rects: AlignRect[] = [];
		for (const id of state.selectedIds) {
			const n = byId.get(id);
			if (n) rects.push({ id, x: n.x, y: n.y, width: n.width, height: n.height });
		}
		return rects;
	}

	function applySelectionPositions(positions: Positions): void {
		const all = state.whiteboard.nodes;
		const byId = new Map(all.map((n) => [n.id, n] as const));
		const deltas: Array<{ ids: ReadonlySet<string>; dx: number; dy: number }> = [];
		for (const [id, pos] of positions) {
			const node = byId.get(id);
			if (!node) continue;
			const dx = pos.x - node.x;
			const dy = pos.y - node.y;
			if (dx === 0 && dy === 0) continue;
			deltas.push({ ids: resolveDragSet(node, all), dx, dy });
		}
		const moved = new Set<string>();
		for (const { ids, dx, dy } of deltas) {
			for (const mid of ids) {
				if (moved.has(mid)) continue;
				const m = byId.get(mid);
				if (!m) continue;
				m.x += dx;
				m.y += dy;
				moved.add(mid);
			}
		}
		if (moved.size > 0) {
			persistBoard();
			paint();
		}
	}

	function alignSelection(kind: AlignKind): void {
		if (state.selectedIds.size < 2) return;
		applySelectionPositions(alignRects(selectedAlignRects(), kind));
	}

	function distributeSelection(axis: DistributeAxis): void {
		if (state.selectedIds.size < 3) return;
		applySelectionPositions(distributeRects(selectedAlignRects(), axis));
	}

	function applyZOrder(op: ZOrderOp): void {
		if (state.selectedIds.size === 0) return;
		const next = computeZOrder(state.whiteboard.nodes, state.selectedIds, op);
		if (next.size === 0) return;
		let changed = false;
		for (const node of state.whiteboard.nodes) {
			const z = next.get(node.id);
			if (z !== undefined && node.zIndex !== z) {
				node.zIndex = z;
				changed = true;
			}
		}
		if (changed) {
			persistBoard();
			paint();
		}
	}

	function setSelectionLocked(locked: boolean): void {
		if (state.selectedIds.size === 0) return;
		let changed = false;
		for (const node of state.whiteboard.nodes) {
			if (!state.selectedIds.has(node.id)) continue;
			if ((node.locked ?? false) !== locked) {
				node.locked = locked;
				changed = true;
			}
		}
		if (changed) {
			persistBoard();
			paint();
		}
	}

	function setReadonly(readonly: boolean): void {
		if (state.readonly === readonly) return;
		state.readonly = readonly;
		// Drop any active text edit / in-flight gesture so the surface freezes.
		if (readonly) {
			state.editingNodeId = null;
			state.drag = null;
			state.connector = null;
			state.ink = null;
		}
		paint();
	}

	function setSelectionTextSize(size: TextSize): void {
		if (!hasStyleableText(state.whiteboard.nodes, state.selectedIds)) return;
		state.whiteboard.nodes = setTextSizeFor(state.whiteboard.nodes, state.selectedIds, size);
		persistBoard();
		paint();
	}

	function setSelectionStickyFill(color: StickyColor): void {
		if (!hasSticky(state.whiteboard.nodes, state.selectedIds)) return;
		state.whiteboard.nodes = setStickyFillFor(state.whiteboard.nodes, state.selectedIds, color);
		persistBoard();
		paint();
	}

	function setSelectionTextColor(color: TextColor): void {
		if (!hasStyleableText(state.whiteboard.nodes, state.selectedIds)) return;
		state.whiteboard.nodes = setTextColorFor(state.whiteboard.nodes, state.selectedIds, color);
		persistBoard();
		paint();
	}

	function setSelectionFontFamily(font: FontFamily): void {
		if (!hasStyleableText(state.whiteboard.nodes, state.selectedIds)) return;
		state.whiteboard.nodes = setFontFamilyFor(state.whiteboard.nodes, state.selectedIds, font);
		persistBoard();
		paint();
	}

	function toggleSelectionBold(): void {
		if (!hasStyleableText(state.whiteboard.nodes, state.selectedIds)) return;
		const next = !selectionBold(state.whiteboard.nodes, state.selectedIds);
		state.whiteboard.nodes = setBoldFor(state.whiteboard.nodes, state.selectedIds, next);
		persistBoard();
		paint();
	}

	function toggleSelectionItalic(): void {
		if (!hasStyleableText(state.whiteboard.nodes, state.selectedIds)) return;
		const next = !selectionItalic(state.whiteboard.nodes, state.selectedIds);
		state.whiteboard.nodes = setItalicFor(state.whiteboard.nodes, state.selectedIds, next);
		persistBoard();
		paint();
	}

	function applyEdgeStyle(
		transform: (edges: readonly WhiteboardEdge[], id: string, now: number) => WhiteboardEdge[],
	): void {
		const id = state.selectedEdgeId;
		if (!id) return;
		const now = Date.now();
		const next = transform(state.edges, id, now);
		if (next === state.edges) return;
		state.edges = next;
		state.allEdges = [
			...state.allEdges.filter((e) => e.whiteboardId !== state.whiteboard.id),
			...state.edges,
		];
		const edge = state.edges.find((e) => e.id === id);
		if (edge && state.repository) {
			state.whiteboard.updatedAt = now;
			void state.repository.saveEdge(edge);
		}
		recordHistory();
		paint();
	}

	function buildConnectorStyleItems(): AnchoredMenuItem[] {
		const edge = state.edges.find((e) => e.id === state.selectedEdgeId);
		if (!edge) return [];
		const mark = (on: boolean): Pick<AnchoredMenuItem, "icon"> =>
			on ? { icon: IconName.CheckCircle } : {};
		const items: AnchoredMenuItem[] = [];

		for (const kind of EDGE_PATH_KINDS) {
			items.push({
				label: t(`whiteboard.connector.routing.${kind}`),
				...mark(edge.pathKind === kind),
				onSelect: () => applyEdgeStyle((edges, id, now) => setEdgePathKind(edges, id, kind, now)),
			});
		}
		for (const head of ARROW_HEADS) {
			items.push({
				label: t(`whiteboard.connector.arrow.${head}`),
				...mark(edge.arrowHead === head),
				onSelect: () => applyEdgeStyle((edges, id, now) => setEdgeArrowHead(edges, id, head, now)),
			});
		}
		const bi = isBidirectional(edge);
		items.push({
			label: t("whiteboard.connector.bidirectional"),
			...mark(bi),
			onSelect: () => applyEdgeStyle((edges, id, now) => setEdgeBidirectional(edges, id, !bi, now)),
		});
		const dashed = edge.dashed === true;
		items.push({
			label: t("whiteboard.connector.dashed"),
			...mark(dashed),
			onSelect: () => applyEdgeStyle((edges, id, now) => setEdgeDashed(edges, id, !dashed, now)),
		});
		const currentColor = edgeColorFromCss(edge.colorHint);
		for (const color of EDGE_COLORS) {
			items.push({
				label: t(`whiteboard.connector.color.${color}`),
				...mark(currentColor === color),
				onSelect: () => applyEdgeStyle((edges, id, now) => setEdgeColor(edges, id, color, now)),
			});
		}
		return items;
	}

	function edgeColorFromCss(css: string | null): EdgeColor {
		if (css == null) return EdgeColor.Default;
		const match = EDGE_COLORS.find((c) => edgeColorToCss(c) === css);
		return match ?? EdgeColor.Default;
	}

	function styleMenuItems(): AnchoredMenuItem[] {
		if (!hasStyleTarget(state.selectedIds, state.selectedEdgeId)) return [];
		return state.selectedEdgeId
			? buildConnectorStyleItems()
			: buildNodeStyleItems(state.whiteboard.nodes, state.selectedIds, t, {
					setTextSize: setSelectionTextSize,
					setStickyFill: setSelectionStickyFill,
					setTextColor: setSelectionTextColor,
					setFontFamily: setSelectionFontFamily,
					toggleBold: toggleSelectionBold,
					toggleItalic: toggleSelectionItalic,
				});
	}

	function setLayersOpen(open: boolean): void {
		layersPanel.setOpen(open);
		renderLayers();
		emitChrome();
	}

	function renderLayers(): void {
		layersPanel.renderRows(buildLayerList(state.whiteboard.nodes), state.selectedIds);
	}

	function toggleNodeHidden(id: string): void {
		const node = state.whiteboard.nodes.find((n) => n.id === id);
		if (!node) return;
		node.hidden = !(node.hidden ?? false);
		persistBoard();
		paint();
	}

	function selectFromLayer(id: string): void {
		state.selectedIds = new Set([id]);
		applySelectionClasses();
		renderLayers();
	}

	function selectAll(): void {
		state.selectedIds = new Set(state.whiteboard.nodes.map((n) => n.id));
		paint();
		announceSelection();
	}

	function setTool(next: ToolId): void {
		if (state.tool === next) return;
		state.tool = next;
		canvasWrap.dataset.tool = next;
		emitChrome();
	}

	const NODE_KIND_LABEL: Record<NodeKind, WhiteboardMessageKey> = {
		[NodeKind.Sticky]: "whiteboard.a11y.kind.sticky",
		[NodeKind.Text]: "whiteboard.a11y.kind.text",
		[NodeKind.Image]: "whiteboard.a11y.kind.image",
		[NodeKind.Embedded]: "whiteboard.a11y.kind.embedded",
		[NodeKind.Frame]: "whiteboard.a11y.kind.frame",
		[NodeKind.Group]: "whiteboard.a11y.kind.group",
		[NodeKind.Shape]: "whiteboard.a11y.kind.shape",
		[NodeKind.Ink]: "whiteboard.a11y.kind.ink",
	};

	function applySelectionClasses(): void {
		const els = nodeLayer.querySelectorAll<HTMLElement>(".whiteboard__node[data-node-id]");
		for (const el of els) {
			const id = el.dataset.nodeId;
			if (!id) continue;
			const selected = state.selectedIds.has(id);
			el.classList.toggle("whiteboard__node--selected", selected);
			el.setAttribute("aria-selected", String(selected));
		}
		publishPresence();
		emitChrome();
	}

	function announceSelection(): void {
		const summary = selectionSummary(state.whiteboard.nodes, state.selectedIds);
		let message = "";
		if (summary.kind === "single") {
			const name = summary.label || t(NODE_KIND_LABEL[summary.nodeKind]);
			message = t("whiteboard.a11y.selected", { name, x: summary.x, y: summary.y });
		} else if (summary.kind === "multi") {
			message = t("whiteboard.a11y.selectedMany", { count: summary.count });
		}
		liveRegion.announce(message);
	}

	function focusSelectedNode(): void {
		const id = firstSelectedId();
		if (!id) return;
		const el = nodeLayer.querySelector<HTMLElement>(`.whiteboard__node[data-node-id="${id}"]`);
		el?.focus({ preventScroll: true });
	}

	function selectFromFocus(node: WhiteboardNode): void {
		if (state.editingNodeId !== null) return;
		if (!shouldSelectOnFocus(state.selectedIds, node.id)) return;
		selectFor(node);
		applySelectionClasses();
		announceSelection();
	}

	function exportText(format: WhiteboardExportFormat): string {
		return exportWhiteboard(state.whiteboard, state.edges, format);
	}

	type FilesService = NonNullable<
		NonNullable<ReturnType<typeof getBrainstorm>>["services"]
	>["files"];

	async function saveBoardAsFile(row: SaveRow): Promise<SaveDisposition> {
		const files = getBrainstorm()?.services?.files as NonNullable<FilesService> | undefined;
		if (!files) return { kind: SaveDispositionKind.Cancelled };
		const suggestedName = suggestedFilename(state.whiteboard.name, row.extension, {
			defaultStem: "board",
		});
		const result = await requestSaveBytes(files, {
			title: t("whiteboard.export.saveDialogTitle"),
			suggestedName,
			filters: [{ name: row.filterName, extensions: [row.extension] }],
			encode: row.encode,
		});
		switch (result.kind) {
			case SaveDispositionKind.Saved:
				return { kind: SaveDispositionKind.Saved };
			case SaveDispositionKind.Cancelled:
				return { kind: SaveDispositionKind.Cancelled };
			case SaveDispositionKind.Failed:
				console.warn(`[whiteboard/export] save failed for ${row.extension}:`, result.error);
				return { kind: SaveDispositionKind.Failed, error: result.error };
		}
	}

	/** An inline node edit or edge-label edit owns the keyboard. The editors
	 *  are focused synchronously on spawn, so `isTypingTarget` normally guards
	 *  the window-level chords — this state check is the fail-closed half for
	 *  the handoff window where the edit exists but focus is (still or again)
	 *  elsewhere: a bare S/T/F must never spawn a stray node mid-edit (F-213). */
	function editingActive(): boolean {
		return state.editingNodeId !== null || state.editingEdgeId !== null;
	}

	function unlessEditing(fn: () => void): () => void {
		return () => {
			if (editingActive()) return;
			fn();
		};
	}

	// A locked board rejects every mutation, keyboard included — the disabled
	// header menus only cover the pointer path (per setReadonly's contract).
	function unlessReadonly(fn: () => void): () => void {
		return () => {
			if (state.readonly) return;
			fn();
		};
	}

	function bindShortcuts(): void {
		const off = (fn: () => void): void => {
			unbinders.push(fn);
		};
		off(bindShortcut(ActionId.CreateSticky, unlessReadonly(unlessEditing(createSticky))));
		off(bindShortcut(ActionId.CreateText, unlessReadonly(unlessEditing(createText))));
		off(bindShortcut(ActionId.CreateFrame, unlessReadonly(unlessEditing(createFrame))));
		off(bindShortcut(ActionId.CreateGroup, unlessReadonly(createGroupFromSelection)));
		off(bindShortcut(ActionId.Ungroup, unlessReadonly(ungroupSelection)));
		off(bindShortcut(ActionId.DeleteNode, unlessReadonly(deleteSelection)));
		off(bindShortcut(ActionId.DuplicateNode, unlessReadonly(duplicateSelection)));
		off(bindShortcut(ActionId.SelectAll, selectAll));
		off(bindShortcut(ActionId.Undo, unlessReadonly(undoBoard)));
		off(bindShortcut(ActionId.Redo, unlessReadonly(redoBoard)));
		off(bindShortcut(ActionId.ToggleBold, unlessReadonly(toggleSelectionBold)));
		off(bindShortcut(ActionId.ToggleItalic, unlessReadonly(toggleSelectionItalic)));
		off(
			bindShortcut(ActionId.ClearSelection, () => {
				if (state.editingNodeId !== null) return;
				if (state.selectedIds.size === 0) return;
				state.selectedIds = new Set();
				paint();
				liveRegion.announce(t("whiteboard.a11y.cleared"));
			}),
		);
		off(
			bindShortcut(
				ActionId.NudgeUp,
				unlessReadonly(() => nudgeSelection(0, -1)),
			),
		);
		off(
			bindShortcut(
				ActionId.NudgeDown,
				unlessReadonly(() => nudgeSelection(0, 1)),
			),
		);
		off(
			bindShortcut(
				ActionId.NudgeLeft,
				unlessReadonly(() => nudgeSelection(-1, 0)),
			),
		);
		off(
			bindShortcut(
				ActionId.NudgeRight,
				unlessReadonly(() => nudgeSelection(1, 0)),
			),
		);
		off(
			bindShortcut(ActionId.EditNode, () => {
				const id = firstSelectedId();
				if (!id) return;
				const node = state.whiteboard.nodes.find((n) => n.id === id);
				const el = nodeLayer.querySelector<HTMLElement>(`.whiteboard__node[data-node-id="${id}"]`);
				if (node && el && (isSticky(node) || isText(node))) beginEdit(node, el);
			}),
		);
	}

	function firstSelectedId(): string | null {
		for (const id of state.selectedIds) return id;
		return null;
	}

	function duplicateSelection(): void {
		if (state.selectedIds.size === 0) return;
		const copies: WhiteboardNode[] = [];
		for (const n of state.whiteboard.nodes) {
			if (!state.selectedIds.has(n.id)) continue;
			const copy = {
				...n,
				id: `${n.id}_copy_${Date.now().toString(36)}`,
				x: n.x + 24,
				y: n.y + 24,
			};
			copies.push(copy as WhiteboardNode);
		}
		if (copies.length === 0) return;
		state.whiteboard.nodes.push(...copies);
		state.selectedIds = new Set(copies.map((c) => c.id));
		persistBoard();
		paint();
		focusSelectedNode();
		announceSelection();
	}

	function zoomFromCenter(next: number): void {
		const rect = canvasWrap.getBoundingClientRect();
		zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, next);
	}

	function resetCamera(): void {
		state.zoom = 1;
		state.pan = { x: 0, y: 0 };
		paint();
	}

	function readNavPref(): boolean {
		try {
			return localStorage.getItem(NAV_PREF_KEY) !== "false";
		} catch {
			return true;
		}
	}

	function toggleNav(): void {
		const next = root.dataset.navOpen === "false";
		root.dataset.navOpen = next ? "true" : "false";
		try {
			localStorage.setItem(NAV_PREF_KEY, next ? "true" : "false");
		} catch {
			// Pref is a nicety, not load-bearing.
		}
		emitChrome();
	}

	function openBoard(id: string): void {
		const board = state.allWhiteboards.find((w) => w.id === id);
		if (!board) return;
		state.whiteboard = board;
		state.edges = state.allEdges.filter((e) => e.whiteboardId === board.id);
		state.selectedIds = new Set();
		state.editingNodeId = null;
		state.editingEdgeId = null;
		state.selectedEdgeId = null;
		state.zoom = 1;
		state.pan = { x: 0, y: 0 };
		paintedHeaderBoardId = null;
		if (!applyingNavHistory) {
			if (wbNav.current() === "") wbNav.replace(id);
			else if (wbNav.current() !== id) wbNav.push(id);
		}
		resetHistory();
		renderNavList();
		paint();
	}

	function applyBoardLocation(id: string): void {
		if (id === "" || id === state.whiteboard.id) return;
		if (!state.allWhiteboards.some((w) => w.id === id)) return;
		applyingNavHistory = true;
		try {
			openBoard(id);
		} finally {
			applyingNavHistory = false;
		}
	}

	function goBoardBack(): void {
		const id = wbNav.back();
		if (id !== null) applyBoardLocation(id);
	}

	function goBoardForward(): void {
		const id = wbNav.forward();
		if (id !== null) applyBoardLocation(id);
	}

	function createNewBoard(template: BoardTemplate = BoardTemplate.Blank): void {
		const now = Date.now();
		const id = `wb_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
		const content = buildTemplate(template);
		const name =
			template === BoardTemplate.Blank
				? t("whiteboard.untitled")
				: t(`whiteboard.template.${template}`);
		const board: Whiteboard = {
			id,
			name,
			nodes: content.nodes,
			createdAt: now,
			updatedAt: now,
		};
		state.allWhiteboards.unshift(board);
		if (state.repository) void state.repository.saveWhiteboard(board);
		for (const te of content.edges) {
			const edge = buildConnectorEdge({
				whiteboardId: id,
				from: { nodeId: te.sourceNodeId, side: te.sourceHandle },
				to: { nodeId: te.destNodeId, side: te.destHandle },
				now,
			});
			state.allEdges.push(edge);
			if (state.repository) void state.repository.saveEdge(edge);
		}
		openBoard(id);
	}

	function renderNavList(): void {
		const list = hosts.navList;
		const q = state.navQuery.trim();
		const boards = filterAndSortBoards(state.allWhiteboards, q);
		navListKeyboard?.destroy();
		navListKeyboard = null;
		if (boards.length === 0) {
			list.replaceChildren();
			const empty = document.createElement("div");
			empty.className = "whiteboard__nav-empty";
			empty.textContent =
				q === ""
					? t("whiteboard.nav.empty")
					: t("whiteboard.nav.emptySearch", { query: state.navQuery.trim() });
			list.appendChild(empty);
			return;
		}
		navListKeyboard = renderBoardListView(list, {
			boards,
			activeBoardId: state.whiteboard.id,
			onOpen: (id) => openBoard(id),
		});
	}

	function setNavQuery(query: string): void {
		state.navQuery = query;
		renderNavList();
	}

	function changeBoardIcon(): void {
		void import("@brainstorm/sdk/picker-host").then(({ openIconPicker }) => {
			openIconPicker({
				value: state.whiteboard.icon ?? null,
				onChange: (next) => {
					state.whiteboard.icon = next;
					persistBoard();
					paintedHeaderBoardId = null;
					emitChrome();
				},
			});
		});
	}

	function renameBoard(next: string): void {
		const board = state.whiteboard;
		if (!board.id) return;
		if (next === board.name) return;
		board.name = next;
		persistBoard();
		renderNavList();
		emitChrome();
	}

	// ── Dev/test hook (parallel to Notes' `__brainstormNotesDev`) ─────────────
	function installDevHook(): void {
		if (typeof window === "undefined" || window.__brainstormWhiteboardDev) return;
		window.__brainstormWhiteboardDev = {
			nodeIds: () => state.whiteboard.nodes.map((n) => n.id),
			dragNodeBy: (id, dx, dy) => {
				const node = state.whiteboard.nodes.find((n) => n.id === id);
				if (!node) throw new Error(`[whiteboard/dev] dragNodeBy: no node "${id}"`);
				const rawX = node.x + dx;
				const rawY = node.y + dy;
				const snap = computeSnap(
					{ x: rawX, y: rawY, width: node.width, height: node.height },
					snapNeighbours(node),
					SNAP_THRESHOLD_PX / state.zoom,
				);
				renderGuides(snap.guides);
				applyDragDelta(node, rawX + snap.dx - node.x, rawY + snap.dy - node.y);
				// Per-frame path: reposition existing elements only (the no-rebuild
				// drag frame the real pointermove loop uses). The settle (persist +
				// full reconcile) is `endDrag`, matching the real pointerup.
				paintDragFrame();
				return { x: node.x, y: node.y, guides: snap.guides.length };
			},
			endDrag: () => {
				renderGuides([]);
				persistBoard();
				paint();
			},
			connect: (sourceId, destId) => {
				const source = state.whiteboard.nodes.find((n) => n.id === sourceId);
				const dest = state.whiteboard.nodes.find((n) => n.id === destId);
				if (!source || !dest) throw new Error("[whiteboard/dev] connect: unknown node");
				const from = { nodeId: sourceId, side: HandleSide.Right };
				if (!isValidConnectorDrop(from, destId, state.edges)) return null;
				const edge = buildConnectorEdge({
					whiteboardId: state.whiteboard.id,
					from,
					to: { nodeId: destId, side: HandleSide.Left },
					now: Date.now(),
				});
				state.edges.push(edge);
				state.allEdges.push(edge);
				if (state.repository) {
					state.whiteboard.updatedAt = Date.now();
					void state.repository.saveEdge(edge);
				}
				recordHistory();
				paint();
				return edge.id;
			},
			seedGrid: (count, opts) => {
				const cols = opts?.cols ?? Math.max(1, Math.ceil(Math.sqrt(count)));
				const cell = opts?.cell ?? 240;
				const ids: string[] = [];
				for (let i = 0; i < count; i++) {
					const node = createStickyNode({ x: (i % cols) * cell, y: Math.floor(i / cols) * cell });
					state.whiteboard.nodes.push(node);
					ids.push(node.id);
				}
				state.selectedIds = new Set();
				paint();
				return ids;
			},
			mountedNodeIds: () =>
				Array.from(nodeLayer.querySelectorAll<HTMLElement>(".whiteboard__node[data-node-id]"))
					.map((el) => el.dataset.nodeId)
					.filter((id): id is string => Boolean(id)),
			setCamera: (camera) => {
				state.pan = { x: camera.panX, y: camera.panY };
				state.zoom = camera.zoom;
				paintCamera();
			},
			nodeEl: (id) => nodeLayer.querySelector<HTMLElement>(`.whiteboard__node[data-node-id="${id}"]`),
			selectEdge: (id) => selectEdge(id),
			drawInk: (points) => {
				const geometry = buildInkGeometry(points.map((p) => ({ x: p.x, y: p.y })));
				if (!geometry) return null;
				const node = createInkNode(geometry);
				addNode(node);
				return node.id;
			},
			edgeState: (id) => {
				const edge = state.edges.find((e) => e.id === id);
				if (!edge) return null;
				return {
					pathKind: edge.pathKind,
					arrowHead: edge.arrowHead,
					sourceArrowHead: edge.sourceArrowHead ?? null,
					dashed: edge.dashed === true,
					colorHint: edge.colorHint,
				};
			},
			presence: {
				clientId: () => awareness.clientID,
				applyRemote: (clientId, remoteState) => awareness.applyRemoteState(clientId, remoteState),
				peers: () =>
					currentPeers().map((p) => ({ clientId: p.clientId, name: p.name, cursor: p.cursor })),
			},
		};
	}

	async function loadBoards(): Promise<void> {
		const repo = state.repository;
		if (!repo) return;
		const { whiteboards, edges } = await repo.listAll();
		state.allWhiteboards = whiteboards;
		state.allEdges = edges;
	}

	/** Re-read every board/edge from the vault + repaint. Driven by React's
	 *  `useVaultEntities` snapshot changing (the shared reactivity stack — no
	 *  hand-rolled change loop here), so a cross-app write or a dev reseed
	 *  surfaces a freshly-seeded board without a manual reload. Coalescing
	 *  lives in `useVaultEntities`. */
	function refreshBoards(): void {
		if (!state.repository) return;
		void (async () => {
			await loadBoards();
			paint();
		})();
	}

	function bootstrap(): void {
		const runtime = getBrainstorm();
		const entitiesSvc = runtime?.services?.entities ?? null;
		if (!runtime || !entitiesSvc || !runtime.on) {
			paint();
			return;
		}
		const repo = createEntitiesRepository(entitiesSvc);
		state.repository = repo;
		renderNavList();
		paint();
		runtime.on("ready", () => {
			void (async () => {
				await loadBoards();
				const first = state.allWhiteboards[0];
				if (first) {
					openBoard(first.id);
					wbNav.reset(state.whiteboard.id);
				} else {
					paint();
				}
			})();
		});
	}

	function start(): void {
		const navOpenInitial = readNavPref();
		root.dataset.navOpen = navOpenInitial ? "true" : "false";
		bindShortcuts();
		bootstrap();
		installDevHook();
		bootPixi();
		emitChrome();
	}

	function dispose(): void {
		removeFormatToolbar();
		awareness.off("change", paintPresence);
		awareness.destroy();
		if (presenceCursorTimer !== null) clearTimeout(presenceCursorTimer);
		presenceCursorTimer = null;
		for (const off of unbinders) off();
		unbinders.length = 0;
		resizeObserver?.disconnect();
		resizeObserver = null;
		if (nudgePersistTimer) clearTimeout(nudgePersistTimer);
		nudgePersistTimer = null;
		navListKeyboard?.destroy();
		navListKeyboard = null;
		embedRegistry.reap(new Set());
		listeners.clear();
		canvasWrap.remove();
		layersPanel.element.remove();
		navResize.remove();
		hosts.navList.replaceChildren();
	}

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot: () => snapshot,
		boardContext,
		objectMenuRuntime,
		hasFilesService: () => Boolean(getBrainstorm()?.services?.files),
		hasVaultEntities: () => Boolean(getBrainstorm()?.services?.vaultEntities),
		createSticky,
		createText,
		createFrame,
		createShape,
		createRectangle,
		createEllipse,
		createGroupFromSelection,
		placeImageFromFile,
		pickEntityToEmbed,
		alignSelection,
		distributeSelection,
		applyZOrder,
		setSelectionLocked,
		setReadonly,
		setSelectionTextSize,
		setSelectionStickyFill,
		setSelectionTextColor,
		setSelectionFontFamily,
		toggleSelectionBold,
		toggleSelectionItalic,
		buildConnectorStyleItems,
		styleMenuItems,
		exportText,
		saveBoardAsFile,
		undo: undoBoard,
		redo: redoBoard,
		zoomBy: (factor) => zoomFromCenter(state.zoom * factor),
		zoomTo: (level) => zoomFromCenter(level),
		resetCamera,
		setTool,
		setLayersOpen,
		isLayersOpen: () => layersPanel.isOpen(),
		setNavQuery,
		toggleNav,
		createNewBoard,
		boardNav: () => wbNav,
		applyBoardLocation,
		goBoardBack,
		goBoardForward,
		changeBoardIcon,
		renameBoard,
		refreshBoards,
		start,
		dispose,
	};
}
