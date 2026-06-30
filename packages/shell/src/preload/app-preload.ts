/**
 * App preload — runs in every app renderer's preload context per
 *  §Isolation:
 *
 *   - `nodeIntegration: false`
 *   - `contextIsolation: true`
 *   - `sandbox: true`
 *   - Preload script that exposes only the SDK's `brainstorm` global.
 *
 * Reads:
 *   - `--brainstorm-app-id=...` (stamps every envelope; cannot be forged
 *     by app JS — set by trusted main process at BrowserWindow create).
 *   - `--brainstorm-handshake=...` (base64 JSON of `AppHandshake`).
 *
 * Exposes `window.brainstorm` via `contextBridge` — the SDK runtime built
 * from `@brainstorm/sdk` `buildRuntime(...)`.
 *
 * Ordering is load-bearing: the bridge is exposed BEFORE the theme/chrome
 * styles are pushed. A DOM-side failure in styling must never prevent
 * `contextBridge.exposeInMainWorld` from running — Notes / Files /
 * Database fail to boot if `window.brainstorm` is missing.
 */

import {
	type Bridge,
	buildRuntimeWithEmitter,
	decodeHandshake,
	newMessageId,
} from "@brainstorm/sdk";
import {
	APP_DRAG_LEAVE_CHANNEL,
	APP_DRAG_OVER_CHANNEL,
	APP_DROP_CHANNEL,
	APP_TAB_COMMAND_CHANNEL,
	APP_WEBVIEW_EVENT_CHANNEL,
	CROSS_APP_DRAG_LEAVE_EVENT,
	CROSS_APP_DRAG_OVER_EVENT,
	CROSS_APP_DROP_EVENT,
} from "@brainstorm/sdk-types";
import type {
	DragOverNotice,
	DropDelivery,
	Entity,
	EntityQuery,
	FormatContext,
	Intent,
	SpellcheckBridge,
	SpellcheckContext,
	TabCommand,
	WebViewEvent,
} from "@brainstorm/sdk-types";
import { MOTION_DURATION_ENTRANCE_MS } from "@brainstorm/sdk/motion";
import { DEFAULT_THEME, flattenTokens, isThemeName, themes } from "@brainstorm/tokens";
import { contextBridge, ipcRenderer } from "electron";
import { setAppLockOverlay } from "./app-lock-overlay";
import { APP_THEME_STYLE_ID, appIconVarPairs, buildAppIconVarsCss } from "./app-theme";
import { createEntitySubscriptionHub } from "./entities-subscribe";

const BROKER_CHANNEL = "broker:dispatch";

