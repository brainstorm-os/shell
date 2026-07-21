/**
 * Renderer identity registry per §IPC architecture:
 *
 *   The `app` field is **stamped at preload**, not by the app's JS. The app
 *   cannot forge it; it's set by trusted code in the renderer's preload
 *   before any app code runs.
 *
 *   The broker verifies that `app` matches the originating renderer.
 *
 * Stage 4 implementation: when the main process creates a renderer it
 * records `(webContentsId → appId)` here. The broker's `verifyAppIdentity`
 * checks the envelope's claimed `app` against the registered id for the
 * `source` it was given. Stage 5 wires per-app-renderer registration; Stage 4
 * only registers the dashboard as `app = "shell"`.
 *
 * The registry is process-local (main process only) and reset on shell
 * restart — which is fine: renderers are recreated each launch, so a stale
 * mapping cannot persist.
 */

import { SHELL_IDENTITY } from "@brainstorm-os/capabilities/default-grants";

export type RendererIdentitySource = {
	/** WebContents.id (Electron). Stable for the lifetime of the renderer. */
	webContentsId: number;
};

export class RendererIdentityRegistry {
	private readonly byWebContents = new Map<number, string>();

	register(webContentsId: number, appId: string): void {
		this.byWebContents.set(webContentsId, appId);
	}

	unregister(webContentsId: number): void {
		this.byWebContents.delete(webContentsId);
	}

	get(webContentsId: number): string | undefined {
		return this.byWebContents.get(webContentsId);
	}

	verify(claimedApp: string, source: unknown): boolean {
		const id = parseSource(source);
		if (id === null) return false;
		const expected = this.byWebContents.get(id);
		if (expected === undefined) return false;
		return expected === claimedApp;
	}

	/** Number of registered renderers; used by the backpressure layer's
	 *  audit logs and by tests to confirm setup. */
	size(): number {
		return this.byWebContents.size;
	}
}

function parseSource(source: unknown): number | null {
	if (typeof source === "number" && Number.isInteger(source) && source >= 0) {
		return source;
	}
	if (source && typeof source === "object" && "webContentsId" in source) {
		const id = (source as { webContentsId: unknown }).webContentsId;
		if (typeof id === "number" && Number.isInteger(id) && id >= 0) return id;
	}
	return null;
}

/** Convenience: register the dashboard renderer with the canonical shell id. */
export function registerDashboard(registry: RendererIdentityRegistry, webContentsId: number): void {
	registry.register(webContentsId, SHELL_IDENTITY);
}
