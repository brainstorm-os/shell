/**
 * DashboardWidgetsLayer (Stage 7.3b) — dashboard widgets as sandboxed iframes.
 *
 * Each placed widget renders the owning app's bundle (in widget mode) inside a
 * sandboxed `<iframe>` that's a plain DOM child of the slot card. Because it's
 * DOM (not a native `WebContentsView` overlay) it clips to the card's rounded
 * corners, z-orders under menus / popovers / DevTools, and moves + resizes with
 * the card via CSS — none of the native-overlay glitches. The iframe has no
 * preload, so its `window.brainstorm` is the postMessage shim from
 * `@brainstorm/sdk/widget`; THIS layer is the parent half of that bridge: it
 * maps each iframe's message `source` → its `appId` (which the sandboxed child
 * can't forge) and proxies the call to the capability-scoped main handlers via
 * `window.brainstorm.dashboard.widgetBridge`.
 *
 * The chrome (drag grip + title, open ↗, collapse, ⋯ menu, resize grip) is the
 * card's own DOM. Persistence is the shared dashboard doc (`upsertWidget` /
 * `removeWidget`); the snapshot round-trips back as the `widgets` prop.
 */

import { IconName as MenuIcon } from "@brainstorm/sdk/icon";
import { type ContextMenuItem, sdkMenuIcon } from "@brainstorm/sdk/menus";
import { closeAnchoredMenu, openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import { widgetFrameOrigin, widgetIframeQuery } from "@brainstorm/sdk/widget";
import { DEFAULT_THEME, flattenTokens, isThemeName, themes } from "@brainstorm/tokens";
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardWidget } from "../../preload";
import { t } from "../i18n/t";
import { Icon, IconName } from "../ui/icon";
import { AppIcon } from "./app-icon";
import {
	WIDGET_MIN_H,
	WIDGET_MIN_W,
	WIDGET_UNIT,
	WidgetSize,
	clampWidgetSize,
	migrateWidgetRecord,
	widgetFootprint,
	widgetPointToCell,
	widgetRectPx,
} from "./grid";
import "./widgets-layer.css";

/** Height of the card's chrome header strip. */
export const WIDGET_HEADER_PX = 30;

/** Below this much pointer movement a header press is a click, not a drag. */
const CLICK_MOVEMENT_THRESHOLD_PX = 5;

type DragState = {
	id: string;
	pointerId: number;
	/** Card top-left + size at grab time (surface pixels), fixed during the drag. */
	originX: number;
	originY: number;
	baseW: number;
	baseH: number;
	startClientX: number;
	startClientY: number;
};

type ResizeState = {
	id: string;
	pointerId: number;
	startClientX: number;
	startClientY: number;
	/** Card top-left at grab time (fixed during the resize). */
	cardX: number;
	cardY: number;
	startW: number;
	startH: number;
};

/** Live pixel rect of the widget being dragged / resized. Driven through React
 *  state (not imperative inline styles) so the card — a plain DOM element with
 *  the iframe as its child — moves/resizes with no transition animating the snap
 *  and no clear-on-commit flash. */
type GestureRect = { id: string; x: number; y: number; width: number; height: number };

/** Catalog key for a placement — `appId` + the registered widget id. */
function widgetKey(appId: string, widgetId: string): string {
	return `${appId}:${widgetId}`;
}

/** Build the active theme as a flattened `:root { --token: … }` CSS string to
 *  hand a widget iframe (which has no preload to apply tokens). The resolved
 *  theme is whatever the shell applied to its own `<html data-theme>`. */
function widgetThemeCss(): string {
	const name = document.documentElement.dataset.theme;
	const theme = isThemeName(name) ? name : DEFAULT_THEME;
	const lines: string[] = [];
	for (const [key, value] of Object.entries(flattenTokens(themes[theme]))) {
		if (key.startsWith("--") && /^[a-zA-Z0-9_-]+$/.test(key.slice(2))) {
			lines.push(`\t${key}: ${value};`);
		}
	}
	// The widget surface is the card (elevated), so paint the iframe root to match
	// — not the app's usual primary bg, which would read as a darker band.
	return `:root {\n${lines.join("\n")}\n}\nhtml, body { background-color: var(--color-background-elevated); color: var(--color-text-primary); }`;
}

/** Normalise a proxied `vaultEntities.list()` result to a snapshot the child's
 *  `useVaultEntities` can consume — a capability denial / error degrades to an
 *  empty list rather than throwing in the widget. */