function readArg(prefix: string): string | null {
	for (const arg of process.argv) {
		if (typeof arg === "string" && arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return null;
}

const appId = readArg("--brainstorm-app-id=");
const handshakeEncoded = readArg("--brainstorm-handshake=");
const themeArg = readArg("--brainstorm-theme=");
const buildArg = readArg("--brainstorm-build=");

if (!appId || !handshakeEncoded) {
	throw new Error(
		"app-preload: missing --brainstorm-app-id / --brainstorm-handshake. " +
			"This preload must only run via AppLauncher, which sets these arguments.",
	);
}

const handshake = decodeHandshake(handshakeEncoded);

if (handshake.app.id !== appId) {
	throw new Error(
		`app-preload: handshake.app.id (${handshake.app.id}) does not match --brainstorm-app-id (${appId}).`,
	);
}

// Build provenance, logged in the app's OWN DevTools console on every
// boot. This is the one-second answer to "is my fix actually running?"
// — the question that turned a one-line bug into an 8-round guessing
// loop because nothing surfaced that the renderer was serving a
// pre-fix bundle. Compare against the shell's `[shell] launch …` /
// `[seed] reinstalled …` line: same-but-old ⇒ shell not restarted;
// different ⇒ stale window.
console.info(`[app:${appId}] build ${buildArg ?? "unknown"} v${handshake.app.version}`);

// The shared component CSS (aliases / glass / buttons / find-bar / …) is
// bundled into the app at build time via `import "@brainstorm/sdk/app-
// theme.css"` in the app's TS entry. The only piece that varies per app
// is the `.app-header__icon` chip face — preload pushes the four
// `--app-icon-*` custom properties the shared CSS reads.
const appIconVarsCss = buildAppIconVarsCss(appId);
const appIconVars = appIconVarPairs(appId);

// Once the renderer starts navigating away (tab close / dev reload), the main
// process unregisters this webContents from the renderer-identity registry, so
// any in-flight or late broker call comes back "app identity verification
// failed". The result can't be consumed by a page that's being torn down, and
// the SDK service proxy turns that `ok:false` into a throw — which surfaces as
// an "Uncaught (in promise)" in the dying page. Suppress calls once `pagehide`
// fires by returning a never-settling promise: safe because it only triggers
// during real teardown, so it can never mask a genuine identity failure in a
// live window.
let unloading = false;
addEventListener("pagehide", () => {
	unloading = true;
});

const bridge: Bridge = {
	app: appId,
	dispatch: async (envelope) => {
		if (unloading) return new Promise<never>(() => {});
		const wire = {
			v: 1,
			msg: newMessageId(),
			app: appId,
			service: envelope.service,
			method: envelope.method,
			args: envelope.args,
			caps: envelope.caps,
		};
		let reply:
			| { v: number; msg: string; ok: true; value: unknown }
			| {
					v: number;
					msg: string;
					ok: false;
					error: { kind: string; message: string } & Record<string, unknown>;
			  };
		try {
			reply = (await ipcRenderer.invoke(BROKER_CHANNEL, wire)) as typeof reply;
		} catch (error) {
			// The IPC channel can tear down mid-call during navigation; swallow
			// only while unloading, otherwise surface the genuine failure.
			if (unloading) return new Promise<never>(() => {});
			throw error;
		}
		if (reply.ok) return { ok: true, value: reply.value };
		return { ok: false, error: reply.error };
	},
};

const { runtime, emitter, setLocale, setFormat } = buildRuntimeWithEmitter({ handshake, bridge });

// 12.15 — live locale propagation. A freshly-launched window already renders
// in the right language (the locale rides the handshake); this listener carries
// a runtime language switch into the running app so `runtime.locale` updates and
// every `onLocaleChange` handler fires — the sibling of `app:theme-changed`.
// Channel must match `APP_LOCALE_CHANGED_CHANNEL` in `main/ipc/dashboard-handlers.ts`.
ipcRenderer.on("app:locale-changed", (_event, locale: string) => {
	if (typeof locale === "string" && locale.length > 0) setLocale(locale);
});

// Stage 13.8 — conceal this app's content when the vault locks (defense-in-
// depth). The main process also hides the whole app window (`base.hide()`, the
// primary mask), but a sandboxed app window has no lock screen of its own, so
// if that hide ever races / fails the user's data would stay visible. The
// main-side `onLockChange` pushes this per app tab — the dashboard's
// `BrowserWindow` broadcast can't reach a `BaseWindow`-hosted app view. Channel
// must match `APP_LOCK_CHANGED_CHANNEL`.
ipcRenderer.on("app:lock-changed", (_event, payload: { locked?: boolean }) => {
	setAppLockOverlay(payload?.locked === true);
});

// 12.15 slice 15f — live regional-format propagation. The format context rides
// the handshake for the first frame; this carries a runtime Settings → Regional
// change into the running app so `runtime.format` updates and every
// `onFormatChange` handler fires. Channel must match `APP_FORMAT_CHANGED_CHANNEL`.
ipcRenderer.on("app:format-changed", (_event, format: FormatContext) => {
	if (format && typeof format === "object") setFormat(format);
});

// Cross-app `intent.open` delivery to a running app window. The
// IntentsBus pushes here whenever the destination app was already
// open — apps subscribed via `runtime.on("intent", ...)` re-react
// without needing a full relaunch. Channel name + payload shape mirror
// `APP_INTENT_CHANNEL` from `main/intents/intent-broadcast.ts`.
ipcRenderer.on("app:intent", (_event, intent: Intent) => {
	if (!intent || typeof intent !== "object") return;
	try {
		emitter.emit({ type: "intent", intent });
	} catch (error) {
		console.error("[brainstorm] app:intent lifecycle emit failed:", error);
	}
});

// Override `properties.onChange` with the real IPC-backed implementation
// so apps re-fetch the catalog when external surfaces (Settings → Data,
// sibling apps, future sync peers) mutate it. `app:properties-changed`
// is a bare staleness signal — the app calls `properties.list()` to
// pull the authoritative snapshot through the broker (re-running the
// capability check).
const propertyChangeListeners = new Set<() => void>();
ipcRenderer.on("app:properties-changed", () => {
	for (const listener of propertyChangeListeners) {
		try {
			listener();
		} catch (error) {
			console.error("[brainstorm] properties onChange listener threw:", error);
		}
	}
});

// Same pattern for `vaultEntities.onChange` — fires whenever a note
// write reaches the storage worker. Graph + Database subscribe and
// re-`list()` to repaint mention/link edges without polling. The
// channel must match `APP_VAULT_ENTITIES_CHANGED_CHANNEL` from
// `main/entities/vault-entities-broadcast.ts`.
const vaultEntitiesChangeListeners = new Set<() => void>();
ipcRenderer.on("app:vault-entities-changed", () => {
	for (const listener of vaultEntitiesChangeListeners) {
		try {
			listener();
		} catch (error) {
			console.error("[brainstorm] vaultEntities onChange listener threw:", error);
		}
	}
	entitySubscriptionHub.notifyChanged();
});

// 9.12.5 — `entities.subscribe(query, onUpdate)` push subscriptions: the
// same staleness channel, but query-shaped. Each push re-runs the app's
// own `entities.query` THROUGH THE BROKER (the capability check re-runs;
// the broadcast carries no authority) and only fires `onUpdate` when the
// result set actually changed.
const entitySubscriptionHub = createEntitySubscriptionHub<EntityQuery, Entity>(
	(query) => runtime.services.entities.query(query),
	(error) => console.error("[brainstorm] entities.subscribe push failed:", error),
);

// 9.10 — `files.watch` event delivery. The shell-side files service
// sends one of these per subscription per change; the preload dispatches
// to the per-subscription callback registered when the app called
// `files.watch(handle, onChange)`. Channel name must match
// `APP_FILES_WATCH_CHANNEL` in `main/files/files-service.ts`.
type FilesWatchEvent = { subscriptionId: string; handleId: string; kind: string };
const filesWatchListeners = new Map<string, (event: { kind: string }) => void>();
ipcRenderer.on("app:files-watch", (_event, payload: FilesWatchEvent) => {
	if (!payload || typeof payload.subscriptionId !== "string") return;
	const listener = filesWatchListeners.get(payload.subscriptionId);
	if (!listener) return;
	try {
		listener({ kind: payload.kind });
	} catch (error) {
		console.error("[brainstorm] files watch listener threw:", error);
	}
});

// Browser-2 — `webView` metadata-event delivery. The shell-side WebView host
// service fans one of these per tab metadata change; the preload dispatches to
// every `services.webView.onEvent` listener the chrome registered. Channel must
// match `APP_WEBVIEW_EVENT_CHANNEL` in `@brainstorm/sdk-types`.
const webViewEventListeners = new Set<(event: WebViewEvent) => void>();
ipcRenderer.on(APP_WEBVIEW_EVENT_CHANNEL, (_event, payload: WebViewEvent) => {
	if (!payload || typeof payload !== "object" || typeof payload.kind !== "string") return;
	for (const listener of webViewEventListeners) {
		try {
			listener(payload);
		} catch (error) {
			console.error("[brainstorm] webView event listener threw:", error);
		}
	}
});

// B11.16c — spellcheck suggestion context. The shell pushes one of these when
// the user right-clicks a misspelled word in an editable element; the renderer
// (via the shared SDK menu mount) renders the suggestions through fancy-menus.
// Channel must match `SPELLCHECK_CONTEXT_CHANNEL` in `main/web/spellcheck.ts`.
const SPELLCHECK_CONTEXT_CHANNEL = "app:spellcheck-context";
const SPELLCHECK_APPLY_CHANNEL = "app:spellcheck-apply";
const spellcheckContextListeners = new Set<(ctx: SpellcheckContext) => void>();
ipcRenderer.on(SPELLCHECK_CONTEXT_CHANNEL, (_event, ctx: SpellcheckContext) => {
	if (!ctx || typeof ctx !== "object" || typeof ctx.word !== "string") return;
	for (const listener of spellcheckContextListeners) {
		try {
			listener(ctx);
		} catch (error) {
			console.error("[brainstorm] spellcheck context listener threw:", error);
		}
	}
});

const spellcheckDictionary = async (
	method: "addWord" | "removeWord" | "listWords",
	cap: string,
	word?: string,
): Promise<string[]> => {
	const reply = await bridge.dispatch({
		service: "spellcheck",
		method,
		args: word === undefined ? [] : [{ word }],
		caps: [cap],
	});
	if (!reply.ok) throw new Error(reply.error.message);
	return Array.isArray(reply.value) ? (reply.value as string[]) : [];
};

const spellcheck: SpellcheckBridge = {
	onContext: (listener) => {
		spellcheckContextListeners.add(listener);
		return () => {
			spellcheckContextListeners.delete(listener);
		};
	},
	replace: (replacement) => {
		if (typeof replacement === "string" && replacement.length > 0) {
			ipcRenderer.send(SPELLCHECK_APPLY_CHANNEL, replacement);
		}
	},
	addWord: (word) => spellcheckDictionary("addWord", "editor.spellcheck.write", word),
	removeWord: (word) => spellcheckDictionary("removeWord", "editor.spellcheck.write", word),
	ignoreWord: async (word) => {
		await bridge.dispatch({
			service: "spellcheck",
			method: "ignoreWord",
			args: [{ word }],
			caps: ["editor.spellcheck.write"],
		});
	},
	listWords: () => spellcheckDictionary("listWords", "editor.spellcheck.read"),
};

// 9.3.2c — inbound leg of the Y.Doc transport. The shell fans a
// canonical-applied delta here so a second window editing the same
// entity converges live. One listener; per-entity dispatch through the
// sink map the renderer populates via `ydoc.onRemote`. An entity with
// no live sink (the doc isn't open in this renderer) is a silent no-op.
// Channel must match `APP_YDOC_REMOTE_CHANNEL` in
// `main/entities/ydoc-remote-broadcast.ts`.
//
// The Y.Doc replica + resolver core live in the RENDERER (not here):
// `contextBridge.exposeInMainWorld` structured-clones return values, and
// a Y.Doc instance (custom class with prototypes + internal observers)
// cannot survive that clone — every `window.brainstorm.ydoc.resolve(id)`
// call would die synchronously with `An object could not be cloned.` So
// the preload only exposes (a) the IPC-cloneable load/apply/close
// primitives on `services.entities`, and (b) a per-entity subscription
// that fires the renderer's callback with the base64 wire payload. The
// renderer builds the resolver locally with those.
const ydocRemoteSinks = new Map<string, (updateB64: string) => void>();
ipcRenderer.on(
	"app:ydoc-remote",
	(_event, payload: { entityId?: unknown; updateB64?: unknown }) => {
		if (!payload || typeof payload.entityId !== "string" || typeof payload.updateB64 !== "string") {
			return;
		}
		const sink = ydocRemoteSinks.get(payload.entityId);
		if (!sink) return;
		try {
			sink(payload.updateB64);
		} catch (error) {
			console.error("[brainstorm] ydoc-remote apply failed:", error);
		}
	},
);

function ydocOnRemote(entityId: string, callback: (updateB64: string) => void): () => void {
	ydocRemoteSinks.set(entityId, callback);
	return () => {
		if (ydocRemoteSinks.get(entityId) === callback) {
			ydocRemoteSinks.delete(entityId);
		}
	};
}

const ydoc = { onRemote: ydocOnRemote };

const augmentedRuntime = {
	...runtime,
	ydoc,
	spellcheck,
	services: {
		...runtime.services,
		properties: {
			...runtime.services.properties,
			onChange: (listener: () => void) => {
				propertyChangeListeners.add(listener);
				return {
					unsubscribe: () => {
						propertyChangeListeners.delete(listener);
					},
				};
			},
		},
		vaultEntities: {
			...runtime.services.vaultEntities,
			onChange: (listener: () => void) => {
				vaultEntitiesChangeListeners.add(listener);
				return {
					unsubscribe: () => {
						vaultEntitiesChangeListeners.delete(listener);
					},
				};
			},
		},
		entities: {
			...runtime.services.entities,
			// 9.12.5 — overlay the SDK's no-op `subscribe` with the real
			// staleness-channel-backed implementation (see the hub above).
			subscribe: (query: EntityQuery, onUpdate: (entities: Entity[]) => void) =>
				entitySubscriptionHub.subscribe(query, onUpdate),
		},
		webView: {
			...runtime.services.webView,
			// Browser-2 — overlay `onEvent` with the broadcast-channel-backed
			// shape so the chrome receives tab metadata events. The SDK default
			// proxy can only mint the call path (request/reply broker); event
			// fan-out arrives on `APP_WEBVIEW_EVENT_CHANNEL`.
			onEvent: (listener: (event: WebViewEvent) => void) => {
				webViewEventListeners.add(listener);
				return () => {
					webViewEventListeners.delete(listener);
				};
			},
		},
		files: {
			...runtime.services.files,
			// 9.10 — overlay `watch` with the broadcast-channel-backed shape
			// so the app receives change events. The SDK default proxy can
			// only mint the subscription (request/reply broker). We mint
			// via that proxy, then register the listener against the
			// returned `subscriptionId`. Unsubscribe calls `files.unwatch`
			// over the broker, then removes the listener.
			watch: async (handle: { handleId: string }, onChange: (event: { kind: string }) => void) => {
				const reply = await bridge.dispatch({
					service: "files",
					method: "watch",
					args: [{ handleId: handle.handleId }],
					caps: ["files.read"],
				});
				if (!reply.ok) {
					throw new Error(reply.error.message);
				}
				const subscriptionId = (reply.value as { subscriptionId: string }).subscriptionId;
				filesWatchListeners.set(subscriptionId, onChange);
				return {
					unsubscribe: () => {
						filesWatchListeners.delete(subscriptionId);
						void bridge.dispatch({
							service: "files",
							method: "unwatch",
							args: [{ subscriptionId }],
							caps: ["files.read"],
						});
					},
				};
			},
		},
	},
};

try {
	contextBridge.exposeInMainWorld("brainstorm", augmentedRuntime);
} catch (error) {
	console.error("[brainstorm] failed to expose brainstorm bridge", error);
}

// ── Theme + chrome (everything below is best-effort / DOM-side) ──────
//
// Tokens + the centralized `.app-header` rule land via TWO channels,
// each independently wrapped in try/catch so a single DOM failure
// can't propagate:
//
//   1. inline CSS variables on `document.documentElement.style` —
//      fastest path, lets the first paint already carry the values.
//   2. a managed `<style>` element re-applied on DOMContentLoaded —
//      covers the case where the sandboxed preload's documentElement
//      is replaced by the parser. Without this fallback every
//      `var(--space-N)` in app CSS collapses to invalid and the
//      database app's paddings disappeared.

const PLATFORM = process.platform;
const IS_MAC = PLATFORM === "darwin";
const IS_WIN = PLATFORM === "win32";
const IS_LINUX = PLATFORM === "linux";

const CHROME_PAD_DEFAULT = "12px";
const CHROME_PAD_MAC_LEFT = "86px";
const CHROME_PAD_WIN_RIGHT = "150px";
const CHROME_PAD_LINUX_RIGHT = "120px";
const APP_HEADER_HEIGHT = "44px";

const STYLE_EL_TOKENS = "brainstorm-tokens";
const STYLE_EL_CHROME = "brainstorm-chrome";

let lastTokensCss = "";
let lastChromeCss = "";

// Window-chrome state the header padding derives from. Fullscreen hides the
// macOS traffic lights; a visible tab strip moves the OS window controls into
// the strip row ABOVE the app, so the header below stops reserving their gutter.
let chromeFullscreen = false;
let chromeStripVisible = false;

function whenDocumentReady(fn: () => void): void {
	if (typeof document === "undefined") return;
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", fn, { once: true });
	} else {
		fn();
	}
}

// Stamp the OS on the document root so theme CSS can scope platform-specific
// chrome — notably the themed scrollbars in `app-theme.css`, which only restyle
// Windows/Linux (macOS keeps its native auto-hiding overlay scrollbars). Mirrors
// `chrome-preload.ts` and the dashboard's `data-platform`.
function stampPlatform(): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (root) root.dataset.platform = PLATFORM;
}

