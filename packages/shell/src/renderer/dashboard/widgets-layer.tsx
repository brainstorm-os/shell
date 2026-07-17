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
import { launchApp } from "../analytics/track-app-launch";
import { t } from "../i18n/t";
import { Icon, IconName } from "../ui/icon";
import { AppIcon } from "./app-icon";
import {
	type GridPoint,
	WIDGET_MIN_H,
	WIDGET_MIN_W,
	WIDGET_UNIT,
	WidgetSize,
	clampWidgetOrigin,
	clampWidgetSize,
	migrateWidgetRecord,
	widgetFootprint,
	widgetPointToCell,
	widgetRectPx,
} from "./grid";
import "./widgets-layer.css";

/** Height of the card's chrome header strip. */
export const WIDGET_HEADER_PX = 30;

/** Arrow-key → grid-cell delta for the focusable grips (F-383). */
const ARROW_DELTAS: Record<string, readonly [number, number]> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};

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
							// args[0] is the widget's optional {types, limit} query —
							// validated main-side (F-384).
							value = asSnapshot(await bridge.listEntities(reg.appId, msg.args?.[0]));
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

	// Surface size in CSS pixels, for the stranded-record rescue clamp
	// (`clampWidgetOrigin`, F-379). Initialised from the window (the surface is
	// an `inset: 0` overlay of it) and kept live via a rAF-coalesced
	// ResizeObserver, mirroring the icons layer; a zero layout box (hidden /
	// pre-layout) falls back to the window box rather than clamping against 0.
	const [surface, setSurface] = useState<GridPoint>(() => ({
		x: window.innerWidth,
		y: window.innerHeight,
	}));
	useEffect(() => {
		const el = surfaceRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		let raf = 0;
		const apply = () => {
			raf = 0;
			const rect = el.getBoundingClientRect();
			const next =
				rect.width > 0 && rect.height > 0
					? { x: rect.width, y: rect.height }
					: { x: window.innerWidth, y: window.innerHeight };
			setSurface((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
		};
		const schedule = () => {
			if (raf === 0) raf = requestAnimationFrame(apply);
		};
		const observer = new ResizeObserver(schedule);
		observer.observe(el);
		return () => {
			observer.disconnect();
			if (raf !== 0) cancelAnimationFrame(raf);
		};
	}, []);

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
		const record = pending ? migrated[pending.id] : undefined;
		const merged: Record<string, DashboardWidget> =
			pending && record
				? {
						...migrated,
						[pending.id]: {
							...record,
							...(pending.x !== undefined ? { x: pending.x } : {}),
							...(pending.y !== undefined ? { y: pending.y } : {}),
							...(pending.w !== undefined ? { w: pending.w } : {}),
							...(pending.h !== undefined ? { h: pending.h } : {}),
						},
					}
				: migrated;
		// Rescue clamp (F-379): a record whose stored origin sits off-surface
		// (the ×10-teleport bug baked such positions in) renders unreachable
		// forever without this. Applied to the view-model — display, gesture
		// origins, and subsequent writes all use the clamped cells, so touching
		// a rescued widget persists its on-surface position.
		let changed = false;
		const out: Record<string, DashboardWidget> = {};
		for (const [id, w] of Object.entries(merged)) {
			const clamped = clampWidgetOrigin(w, surface);
			out[id] = clamped;
			if (clamped !== w) changed = true;
		}
		return changed ? out : merged;
	}, [migrated, pending, surface]);

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

	// Resolve placement titles from the app-registered widget catalog — and
	// re-resolve on `apps:changed`: the one-shot read races an app (re)install
	// (the registry row is briefly gone mid-reinstall) and a missed title
	// otherwise sticks as the raw kind slug until restart (F-380). The same
	// edge bumps `appsEpoch` so every card re-resolves its iframe entry (a
	// reinstall changes the bundle sha → fresh URL → the iframe reloads the
	// new bundle; a placeholder card gets its first real entry).
	const [appsEpoch, setAppsEpoch] = useState(0);
	useEffect(() => {
		let cancelled = false;
		const refetch = () => {
			void window.brainstorm.dashboard.registeredWidgets().then((registered) => {
				if (cancelled) return;
				setTitles(new Map(registered.map((w) => [widgetKey(w.appId, w.widgetId), w.name])));
			});
		};
		refetch();
		const off = window.brainstorm.apps.onChanged?.(() => {
			refetch();
			setAppsEpoch((n) => n + 1);
		});
		return () => {
			cancelled = true;
			off?.();
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
				const target = clampWidgetOrigin({ ...record, x: cell.col, y: cell.row }, surface);
				setPending({ id: drag.id, x: target.x, y: target.y });
				void window.brainstorm.dashboard.upsertWidget(drag.id, target);
			}
			endDrag();
		},
		[effectiveWidgets, endDrag, surface],
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
		launchApp(appId, "widget");
	}, []);

	// Keyboard move/resize (F-383): the grips are focusable and nudge the
	// record on the same 8px grid the pointer gestures snap to. Each nudge
	// persists immediately — the doc echo is the source of truth, `pending`
	// keeps the card optimistic exactly like a pointer drop.
	const nudgeMove = useCallback(
		(id: string, dx: number, dy: number) => {
			const record = effectiveWidgets[id];
			if (!record) return;
			const target = clampWidgetOrigin(
				{ ...record, x: Math.max(0, record.x + dx), y: Math.max(0, record.y + dy) },
				surface,
			);
			setPending({ id, x: target.x, y: target.y });
			void window.brainstorm.dashboard.upsertWidget(id, target);
		},
		[effectiveWidgets, surface],
	);

	const nudgeResize = useCallback(
		(id: string, dw: number, dh: number) => {
			const record = effectiveWidgets[id];
			if (!record) return;
			const size = clampWidgetSize({ w: record.w + dw, h: record.h + dh });
			setPending({ id, w: size.w, h: size.h });
			void window.brainstorm.dashboard.upsertWidget(id, { ...record, w: size.w, h: size.h });
		},
		[effectiveWidgets],
	);

	const openWidgetMenu = useCallback(
		(anchor: HTMLElement, id: string) => {
			const record = effectiveWidgets[id];
			if (!record) return;
			const sizeItem = (size: WidgetSize, label: string): ContextMenuItem => {
				const fp = widgetFootprint(size);
				const current = record.w === fp.w && record.h === fp.h;
				return {
					id: `size-${size}`,
					label,
					selected: current,
					...(current ? { icon: sdkMenuIcon(MenuIcon.Check) } : {}),
					onSelect: () => {
						setPending({ id, w: fp.w, h: fp.h });
						void window.brainstorm.dashboard.upsertWidget(id, { ...record, w: fp.w, h: fp.h });
					},
				};
			};
			const items: ContextMenuItem[] = [
				{ id: "size", label: t("shell.widgets.menu.size"), section: true },
				sizeItem(WidgetSize.Small, t("shell.widgets.menu.size.small")),
				sizeItem(WidgetSize.Medium, t("shell.widgets.menu.size.medium")),
				sizeItem(WidgetSize.Large, t("shell.widgets.menu.size.large")),
				{ id: "sep", label: "", divider: true },
				{
					id: "open-app",
					label: t("shell.widgets.menu.openApp"),
					icon: sdkMenuIcon(MenuIcon.OpenExternal),
					onSelect: () => openApp(record.appId),
				},
				// Remove stays LAST — the ⋯ is the catch-all and its trailing edge is
				// the destructive slot, mirroring every app's object menu.
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
		},
		[effectiveWidgets, openApp],
	);

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
						appsEpoch={appsEpoch}
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
						onNudgeMove={nudgeMove}
						onNudgeResize={nudgeResize}
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
	/** Bumps on `apps:changed` — re-resolves the iframe entry (F-380). */
	appsEpoch: number;
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
	onNudgeMove: (id: string, dx: number, dy: number) => void;
	onNudgeResize: (id: string, dw: number, dh: number) => void;
	onResizePointerDown: (e: React.PointerEvent<HTMLDivElement>, id: string) => void;
	onResizePointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
	onResizePointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
	onResizePointerCancel: () => void;
};