function asSnapshot(value: unknown): { entities: unknown[]; links: unknown[] } {
	if (value && typeof value === "object" && "entities" in value) {
		return value as { entities: unknown[]; links: unknown[] };
	}
	return { entities: [], links: [] };
}

/** The dashboard half of the widget iframe bridge. Tracks each live widget
 *  iframe's `contentWindow → appId`, answers its `postMessage` RPCs by proxying
 *  to the capability-scoped main handlers, and fans the vault-entities staleness
 *  signal out to subscribed iframes. Returns a `register` callback the cards call
 *  on iframe load/unload. */
function useWidgetBridge(): {
	register: (win: Window | null, appId: string, origin: string) => () => void;
} {
	const registry = useRef(
		new Map<Window, { appId: string; origin: string; wantsChanges: boolean }>(),
	);

	useEffect(() => {
		const bridge = window.brainstorm.dashboard.widgetBridge;
		// An older preload (renderer HMR'd ahead of a preload reload) has no
		// `widgetBridge`. Degrade to no-op rather than crash — a full shell restart
		// rebuilds the preload and the bridge comes up.
		if (!bridge) {
			console.warn(
				"[widgets] window.brainstorm.dashboard.widgetBridge is missing — the preload is stale; a full shell restart is required for iframe widgets.",
			);
			return;
		}
		const onMessage = (event: MessageEvent) => {
			const source = event.source as Window | null;
			if (!source) return;
			const reg = registry.current.get(source);
			if (!reg) return;
			// Defence-in-depth on top of the unforgeable `source` identity: a
			// widget's messages must come from ITS OWN frame origin
			// (`bswidget://<appId>`), never another origin loaded into the frame.
			if (reg.origin !== "*" && event.origin !== reg.origin) return;
			const msg = event.data as {
				bs?: string;
				id?: number;
				service?: string;
				method?: string;
				args?: unknown[];
			};
			if (!msg || typeof msg !== "object") return;
			if (msg.bs === "widget-rpc") {
				void (async () => {
					let ok = true;
					let value: unknown = null;
					let error: string | undefined;
					try {
						if (msg.service === "vaultEntities" && msg.method === "list") {
							value = asSnapshot(await bridge.listEntities(reg.appId));
						} else if (msg.service === "intents" && msg.method === "dispatch") {
							const intent = msg.args?.[0] as { payload?: unknown } | undefined;
							value = await bridge.openIntent(reg.appId, intent?.payload ?? {});
						} else {
							// queryPattern / querySource aren't proxied — widgets use list().
							value = msg.service === "vaultEntities" ? asSnapshot(null) : null;
						}
					} catch (e) {
						ok = false;
						error = e instanceof Error ? e.message : String(e);
					}
					source.postMessage({ bs: "widget-rpc-result", id: msg.id, ok, value, error }, reg.origin);
				})();
			} else if (msg.bs === "widget-subscribe") {
				reg.wantsChanges = true;
			} else if (msg.bs === "widget-unsubscribe") {
				reg.wantsChanges = false;
			}
		};
		window.addEventListener("message", onMessage);
		const offChange = bridge.onEntitiesChanged(() => {
			for (const [win, reg] of registry.current) {
				if (reg.wantsChanges) win.postMessage({ bs: "widget-vault-changed" }, reg.origin);
			}
		});
		// Re-push the theme to every widget iframe when the shell switches theme
		// (the iframe has no preload, so it can't observe `:root` token changes).
		const themeObserver = new MutationObserver(() => {
			const css = widgetThemeCss();
			for (const [win, reg] of registry.current) {
				win.postMessage({ bs: "widget-theme", css }, reg.origin);
			}
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		return () => {
			window.removeEventListener("message", onMessage);
			offChange();
			themeObserver.disconnect();
		};
	}, []);

	const register = useCallback((win: Window | null, appId: string, origin: string) => {
		if (!win) return () => {};
		registry.current.set(win, { appId, origin, wantsChanges: false });
		// Hand the iframe the active theme tokens up front (it loaded after the
		// parent's listener was up, so its message handler is ready).
		win.postMessage({ bs: "widget-theme", css: widgetThemeCss() }, origin);
		return () => {
			registry.current.delete(win);
		};
	}, []);

	return { register };
}

export type DashboardWidgetsLayerProps = {
	widgets: Record<string, DashboardWidget>;
};

function DashboardWidgetsLayerInner({ widgets }: DashboardWidgetsLayerProps) {
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<DragState | null>(null);
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const resizeRef = useRef<ResizeState | null>(null);
	const [resizingId, setResizingId] = useState<string | null>(null);
	// Live pixel rect of the in-flight gesture (see GestureRect).
	const [gesture, setGesture] = useState<GestureRect | null>(null);
	const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
	const bridge = useWidgetBridge();

	// Pre-7.3b widgets stored their footprint in coarse icon-grid cells; migrate
	// onto the 8px widget grid on read (self-terminating) and persist once.
	const migrated = useMemo(() => {
		const out: Record<string, DashboardWidget> = {};
		for (const [id, w] of Object.entries(widgets)) out[id] = migrateWidgetRecord(w);
		return out;
	}, [widgets]);
	useEffect(() => {
		for (const [id, w] of Object.entries(widgets)) {
			const m = migrateWidgetRecord(w);
			if (m !== w) void window.brainstorm.dashboard.upsertWidget(id, m);
		}
	}, [widgets]);

	// A drop / resize applies optimistically so the card lands on its final
	// geometry immediately; `upsertWidget` echoes back a beat later. Cleared once
	// the prop catches up.
	const [pending, setPending] = useState<{
		id: string;
		x?: number;
		y?: number;
		w?: number;
		h?: number;
	} | null>(null);
	// Collapse persists on the widget record so it survives a restart; an
	// optimistic override keeps the caret instant until the doc round-trips back
	// (same reason drag/resize keep `pending`).
	const [collapsedOverride, setCollapsedOverride] = useState<ReadonlyMap<string, boolean>>(
		() => new Map(),
	);

	const effectiveWidgets = useMemo(() => {
		if (!pending) return migrated;
		const record = migrated[pending.id];
		if (!record) return migrated;
		return {
			...migrated,
			[pending.id]: {
				...record,
				...(pending.x !== undefined ? { x: pending.x } : {}),
				...(pending.y !== undefined ? { y: pending.y } : {}),
				...(pending.w !== undefined ? { w: pending.w } : {}),
				...(pending.h !== undefined ? { h: pending.h } : {}),
			},
		};
	}, [migrated, pending]);

	const toggleCollapsed = useCallback(
		(id: string) => {
			const record = effectiveWidgets[id];
			if (!record) return;
			const next = !(collapsedOverride.get(id) ?? record.collapsed);
			setCollapsedOverride((prev) => new Map(prev).set(id, next));
			void window.brainstorm.dashboard.upsertWidget(id, { ...record, collapsed: next });
		},
		[effectiveWidgets, collapsedOverride],
	);

	useEffect(() => {
		if (!pending) return;
		const record = migrated[pending.id];
		const matches =
			!record ||
			((pending.x === undefined || record.x === pending.x) &&
				(pending.y === undefined || record.y === pending.y) &&
				(pending.w === undefined || record.w === pending.w) &&
				(pending.h === undefined || record.h === pending.h));
		if (matches) setPending(null);
	}, [migrated, pending]);

	// Drop an optimistic collapse override once the persisted record agrees.
	useEffect(() => {
		setCollapsedOverride((prev) => {
			if (prev.size === 0) return prev;
			let changed = false;
			const next = new Map(prev);
			for (const [id, want] of prev) {
				const record = migrated[id];
				if (!record || record.collapsed === want) {
					next.delete(id);
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [migrated]);

	// Resolve placement titles from the app-registered widget catalog.
	useEffect(() => {
		let cancelled = false;
		void window.brainstorm.dashboard.registeredWidgets().then((registered) => {
			if (cancelled) return;
			setTitles(new Map(registered.map((w) => [widgetKey(w.appId, w.widgetId), w.name])));
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const endDrag = useCallback(() => {
		dragRef.current = null;
		setGesture(null);
		setDraggingId(null);
	}, []);

	const onHeaderPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>, id: string) => {
			if (event.button !== 0) return;
			const record = effectiveWidgets[id];
			if (!record) return;
			// Grabbing the header captures the pointer to this grip, so the menu's
			// dimmer never gets the click that would dismiss it — close it here.
			closeAnchoredMenu();
			const card = widgetRectPx({ col: record.x, row: record.y, w: record.w, h: record.h });
			event.currentTarget.setPointerCapture(event.pointerId);
			dragRef.current = {
				id,
				pointerId: event.pointerId,
				originX: card.x,
				originY: card.y,
				baseW: card.width,
				baseH: card.height,
				startClientX: event.clientX,
				startClientY: event.clientY,
			};
			setDraggingId(id);
		},
		[effectiveWidgets],
	);

	const onHeaderPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || event.pointerId !== drag.pointerId) return;
		if ((event.buttons & 1) === 0) return;
		const dx = event.clientX - drag.startClientX;
		const dy = event.clientY - drag.startClientY;
		// Card (+ its iframe child) follows the cursor 1:1 via live React geometry.
		setGesture({
			id: drag.id,
			x: drag.originX + dx,
			y: drag.originY + dy,
			width: drag.baseW,
			height: drag.baseH,
		});
	}, []);

	const onHeaderPointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const drag = dragRef.current;
			if (!drag || event.pointerId !== drag.pointerId) return;
			event.currentTarget.releasePointerCapture(event.pointerId);
			const dx = event.clientX - drag.startClientX;
			const dy = event.clientY - drag.startClientY;
			if (Math.abs(dx) <= CLICK_MOVEMENT_THRESHOLD_PX && Math.abs(dy) <= CLICK_MOVEMENT_THRESHOLD_PX) {
				endDrag();
				return;
			}
			const cell = widgetPointToCell({ x: drag.originX + dx, y: drag.originY + dy });
			const record = effectiveWidgets[drag.id];
			if (record) {
				const x = Math.max(0, cell.col);
				const y = Math.max(0, cell.row);
				setPending({ id: drag.id, x, y });
				void window.brainstorm.dashboard.upsertWidget(drag.id, { ...record, x, y });
			}
			endDrag();
		},
		[effectiveWidgets, endDrag],
	);

	const endResize = useCallback(() => {
		resizeRef.current = null;
		setGesture(null);
		setResizingId(null);
	}, []);

	const onResizePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>, id: string) => {
			if (event.button !== 0) return;
			event.stopPropagation();
			const record = effectiveWidgets[id];
			if (!record) return;
			closeAnchoredMenu();
			const card = widgetRectPx({ col: record.x, row: record.y, w: record.w, h: record.h });
			event.currentTarget.setPointerCapture(event.pointerId);
			resizeRef.current = {
				id,
				pointerId: event.pointerId,
				startClientX: event.clientX,
				startClientY: event.clientY,
				cardX: card.x,
				cardY: card.y,
				startW: record.w,
				startH: record.h,
			};
			setResizingId(id);
		},
		[effectiveWidgets],
	);

	const onResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		const r = resizeRef.current;
		if (!r || event.pointerId !== r.pointerId) return;
		if ((event.buttons & 1) === 0) return;
		const w = Math.max(
			WIDGET_MIN_W,
			r.startW + Math.round((event.clientX - r.startClientX) / WIDGET_UNIT),
		);
		const h = Math.max(
			WIDGET_MIN_H,
			r.startH + Math.round((event.clientY - r.startClientY) / WIDGET_UNIT),
		);
		setGesture({ id: r.id, x: r.cardX, y: r.cardY, width: w * WIDGET_UNIT, height: h * WIDGET_UNIT });
	}, []);

	const onResizePointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const r = resizeRef.current;
			if (!r || event.pointerId !== r.pointerId) return;
			event.currentTarget.releasePointerCapture(event.pointerId);
			const size = clampWidgetSize({
				w: r.startW + Math.round((event.clientX - r.startClientX) / WIDGET_UNIT),
				h: r.startH + Math.round((event.clientY - r.startClientY) / WIDGET_UNIT),
			});
			const record = effectiveWidgets[r.id];
			if (record) {
				setPending({ id: r.id, w: size.w, h: size.h });
				void window.brainstorm.dashboard.upsertWidget(r.id, { ...record, w: size.w, h: size.h });
			}
			endResize();
		},
		[effectiveWidgets, endResize],
	);

	const openApp = useCallback((appId: string) => {
		void window.brainstorm.apps.launch(appId);
	}, []);

	const openWidgetMenu = useCallback((anchor: HTMLElement, id: string) => {
		// Sizing is the corner drag-resize grip's job; the menu only carries the
		// catch-all actions (just Remove today).
		const items: ContextMenuItem[] = [
			{
				id: "remove",
				label: t("shell.widgets.menu.remove"),
				icon: sdkMenuIcon(MenuIcon.Trash),
				destructive: true,
				onSelect: () => void window.brainstorm.dashboard.removeWidget(id),
			},
		];
		openAnchoredMenu(anchor.getBoundingClientRect(), items, {
			menuLabel: t("shell.widgets.menu.label"),
			anchor,
		});
	}, []);

	const entries = useMemo(() => Object.entries(effectiveWidgets), [effectiveWidgets]);

	return (
		<div ref={surfaceRef} className="dashboard-widgets" aria-label={t("shell.widgets.layerLabel")}>
			{entries.map(([id, w]) => {
				const isGesturing = draggingId === id || resizingId === id;
				const isCollapsed = collapsedOverride.get(id) ?? w.collapsed;
				// During a drag/resize the card follows the live pixel rect; otherwise
				// it sits on its stored 8px cell.
				const live = gesture?.id === id ? gesture : null;
				const card = live ?? widgetRectPx({ col: w.x, row: w.y, w: w.w, h: w.h });
				const title = titles.get(widgetKey(w.appId, w.kind)) ?? w.kind;
				return (
					<WidgetCard
						key={id}
						id={id}
						appId={w.appId}
						widgetKind={w.kind}
						title={title}
						left={card.x}
						top={card.y}
						width={card.width}
						// A collapsed card stays header-height even mid-drag — `live` (a
						// gesture) must not expand it (a collapsed widget has no resize
						// grip, so a live gesture on it is only ever a move).
						height={isCollapsed ? WIDGET_HEADER_PX : card.height}
						headerPx={WIDGET_HEADER_PX}
						gesturing={isGesturing}
						collapsed={isCollapsed}
						register={bridge.register}
						onHeaderPointerDown={onHeaderPointerDown}
						onHeaderPointerMove={onHeaderPointerMove}
						onHeaderPointerUp={onHeaderPointerUp}
						onHeaderPointerCancel={endDrag}
						onOpenApp={openApp}
						onToggleCollapsed={toggleCollapsed}
						onOpenMenu={openWidgetMenu}
						onResizePointerDown={onResizePointerDown}
						onResizePointerMove={onResizePointerMove}
						onResizePointerUp={onResizePointerUp}
						onResizePointerCancel={endResize}
					/>
				);
			})}
		</div>
	);
}