// The frozen `data-bs-region` app-frame hooks (the shared `.app-header`
// chrome — `@brainstorm/sdk-types` `STYLE_HOOK_REGIONS`). Stamped from the
// single preload chokepoint so StylePack CSS can target stable anchors in
// every app window without each of the 18 apps hand-writing the attribute.
// Literals are inlined (not imported) to keep the preload bundle isolated;
// the `style-hooks.guard` test pins them against the contract.
const APP_FRAME_HOOKS: ReadonlyArray<readonly [string, string]> = [
	[".app-header", "app-header"],
	[".app-header__left", "app-header-left"],
	[".app-header__right", "app-header-right"],
	[".app-header__title", "app-header-title"],
];

/** Stamp the app-frame hooks. Returns `false` until the header exists so
 *  the caller knows to keep watching. Idempotent — never overwrites a hook
 *  an app set itself. */
function stampAppFrameHooks(): boolean {
	if (typeof document === "undefined") return true;
	if (!document.querySelector(".app-header")) return false;
	for (const [selector, region] of APP_FRAME_HOOKS) {
		for (const el of document.querySelectorAll(selector)) {
			if (!el.getAttribute("data-bs-region")) el.setAttribute("data-bs-region", region);
		}
	}
	return true;
}

/** Stamp now if the header is up; otherwise watch for it once and stamp on
 *  first appearance, then disconnect (React apps mount the header after
 *  DOMContentLoaded). The observer self-cleans — no lingering watcher. */
