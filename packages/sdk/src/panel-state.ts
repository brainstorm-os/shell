/**
 * Right-panel (inspector / properties / references) open state, scoped to
 * the WINDOW rather than the device.
 *
 * Backed by `sessionStorage`: the state survives reloads and object
 * switches inside one app window, but a freshly opened window always
 * starts at the app's default (closed for most apps). Persisting this in
 * `localStorage` leaked one window's open inspector into every future
 * window of the app — F-378. Left navigation sidebars are a durable
 * device preference and correctly stay in `localStorage`.
 */
export function readPanelOpen(key: string, fallback: boolean): boolean {
	try {
		const raw = globalThis.sessionStorage?.getItem(key);
		if (raw == null) return fallback;
		return raw !== "false";
	} catch {
		return fallback;
	}
}

export function writePanelOpen(key: string, open: boolean): void {
	try {
		globalThis.sessionStorage?.setItem(key, String(open));
	} catch {
		// Storage disabled — state reverts to the app default on reload.
	}
}