type WidgetCardProps = {
	id: string;
	appId: string;
	widgetKind: string;
	title: string;
	left: number;
	top: number;
	width: number;
	height: number;
	headerPx: number;
	gesturing: boolean;
	collapsed: boolean;
	register: (win: Window | null, appId: string, origin: string) => () => void;
	onHeaderPointerDown: (e: React.PointerEvent<HTMLDivElement>, id: string) => void;
	onHeaderPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
	onHeaderPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
	onHeaderPointerCancel: () => void;
	onOpenApp: (appId: string) => void;
	onToggleCollapsed: (id: string) => void;
	onOpenMenu: (anchor: HTMLElement, id: string) => void;
	onResizePointerDown: (e: React.PointerEvent<HTMLDivElement>, id: string) => void;
	onResizePointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
	onResizePointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
	onResizePointerCancel: () => void;
};

// Memoised so a per-frame gesture re-render of the layer only re-renders the
// card actually being dragged/resized — the others (and their iframes) are stable.
const WidgetCard = memo(function WidgetCardImpl(props: WidgetCardProps) {
	const { id, appId, widgetKind, title, collapsed, register } = props;
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [src, setSrc] = useState<string | null>(null);

	// Resolve the app bundle's cache-busted entry URL + append the widget launch
	// query the iframe shim reads (`bs-widget` / id).
	useEffect(() => {
		const bridge = window.brainstorm.dashboard.widgetBridge;
		if (!bridge) return; // stale preload — see useWidgetBridge
		let cancelled = false;
		void bridge.resolveEntry(appId, widgetKind).then((entry) => {
			if (cancelled || !entry) return;
			const sep = entry.includes("?") ? "&" : "?";
			setSrc(`${entry}${sep}${widgetIframeQuery({ widgetId: widgetKind })}`);
		});
		return () => {
			cancelled = true;
		};
	}, [appId, widgetKind]);

	// Register the iframe's contentWindow with the parent bridge on load (so its
	// postMessages map to this appId), and tear that down on unmount / reload.
	const unregisterRef = useRef<(() => void) | null>(null);
	const onIframeLoad = useCallback(() => {
		unregisterRef.current?.();
		// The frame's own origin (`bswidget://<appId>`) pins every parent→widget
		// send + the inbound origin check, so vault data is never broadcast to "*".
		unregisterRef.current = register(
			iframeRef.current?.contentWindow ?? null,
			appId,
			src ? widgetFrameOrigin(src) : "*",
		);
	}, [register, appId, src]);
	useEffect(() => () => unregisterRef.current?.(), []);

	const cardClass = [
		"dashboard-widgets__card",
		props.gesturing ? "dashboard-widgets__card--dragging" : "",
		collapsed ? "dashboard-widgets__card--collapsed" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<div
			className={cardClass}
			style={
				{
					left: `${props.left}px`,
					top: `${props.top}px`,
					width: `${props.width}px`,
					height: `${props.height}px`,
					"--widget-header": `${props.headerPx}px`,
				} as CSSProperties
			}
			data-testid={`dashboard-widget-${id}`}
		>
			<div className="dashboard-widgets__header">
				<div
					className="dashboard-widgets__grip"
					onPointerDown={(e) => props.onHeaderPointerDown(e, id)}
					onPointerMove={props.onHeaderPointerMove}
					onPointerUp={props.onHeaderPointerUp}
					onPointerCancel={props.onHeaderPointerCancel}
				>
					{/* The owning app's brand glyph — the `glyph` variant drops the
					    squircle tile + glass, so the header reads as a bare mark (the
					    full tile was visual noise at this size). */}
					<AppIcon
						name={title}
						seed={appId}
						src={`brainstorm://app-icon/${encodeURIComponent(appId)}`}
						size={18}
						glyph
					/>
					<span className="dashboard-widgets__title">{title}</span>
				</div>
				<button
					type="button"
					className="dashboard-widgets__action"
					onClick={() => props.onOpenApp(appId)}
					aria-label={t("shell.widgets.open", { name: title })}
					data-bs-tooltip={t("shell.widgets.open", { name: title })}
				>
					<Icon name={IconName.ArrowUpRight} />
				</button>
				<button
					type="button"
					className="dashboard-widgets__action"
					onClick={() => props.onToggleCollapsed(id)}
					aria-expanded={!collapsed}
					aria-label={collapsed ? t("shell.widgets.expand") : t("shell.widgets.collapse")}
					data-bs-tooltip={collapsed ? t("shell.widgets.expand") : t("shell.widgets.collapse")}
				>
					<Icon name={collapsed ? IconName.CaretDown : IconName.CaretUp} />
				</button>
				<button
					type="button"
					className="dashboard-widgets__action dashboard-widgets__action--menu"
					onClick={(e) => props.onOpenMenu(e.currentTarget, id)}
					aria-label={t("shell.widgets.menu.label")}
					data-bs-tooltip={t("shell.widgets.menu.label")}
				>
					<Icon name={IconName.More} />
				</button>
			</div>
			{!collapsed && (
				<div className="dashboard-widgets__body">
					{src ? (
						<iframe
							ref={iframeRef}
							className="dashboard-widgets__frame"
							// Loads the widget's ES-module bundle from the distinct
							// `bswidget://<appId>` origin — srcdoc can't pull a module graph;
							// sandbox + distinct-origin isolation is the security boundary.
							// iframe-src-exempt
							src={src}
							title={title}
							// `allow-same-origin` so the app's ES-module bundle actually loads
							// (an opaque-origin iframe can't fetch its module graph). SAFE
							// because the bundle is served from the `bswidget://<appId>` scheme
							// — a DISTINCT origin from the dashboard in BOTH dev (http://localhost)
							// and a packaged build (file://), so `allow-same-origin` lets it load
							// its modules without granting any reach into the shell.
							// `allow-scripts` runs the app; no allow-popups/forms/etc.
							sandbox="allow-scripts allow-same-origin"
							onLoad={onIframeLoad}
						/>
					) : (
						<div className="dashboard-widgets__placeholder" aria-hidden="true">
							<Icon name={IconName.App} size={28} />
						</div>
					)}
					{/* Resize grip — a DOM child layered over the iframe at the corner. */}
					<div
						className="dashboard-widgets__resize"
						aria-hidden="true"
						data-bs-tooltip={t("shell.widgets.resize")}
						onPointerDown={(e) => props.onResizePointerDown(e, id)}
						onPointerMove={props.onResizePointerMove}
						onPointerUp={props.onResizePointerUp}
						onPointerCancel={props.onResizePointerCancel}
					>
						<svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
							<path d="M9 1 L1 9 M9 5 L5 9" />
						</svg>
					</div>
				</div>
			)}
		</div>
	);
});

export const DashboardWidgetsLayer = memo(DashboardWidgetsLayerInner);