function installAppFrameHooks(): void {
	if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
	if (stampAppFrameHooks()) return;
	const target = document.body ?? document.documentElement;
	if (!target) return;
	const observer = new MutationObserver(() => {
		if (stampAppFrameHooks()) observer.disconnect();
	});
	observer.observe(target, { childList: true, subtree: true });
}

function applyInlineVars(pairs: Iterable<[string, string]>): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (!root) return;
	for (const [key, value] of pairs) {
		root.style.setProperty(key, value);
	}
}

function upsertStyleEl(id: string, css: string): void {
	if (typeof document === "undefined") return;
	const parent = document.head ?? document.body ?? document.documentElement;
	if (!parent) return;
	let el = document.getElementById(id) as HTMLStyleElement | null;
	if (!el) {
		el = document.createElement("style");
		el.id = id;
		parent.appendChild(el);
	}
	el.textContent = css;
}

function reapplyAll(): void {
	if (lastTokensCss) {
		try {
			upsertStyleEl(STYLE_EL_TOKENS, lastTokensCss);
		} catch (error) {
			console.error("[brainstorm] failed to upsert tokens style:", error);
		}
	}
	if (lastChromeCss) {
		try {
			upsertStyleEl(STYLE_EL_CHROME, lastChromeCss);
		} catch (error) {
			console.error("[brainstorm] failed to upsert chrome style:", error);
		}
	}
	try {
		upsertStyleEl(APP_THEME_STYLE_ID, appIconVarsCss);
	} catch (error) {
		console.error("[brainstorm] failed to upsert app-icon vars:", error);
	}
}