// Memoised so a per-frame gesture re-render of the layer only re-renders the
// card actually being dragged/resized — the others (and their iframes) are stable.
const WidgetCard = memo(function WidgetCardImpl(props: WidgetCardProps) {
	const { id, appId, widgetKind, title, appsEpoch, collapsed, register } = props;
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [src, setSrc] = useState<string | null>(null);

	// Resolve the app bundle's cache-busted entry URL + append the widget launch
	// query the iframe shim reads (`bs-widget` / id). Re-runs on `appsEpoch`
	// (an app (re)install): a transient null during the installer window must
	// not leave a permanent placeholder, and a changed bundle sha must reload
	// the iframe with the new bundle (F-380). A null re-resolve keeps the last
	// good src — a briefly-uninstalled app's widget freezes rather than blanks.
	// biome-ignore lint/correctness/useExhaustiveDependencies: appsEpoch is an intentional re-run key (apps:changed edge), not a body dep.
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
	}, [appId, widgetKind, appsEpoch]);

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
				{/* Focusable move handle (F-383): drag with the pointer, or focus and
				    nudge with arrow keys (Shift = 4 cells). Keyboard-exempt: grip-local
				    arrow handling on a focused element (the app-grid combobox-bridge
				    pattern), not a global chord. */}
				<div
					className="dashboard-widgets__grip"
					role="button"
					tabIndex={0}
					aria-label={t("shell.widgets.move", { name: title })}
					data-bs-tooltip={t("shell.widgets.move", { name: title })}
					onKeyDown={(e) => {
						const delta = ARROW_DELTAS[e.key];
						if (!delta) return;
						e.preventDefault();
						const step = e.shiftKey ? 4 : 1;
						props.onNudgeMove(id, delta[0] * step, delta[1] * step);
					}}
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
					{/* Resize grip — a DOM child layered over the iframe at the corner.
					    Focusable (F-383): arrow keys grow/shrink one cell (Shift = 4);
					    keyboard-exempt, grip-local handling like the move grip. */}
					<div
						className="dashboard-widgets__resize"
						role="button"
						tabIndex={0}
						aria-label={t("shell.widgets.resize")}
						data-bs-tooltip={t("shell.widgets.resize")}
						onKeyDown={(e) => {
							const delta = ARROW_DELTAS[e.key];
							if (!delta) return;
							e.preventDefault();
							const step = e.shiftKey ? 4 : 1;
							props.onNudgeResize(id, delta[0] * step, delta[1] * step);
						}}
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
