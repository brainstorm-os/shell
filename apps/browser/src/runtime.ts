/**
 * The slice of `window.brainstorm` the Web Browser chrome reads. The chrome is
 * *only* chrome (§The core tension): it drives the shell-side
 * `WebView` host service and receives metadata events — it never touches the
 * page DOM or bytes. Outside the shell (`window.brainstorm` absent) the chrome
 * renders an explanatory placeholder.
 */

import type {
	Intent,
	LaunchContext,
	LifecycleEvent,
	SerializedBlock,
	Subscription,
	WebViewClient,
} from "@brainstorm-os/sdk-types";

export type EntityRecord = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
};

/** The slice of the shared entities service the Browser uses: `create` for
 *  the clip path (Browser-5) and the `BrowsingSession/v1` row, `query` +
 *  `update` for session restore/save — the shell enforces the per-type
 *  capability against the ledger on every call. Mirrors
 *  `apps/bookmarks/src/storage/runtime.ts`. */
export type EntitiesClient = {
	create(type: string, properties: Record<string, unknown>): Promise<{ id: string; type: string }>;
	query?(q: { type?: string | string[] }): Promise<EntityRecord[]>;
	update?(id: string, patch: Record<string, unknown>): Promise<EntityRecord>;
};

/** The readable slice of the shell network broker (gated on
 *  `network.readable`). Returns the cleaned page body as `SerializedBlock[]`
 *  (or `null` when nothing was extractable) so the clip path can stamp captured
 *  content onto the saved bookmark. Mirrors
 *  `apps/bookmarks/src/storage/runtime.ts::NetworkPreviewService.readable`. */
export type NetworkReadableService = {
	readable(input: {
		url: string;
		locale?: string;
	}): Promise<{ blocks: SerializedBlock[] | null }>;
};

export type BrowserRuntime = {
	app?: { id: string; version: string; sdkVersion: string };
	capabilities?: readonly string[];
	/** Why the shell launched this window — `reason === "deep-link"` carries
	 *  the URL a link click resolved to (Browser is the http/https opener). */
	launch?: LaunchContext;
	on?: (
		event: "intent",
		handler: (event: Extract<LifecycleEvent, { type: "intent" }>) => void,
	) => Subscription;
	services?: {
		webView?: WebViewClient;
		entities?: EntitiesClient;
		/** Readable-content scrape for the clip path (gated on
		 *  `network.readable`) — absent outside the shell or when the grant is
		 *  withheld, in which case a clip saves link-only. */
		network?: NetworkReadableService;
	} | null;
};

declare global {
	interface Window {
		brainstorm?: BrowserRuntime | undefined;
	}
}

export function getBrainstorm(): BrowserRuntime | null {
	return typeof window !== "undefined" ? (window.brainstorm ?? null) : null;
}

export function getWebView(): WebViewClient | null {
	return getBrainstorm()?.services?.webView ?? null;
}

export function getEntities(): EntitiesClient | null {
	return getBrainstorm()?.services?.entities ?? null;
}

export function getNetwork(): NetworkReadableService | null {
	return getBrainstorm()?.services?.network ?? null;
}

export function getLaunch(): LaunchContext | null {
	return getBrainstorm()?.launch ?? null;
}

/** Subscribe to `open` intents pushed to this already-running window
 *  (the shell focuses the window and re-delivers the link as an intent
 *  instead of re-launching). Returns an unsubscribe, or null outside the
 *  shell. */
export function onIntent(handler: (intent: Intent) => void): (() => void) | null {
	const on = getBrainstorm()?.on;
	if (!on) return null;
	const subscription = on("intent", (event) => handler(event.intent));
	return () => subscription.unsubscribe();
}