// The committed theme this window is on — recorded on every apply so a
// transient preview (9.9.6) can revert by re-applying it (which re-sets
// every token inline, overwriting the preview overrides).
let committedTheme: string | null = themeArg;

function applyThemeByName(name: string | null): void {
	try {
		const resolved = isThemeName(name) ? name : DEFAULT_THEME;
		committedTheme = resolved;
		const tokens = flattenTokens(themes[resolved]);
		const pairs: [string, string][] = [];
		const lines: string[] = [];
		for (const [key, value] of Object.entries(tokens)) {
			// Defence in depth — `flattenTokens` only emits well-formed
			// `--token-name` keys, but a bad theme entry shouldn't be able
			// to write arbitrary CSS into the document.
			if (key.startsWith("--") && /^[a-zA-Z0-9_-]+$/.test(key.slice(2))) {
				pairs.push([key, value]);
				lines.push(`\t${key}: ${value};`);
			}
		}
		applyInlineVars(pairs);
		const scheme = themeColorScheme(themes[resolved].color.background.primary);
		// Paint `html`/`body` directly from the theme so the first frame matches
		// `BrowserWindow.backgroundColor`. Without this, the app's own stylesheet
		// is the only thing that paints the body — and it loads async via
		// `<link>`, so the renderer flashes the browser-default white between
		// first paint and stylesheet apply. The shell's `<style id="brainstorm-
		// tokens">` is injected during preload init (before HTML parse), so this
		// rule wins over the browser default but loses to the app's stylesheet
		// once it lands.
		lastTokensCss = `:root {\n${lines.join("\n")}\n}\nhtml, body {\n\tbackground-color: var(--color-background-primary);\n\tcolor: var(--color-text-primary);\n\tcolor-scheme: ${scheme};\n}`;
		upsertStyleEl(STYLE_EL_TOKENS, lastTokensCss);
		// Notify renderer-side surfaces that mirror the theme into a context the
		// CSS cascade can't reach on its own — chiefly the opaque-origin BP-block
		// embed frames, which can't read this document's `:root` and need the
		// resolved vars handed across their transport. Fired after the vars land.
		try {
			window.dispatchEvent(new CustomEvent("brainstorm:theme-changed", { detail: { scheme } }));
		} catch {
			// `window`/CustomEvent unavailable in a non-DOM preload context — moot.
		}
	} catch (error) {
		console.error("[brainstorm] applyThemeByName failed:", error);
	}
}

