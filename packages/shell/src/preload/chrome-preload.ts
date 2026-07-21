/**
 * Chrome preload — runs in the tab-strip view's preload context. A THIRD
 * trusted surface, distinct from the app preload (no broker, no app handshake)
 * and the dashboard preload. It exposes only the minimal `window.brainstormChrome`
 * bridge the tab strip needs to render tab state + issue tab commands.
 *
 *   - `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
 *
 * IMPORTANT: this preload must import NOTHING heavy. The two preload entries
 * (app-preload + chrome-preload) are bundled together; if both import
 * `@brainstorm-os/tokens`, Rollup extracts the shared code into a `chunks/*.cjs`
 * file that a SANDBOXED preload cannot `require()` — which breaks BOTH preloads
 * (app windows boot with no `window.brainstorm`). So theming lives in the strip
 * RENDERER (tab-strip.tsx), where code-splitting is fine; this preload only
 * forwards the theme NAME.
 *
 * Security: the bridge's commands carry no container id — the main process
 * resolves the target container from the IPC sender's webContents id, so a
 * strip can only ever drive its own container (see chrome-tabs-handlers.ts).
 */

import {
	CHROME_TABS_ACTIVATE,
	CHROME_TABS_CLOSE,
	CHROME_TABS_NEW,
	CHROME_TABS_REORDER,
	CHROME_TABS_REQUEST,
	CHROME_TABS_STATE_CHANNEL,
	CHROME_THEME_CHANNEL,
	type ChromeBridge,
	type ChromeTabsState,
} from "@brainstorm-os/protocol/chrome-tabs";
import { contextBridge, ipcRenderer } from "electron";

function readArg(prefix: string): string | null {
	for (const arg of process.argv) {
		if (typeof arg === "string" && arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return null;
}

if (typeof document !== "undefined" && document.documentElement) {
	document.documentElement.dataset.platform = process.platform;
}

const bridge: ChromeBridge = {
	initialTheme: readArg("--brainstorm-theme="),
	onTheme: (listener) => {
		const handler = (_event: unknown, name: string) => listener(name);
		ipcRenderer.on(CHROME_THEME_CHANNEL, handler);
		return () => ipcRenderer.off(CHROME_THEME_CHANNEL, handler);
	},
	onState: (listener) => {
		const handler = (_event: unknown, state: ChromeTabsState) => listener(state);
		ipcRenderer.on(CHROME_TABS_STATE_CHANNEL, handler);
		return () => ipcRenderer.off(CHROME_TABS_STATE_CHANNEL, handler);
	},
	requestState: () => ipcRenderer.invoke(CHROME_TABS_REQUEST),
	activateTab: (tabId) => ipcRenderer.invoke(CHROME_TABS_ACTIVATE, tabId),
	closeTab: (tabId) => ipcRenderer.invoke(CHROME_TABS_CLOSE, tabId),
	newTab: () => ipcRenderer.invoke(CHROME_TABS_NEW),
	reorderTabs: (order) => ipcRenderer.invoke(CHROME_TABS_REORDER, order),
};

contextBridge.exposeInMainWorld("brainstormChrome", bridge);
