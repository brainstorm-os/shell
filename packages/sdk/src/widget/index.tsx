/**
 * Widget bootstrap (Stage 7.3, OQ-6 → (a)). An app that declares
 * `registrations.widgets` in its manifest is, when mounted as a dashboard
 * widget, launched with `launch.reason === "widget"`. The app's entry reads
 * `getWidgetLaunch()` and, when it returns a target, renders `<WidgetRoot>`
 * instead of its full UI — the same bundle, in widget-mode.
 *
 * Pause/resume is host-driven: the dashboard hides the widget's native view
 * off-screen and pushes `window:visibility-changed` to it. Hiding a
 * `WebContentsView` does NOT flip `document.visibilityState` in the guest, so
 * the app-preload mirrors that signal onto `documentElement.dataset.appHidden`
 * + a `brainstorm:app-visibility` event — the same channel a backgrounded app
 * window already uses. `useWidgetVisible` reads that, not the Page Visibility
 * API, so a scrolled-off widget reliably pauses its render loop / polling.
 *
 * Widgets are read-mostly and click-through-to-open: the body's rows open the
 * entity they represent. The widget's *chrome* — friendly title, drag handle,
 * "open app" ↗, and the ⋯ options menu — is drawn by the shell's renderer
 * `DashboardWidgetsLayer` strip above the native view (native DOM can't be
 * dragged from the dashboard renderer), so `WidgetRoot` renders only the body.
 */

import { type ReactNode, useEffect, useState } from "react";
import { installWidgetIframeBridge } from "./iframe-bridge";
import "./widget.css";

export {
	installWidgetIframeBridge,
	readIframeWidgetLaunch,
	widgetFrameOrigin,
	widgetIframeQuery,
	WIDGET_QUERY_FLAG,
	WIDGET_QUERY_ID,
	WIDGET_QUERY_BIND,
	type WidgetBridgeMessage,
	type WidgetRpcRequest,
	type WidgetRpcResult,
} from "./iframe-bridge";

/** The parsed widget launch target. */
export type WidgetLaunch = {
	/** Which registered widget to render (manifest widget id). */
	widgetId: string;
	/** Optional entity / saved-view id for a parameterised widget. */
	bind?: string;
};

type LaunchLike = { reason?: string; widgetId?: unknown; bind?: unknown };
type RuntimeLike = { launch?: LaunchLike };

/** Read the widget launch target from the host runtime (defaults to
 *  `window.brainstorm`), or null when this surface wasn't launched as a widget.
 *
 *  A native (`WebContentsView`) widget has a preload-built `window.brainstorm`
 *  carrying `launch`. A sandboxed iframe widget has NO preload, so when no
 *  runtime is present we fall back to building the postMessage bridge from the
 *  iframe URL — same call site, `window.brainstorm` is installed as a side
 *  effect (see `installWidgetIframeBridge`). */
export function getWidgetLaunch(runtime?: RuntimeLike): WidgetLaunch | null {
	const r = runtime ?? (globalThis as { brainstorm?: RuntimeLike }).brainstorm ?? undefined;
	const launch = r?.launch;
	if (launch && launch.reason === "widget" && typeof launch.widgetId === "string") {
		return {
			widgetId: launch.widgetId,
			...(typeof launch.bind === "string" ? { bind: launch.bind } : {}),
		};
	}
	if (!runtime) return installWidgetIframeBridge();
	return null;
}

/** Read the host-driven visibility state. The shell pauses a widget by hiding
 *  its native view + pushing `window:visibility-changed`, which the app-preload
 *  mirrors onto `documentElement.dataset.appHidden`. Absent / `"false"` ⇒
 *  visible (the default before any pause signal arrives). */
export function widgetVisible(): boolean {
	if (typeof document === "undefined") return true;
	return document.documentElement?.dataset.appHidden !== "true";
}

/** Subscribe to widget pause/resume. Calls back `true` when visible (resume),
 *  `false` when hidden (pause). Fires once immediately with the current state. */
export function onWidgetVisibility(cb: (visible: boolean) => void): () => void {
	const handler = () => cb(widgetVisible());
	// Primary signal: the shell's host-driven pause edge (a hidden
	// WebContentsView does not flip the Page Visibility API).
	window.addEventListener("brainstorm:app-visibility", handler);
	// Secondary: still honour a genuine Page Visibility flip (window minimised /
	// occluded), which the shell does not separately signal.
	document.addEventListener("visibilitychange", handler);
	handler();
	return () => {
		window.removeEventListener("brainstorm:app-visibility", handler);
		document.removeEventListener("visibilitychange", handler);
	};
}

/** Reactive widget visibility — `false` while the widget is scrolled off-screen,
 *  so render loops / polling can stop. */
export function useWidgetVisible(): boolean {
	const [visible, setVisible] = useState(widgetVisible);
	useEffect(() => onWidgetVisibility(setVisible), []);
	return visible;
}

/** A registered widget renderer, keyed by the manifest widget id. */
export type WidgetDef = {
	id: string;
	render: () => ReactNode;
};

export type WidgetRootProps = {
	/** Every widget this app can render; the matching one is mounted. */
	widgets: readonly WidgetDef[];
	/** The launch target (from `getWidgetLaunch()`). */
	launch: WidgetLaunch;
};

export type WidgetEmptyProps = {
	/** The one-line empty message (already localized by the app). */
	message: string;
	/** Optional call-to-action label; rendered as a link-styled button. */
	actionLabel?: string;
	/** CTA handler — typically an entityType-only `open` intent, which routes
	 *  to the type's registered opener and launches the owning app (F-381). */
	onAction?: () => void;
};

/** The shared widget empty state (F-381): a glance tile with nothing to show
 *  is the one moment a widget should invite action, so the message pairs with
 *  a small inline CTA instead of dead-ending. Deliberately NOT the big
 *  `<EmptyState>` glyph chip — oversized at widget scale (the F-283 ruling). */
export function WidgetEmpty({ message, actionLabel, onAction }: WidgetEmptyProps) {
	return (
		<div className="bs-widget-empty">
			<p className="bs-widget-empty__message">{message}</p>
			{actionLabel && onAction ? (
				<button type="button" className="bs-widget-empty__action" onClick={onAction}>
					{actionLabel}
				</button>
			) : null}
		</div>
	);
}

/** The matched widget body — the only thing the native widget surface paints.
 *  Title / open / drag / options chrome lives in the shell renderer strip above
 *  this native view. Renders a graceful fallback when the launch target names a
 *  widget the app doesn't register (manifest / bundle drift). */
export function WidgetRoot({ widgets, launch }: WidgetRootProps) {
	const def = widgets.find((w) => w.id === launch.widgetId);
	return (
		<div className="bs-widget" data-widget-id={launch.widgetId}>
			<div className="bs-widget__body">
				{/* i18n-exempt: dev/error fallback for an unregistered widget id; the SDK widget host has no t() infrastructure and this is not part of normal UI. */}
				{def ? def.render() : <p className="bs-widget__missing">Unknown widget: {launch.widgetId}</p>}
			</div>
		</div>
	);
}