// `dark` / `light` is derived from the theme's `background.primary` luminance
// so we don't have to maintain a parallel ThemeName → scheme map. ≤ 0.5
// luma = dark, > 0.5 = light. Falls back to `dark` for any colour string the
// regex can't parse — matches the DefaultDark fallback elsewhere in the file.
function themeColorScheme(color: string): "dark" | "light" {
	const hex = color.trim().match(/^#([0-9a-f]{6})$/i);
	if (hex) {
		const n = Number.parseInt(hex[1] ?? "", 16);
		const r = (n >> 16) & 0xff;
		const g = (n >> 8) & 0xff;
		const b = n & 0xff;
		return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? "light" : "dark";
	}
	const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
	if (rgb) {
		const r = Number.parseInt(rgb[1] ?? "0", 10);
		const g = Number.parseInt(rgb[2] ?? "0", 10);
		const b = Number.parseInt(rgb[3] ?? "0", 10);
		return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? "light" : "dark";
	}
	return "dark";
}

// Window-chrome padding for the app's drag header — centralized so every
// app gets macOS / Windows / Linux insets for free by applying the
// `.app-header` class. No per-app duplication.
//
//   macOS, windowed → 86px left (clear the traffic-light dead zone)
//   macOS, fullscreen → 12px left (lights are hidden, reclaim the space)
//   Windows, windowed → 150px right (titleBarOverlay min/max/close strip)
//   Linux, windowed → 120px right (most WMs keep controls on the right)
//   Any other case → 12px
//
// When the tab strip is visible the OS controls live in the strip row, not over
// this header, so the gutter collapses to the default on every platform.
function applyChrome(): void {
	try {
		const reserveControls = !chromeFullscreen && !chromeStripVisible;
		const padLeft = IS_MAC && reserveControls ? CHROME_PAD_MAC_LEFT : CHROME_PAD_DEFAULT;
		let padRight = CHROME_PAD_DEFAULT;
		if (reserveControls) {
			if (IS_WIN) padRight = CHROME_PAD_WIN_RIGHT;
			else if (IS_LINUX) padRight = CHROME_PAD_LINUX_RIGHT;
		}
		applyInlineVars([
			["--app-header-pad-left", padLeft],
			["--app-header-pad-right", padRight],
			["--app-header-height", APP_HEADER_HEIGHT],
		]);
		lastChromeCss = `:root {
\t--app-header-pad-left: ${padLeft};
\t--app-header-pad-right: ${padRight};
\t--app-header-height: ${APP_HEADER_HEIGHT};
}
.app-header {
\theight: var(--app-header-height);
\tpadding-left: var(--app-header-pad-left);
\tpadding-right: var(--app-header-pad-right);
}
.app-header button,
.app-header a,
.app-header input,
.app-header select,
.app-header textarea,
.app-header label,
.app-header [role="button"],
.app-header [tabindex] {
\t-webkit-app-region: no-drag;
}`;
		upsertStyleEl(STYLE_EL_CHROME, lastChromeCss);
	} catch (error) {
		console.error("[brainstorm] applyChrome failed:", error);
	}
}

applyThemeByName(themeArg);
applyChrome();
try {
	applyInlineVars(appIconVars);
} catch (error) {
	console.error("[brainstorm] failed to inline app-icon vars:", error);
}
try {
	upsertStyleEl(APP_THEME_STYLE_ID, appIconVarsCss);
} catch (error) {
	console.error("[brainstorm] failed to upsert app-icon vars:", error);
}
stampPlatform();
whenDocumentReady(stampPlatform);
whenDocumentReady(reapplyAll);
whenDocumentReady(installAppFrameHooks);

// App-window entrance animation — a quick opacity fade on the first paint so
// a freshly-launched window doesn't appear out of nothing. The main-process
// `ready-to-show` gate already keeps the OS-level paint pinned to the theme
// background colour; this CSS runs once the renderer takes over drawing pixels.
//
// Pure fade, NO scale: the window is revealed on `ready-to-show`, which fires
// the instant the entrance is armed (body at the `from` keyframe). A `scale()`
// `from` value insets the body and exposes a window-background frame around it
// for the animation's duration — that bordered, blank-then-grow rectangle read
// as a "flash with borders" on every launch (worst during rapid back-to-back
// launches). Fading opacity over the matched theme background has no such edge.
//
// Two phases: `entering-cold` for a fresh-process boot and `entering-warm` for
// the keep-alive re-show path planned for later (already wired so future
// warm-launch support flips the dataset). Both are opacity-only today; the
// names are kept so the two flows can diverge later without a CSS rename. The
// global reduced-motion cover in `styles.css` collapses both to instant for
// users who request reduced motion; here we add an in-preload fallback so
// non-shell hosts (test harness, ad-hoc embedding) honour it too.
const APP_ENTRANCE_STYLE_ID = "brainstorm-app-entrance";

const LaunchPhase = {
	EnteringCold: "entering-cold",
	EnteringWarm: "entering-warm",
	Ready: "ready",
} as const;
type LaunchPhase = (typeof LaunchPhase)[keyof typeof LaunchPhase];

const ENTRANCE_CSS = `
:root[data-bs-launch-phase="${LaunchPhase.EnteringCold}"] body {
\tanimation: bs-app-entrance-cold ${MOTION_DURATION_ENTRANCE_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
:root[data-bs-launch-phase="${LaunchPhase.EnteringWarm}"] body {
\tanimation: bs-app-entrance-warm ${MOTION_DURATION_ENTRANCE_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes bs-app-entrance-cold {
\tfrom { opacity: 0; }
\tto { opacity: 1; }
}
@keyframes bs-app-entrance-warm {
\tfrom { opacity: 0; }
\tto { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
\t:root[data-bs-launch-phase="${LaunchPhase.EnteringCold}"] body,
\t:root[data-bs-launch-phase="${LaunchPhase.EnteringWarm}"] body {
\t\tanimation: none;
\t}
\t*,
\t*::before,
\t*::after {
\t\tanimation-duration: 0.01ms !important;
\t\tanimation-iteration-count: 1 !important;
\t\ttransition-duration: 0.01ms !important;
\t\tscroll-behavior: auto !important;
\t}
}
`;

function applyEntrancePhase(phase: LaunchPhase): void {
	try {
		const root = document.documentElement;
		if (!root) return;
		root.dataset.bsLaunchPhase = phase;
	} catch (error) {
		console.error("[brainstorm] applyEntrancePhase failed:", error);
	}
}

let entranceReadyTimer: ReturnType<typeof setTimeout> | null = null;

function stampEntrance(): void {
	try {
		upsertStyleEl(APP_ENTRANCE_STYLE_ID, ENTRANCE_CSS);
	} catch (error) {
		console.error("[brainstorm] failed to upsert entrance style:", error);
	}
	// Cold launch is the only flow today; the warm-launch phase is reserved
	// for the future keep-alive re-show path so adopting code can flip the
	// attribute without changing the CSS contract.
	applyEntrancePhase(LaunchPhase.EnteringCold);
	if (entranceReadyTimer !== null) clearTimeout(entranceReadyTimer);
	entranceReadyTimer = setTimeout(() => {
		entranceReadyTimer = null;
		applyEntrancePhase(LaunchPhase.Ready);
	}, MOTION_DURATION_ENTRANCE_MS + 40);
	if (typeof window !== "undefined") {
		window.addEventListener("beforeunload", () => {
			if (entranceReadyTimer !== null) {
				clearTimeout(entranceReadyTimer);
				entranceReadyTimer = null;
			}
		});
	}
}

whenDocumentReady(stampEntrance);

// Pair with the `body.is-booting` guard in `app-theme.css`. The class
// ships in every app's index.html so it applies during the very first
// style resolution; here we clear it after the first paint so toggles
// after boot animate normally. Double rAF guarantees a paint happened
// with the persisted-state hydration applied and transitions still
// suppressed — without it, the renderer can batch the hydration mutation
// with the class removal into a single style recalc and animate anyway.
whenDocumentReady(() => {
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			try {
				document.body?.classList.remove("is-booting");
			} catch (error) {
				console.error("[brainstorm] failed to clear is-booting:", error);
			}
		});
	});
});

