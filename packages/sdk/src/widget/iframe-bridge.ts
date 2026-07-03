/**
 * Widget iframe bridge (Stage 7.3b → OQ-6 reversal). Dashboard widgets render in
 * a sandboxed `<iframe>` (DOM — so they clip to the card, z-order under menus /
 * DevTools, and drag/resize smoothly) instead of a native `WebContentsView`
 * overlay. A sandboxed iframe has NO preload, so the app's `window.brainstorm`
 * is built HERE, over `postMessage` to the dashboard (parent), which proxies each
 * call to the broker — capability-scoped to the widget's app on the main side.
 *
 * The protocol is deliberately tiny: a widget is read-mostly + click-to-open, so
 * it needs only `vaultEntities.list/onChange/queryPattern/querySource`, an intent
 * dispatch, the launch target, and a pause/resume signal. The launch target rides
 * the iframe URL (`?bs-widget=1&bs-widget-id=…`) so `getWidgetLaunch()` resolves
 * synchronously — no async handshake before the app boots.
 *
 * SECURITY: the parent maps each iframe's message `source` → its placement →
 * appId (the iframe can't forge the appId), and the main side checks that app's
 * grants. This is a new cross-sandbox surface — gated on a security review.
 */

import type { WidgetLaunch } from "./index";

/** URL query flag marking an iframe as a widget surface + carrying its target. */
export const WIDGET_QUERY_FLAG = "bs-widget";
export const WIDGET_QUERY_ID = "bs-widget-id";
export const WIDGET_QUERY_BIND = "bs-bind";

/** Widget → dashboard: invoke a proxied service method. */
export type WidgetRpcRequest = {
	bs: "widget-rpc";
	id: number;
	service: "vaultEntities" | "intents";
	method: string;
	args: readonly unknown[];
};
/** Dashboard → widget: the result of a `widget-rpc`. */
export type WidgetRpcResult = {
	bs: "widget-rpc-result";
	id: number;
	ok: boolean;
	value?: unknown;
	error?: string;
};
/** Widget → dashboard: (un)subscribe to vault-entity change notifications. */
export type WidgetSubscribe = { bs: "widget-subscribe" };
export type WidgetUnsubscribe = { bs: "widget-unsubscribe" };
/** Dashboard → widget: a vault-entity change (re-fetch) / pause-resume edge. */
export type WidgetVaultChanged = { bs: "widget-vault-changed" };
export type WidgetVisibility = { bs: "widget-visibility"; visible: boolean };
/** Dashboard → widget: the active theme as flattened `:root { --token: … }` CSS.
 *  The iframe has no preload to apply tokens, so the parent (which owns theme
 *  resolution) hands them across; the child injects them into a `<style>`. */
export type WidgetTheme = { bs: "widget-theme"; css: string };
/** Widget → dashboard: the bridge is up (parent may flush a first change tick). */
export type WidgetReady = { bs: "widget-ready" };

export type WidgetBridgeMessage =
	| WidgetRpcRequest
	| WidgetRpcResult
	| WidgetSubscribe
	| WidgetUnsubscribe
	| WidgetVaultChanged
	| WidgetVisibility
	| WidgetTheme
	| WidgetReady;

/** Style element id the widget theme CSS is injected into (replaced on change). */
const WIDGET_THEME_STYLE_ID = "bs-widget-theme";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Read the widget launch target from the iframe URL, or null when this surface
 *  isn't an iframe widget. Pure — no side effects. */
export function readIframeWidgetLaunch(search: string): WidgetLaunch | null {
	const params = new URLSearchParams(search);
	if (params.get(WIDGET_QUERY_FLAG) !== "1") return null;
	const widgetId = params.get(WIDGET_QUERY_ID);
	if (!widgetId) return null;
	const bind = params.get(WIDGET_QUERY_BIND);
	return { widgetId, ...(bind ? { bind } : {}) };
}

/** The origin of a widget iframe `src` (e.g. `bswidget://recent-notes`). The
 *  dashboard uses it as the explicit `postMessage` targetOrigin AND the inbound
 *  `event.origin` allow-check, so a widget's RPC results (vault data) + theme
 *  are never broadcast to, or accepted from, an unexpected origin. Returns "*"
 *  when the src can't be parsed — degrading to the prior wildcard rather than
 *  dropping messages (a widget that can't talk is worse than a tightened one). */
export function widgetFrameOrigin(src: string): string {
	try {
		const url = new URL(src);
		return `${url.protocol}//${url.host}`;
	} catch {
		return "*";
	}
}