ipcRenderer.on("app:theme-changed", (_event, name: string) => {
	applyThemeByName(name);
});

// Transient cross-surface theme preview (9.9.6). The payload is already
// sanitized shell-side (canonical tokens + safe values); we still apply via
// CSSOM `setProperty` (never string-built) so a value can't break out —
// defence in depth. `null` reverts by re-applying the committed theme.
ipcRenderer.on("app:theme-preview", (_event, payload: { vars?: Record<string, string> } | null) => {
	if (typeof document === "undefined") return;
	if (!payload) {
		applyThemeByName(committedTheme);
		return;
	}
	const root = document.documentElement;
	for (const [key, value] of Object.entries(payload.vars ?? {})) {
		root.style.setProperty(key, value);
	}
});

ipcRenderer.on("window:fullscreen-changed", (_event, isFullscreen: boolean) => {
	chromeFullscreen = isFullscreen;
	whenDocumentReady(() => {
		const root = document.documentElement;
		if (root) root.dataset.fullscreen = isFullscreen ? "true" : "false";
	});
	applyChrome();
});

// A visible tab strip moves the OS window controls into the strip row above the
// app, so the app header no longer reserves the traffic-light / controls gutter.
ipcRenderer.on("window:strip-visible-changed", (_event, stripVisible: boolean) => {
	chromeStripVisible = stripVisible;
	whenDocumentReady(() => {
		const root = document.documentElement;
		if (root) root.dataset.stripVisible = stripVisible ? "true" : "false";
	});
	applyChrome();
});

// Window visibility (parked/hidden vs shown). Mirrors the main-process
// `window:visibility-changed` emit (see launch-setup.ts). On macOS a parked
// window's renderer never sees a Page Visibility change, so apps that run an
// animation/sim loop subscribe to `brainstorm:app-visibility` to pause while
// hidden and resume on show. The dataset attr lets CSS react too.
ipcRenderer.on("window:visibility-changed", (_event, visible: boolean) => {
	whenDocumentReady(() => {
		const root = document.documentElement;
		if (root) root.dataset.appHidden = visible ? "false" : "true";
	});
	window.dispatchEvent(new CustomEvent("brainstorm:app-visibility", { detail: { visible } }));
});

// Window-management chord forwarding for self-tabbing apps (the Browser). The
// shell owns Cmd+T / Cmd+W globally; when the focused app manages its own tabs
// it routes the command here instead of acting on the window-container, so the
// app mutates its own tab model. Re-dispatched as a `brainstorm:tab-command`
// CustomEvent, mirroring the visibility seam above. Channel must match
// `APP_TAB_COMMAND_CHANNEL` in `@brainstorm/sdk-types`.
ipcRenderer.on(APP_TAB_COMMAND_CHANNEL, (_event, payload: TabCommand) => {
	if (!payload || typeof payload.kind !== "string") return;
	window.dispatchEvent(new CustomEvent("brainstorm:tab-command", { detail: payload }));
});

// Cross-app drag session (DND-2/3) shell→app push channels re-dispatched as DOM
// CustomEvents on `window`, so `@brainstorm/sdk/object-dnd`'s drop registry can
// subscribe without preload coupling. PRIVACY (OQ-DND-2): `drag-over` carries
// kinds + within-window point ONLY; the full payload arrives only on `drop`.
ipcRenderer.on(APP_DRAG_OVER_CHANNEL, (_event, notice: DragOverNotice) => {
	if (!notice || typeof notice.sessionId !== "string") return;
	window.dispatchEvent(new CustomEvent(CROSS_APP_DRAG_OVER_EVENT, { detail: notice }));
});
ipcRenderer.on(APP_DRAG_LEAVE_CHANNEL, (_event, payload: { sessionId: string }) => {
	window.dispatchEvent(new CustomEvent(CROSS_APP_DRAG_LEAVE_EVENT, { detail: payload }));
});
ipcRenderer.on(APP_DROP_CHANNEL, (_event, delivery: DropDelivery) => {
	if (!delivery || typeof delivery.sessionId !== "string") return;
	window.dispatchEvent(new CustomEvent(CROSS_APP_DROP_EVENT, { detail: delivery }));
});