/** Build the iframe URL query the dashboard sets on a widget iframe's `src`. */
export function widgetIframeQuery(launch: WidgetLaunch): string {
	const params = new URLSearchParams({
		[WIDGET_QUERY_FLAG]: "1",
		[WIDGET_QUERY_ID]: launch.widgetId,
	});
	if (launch.bind) params.set(WIDGET_QUERY_BIND, launch.bind);
	return params.toString();
}

/** Install a `postMessage`-backed `window.brainstorm` for a widget iframe and
 *  return its launch target. No-op (returns null) outside a widget iframe — when
 *  there's no parent window or the URL lacks the widget flag. Idempotent: a second
 *  call returns the already-resolved launch without re-installing. */
export function installWidgetIframeBridge(): WidgetLaunch | null {
	if (typeof window === "undefined" || window.parent === window) return null;
	const launch = readIframeWidgetLaunch(window.location.search);
	if (!launch) return null;
	const w = window as unknown as { brainstorm?: unknown };
	if (w.brainstorm) return launch;

	const parent = window.parent;
	let nextId = 1;
	const pending = new Map<number, Pending>();
	const changeListeners = new Set<() => void>();

	// Pin replies to the dashboard's real origin once we've seen a verified
	// message from it (MDN: reply to the received `event.origin`, never "*").
	// The only sends before the first inbound message are the no-data
	// `widget-ready` ping, so RPC requests (which carry intent payloads) always
	// reach the dashboard at its exact origin.
	let parentOrigin = "*";
	const post = (msg: WidgetBridgeMessage): void => parent.postMessage(msg, parentOrigin);

	const rpc = (
		service: WidgetRpcRequest["service"],
		method: string,
		args: unknown[],
	): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			post({ bs: "widget-rpc", id, service, method, args });
		});

	window.addEventListener("message", (event: MessageEvent) => {
		if (event.source !== parent) return;
		if (parentOrigin === "*" && typeof event.origin === "string" && event.origin.includes("://")) {
			parentOrigin = event.origin;
		}
		const msg = event.data as WidgetBridgeMessage | undefined;
		if (!msg || typeof msg !== "object") return;
		if (msg.bs === "widget-rpc-result") {
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			if (msg.ok) p.resolve(msg.value);
			else p.reject(new Error(msg.error ?? "widget rpc failed"));
		} else if (msg.bs === "widget-vault-changed") {
			for (const listener of changeListeners) listener();
		} else if (msg.bs === "widget-theme") {
			let style = document.getElementById(WIDGET_THEME_STYLE_ID) as HTMLStyleElement | null;
			if (!style) {
				style = document.createElement("style");
				style.id = WIDGET_THEME_STYLE_ID;
				document.head.appendChild(style);
			}
			style.textContent = msg.css;
		} else if (msg.bs === "widget-visibility") {
			if (document.documentElement) {
				document.documentElement.dataset.appHidden = msg.visible ? "false" : "true";
			}
			window.dispatchEvent(
				new CustomEvent("brainstorm:app-visibility", { detail: { visible: msg.visible } }),
			);
		}
	});

	const vaultEntities = {
		/** `query` ({types, limit}) narrows the payload server-side — without it
		 *  the bridge ships the app's entire readable entity list (F-384). */
		list: (query?: unknown) => rpc("vaultEntities", "list", query === undefined ? [] : [query]),
		queryPattern: (pattern: unknown) => rpc("vaultEntities", "queryPattern", [pattern]),
		querySource: (source: unknown) => rpc("vaultEntities", "querySource", [source]),
		onChange: (listener: () => void) => {
			changeListeners.add(listener);
			if (changeListeners.size === 1) {
				post({ bs: "widget-subscribe" });
			}
			return {
				unsubscribe: () => {
					changeListeners.delete(listener);
					if (changeListeners.size === 0) {
						post({ bs: "widget-unsubscribe" });
					}
				},
			};
		},
	};

	const brainstorm = {
		launch: {
			reason: "widget" as const,
			widgetId: launch.widgetId,
			...(launch.bind ? { bind: launch.bind } : {}),
		},
		services: {
			vaultEntities,
			intents: { dispatch: (intent: unknown) => rpc("intents", "dispatch", [intent]) },
		},
	};
	(window as unknown as { brainstorm: unknown }).brainstorm = brainstorm;
	post({ bs: "widget-ready" });
	return launch;
}
