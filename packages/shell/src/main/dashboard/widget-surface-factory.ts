/**
 * Widget surface factory (Stage 7.3, OQ-6 → (a)). Turns a `WidgetPlacement`
 * into a live `WidgetSurface` for the `WidgetHost`.
 *
 * Two phases, because the host's `reconcile()` is synchronous but the inputs a
 * surface needs (manifest `entry`, capability grants, active theme/locale) are
 * resolved asynchronously:
 *
 *   1. `resolveWidgetSpec(placement, ctx)` — async. Reads the installed-app
 *      record + manifest entry + live capability grants, assembles the
 *      `--brainstorm-handshake` (with `launch.reason === "widget"`), and
 *      returns a ready-to-construct `WidgetSpec`. Mirrors the
 *      `LaunchOrchestrator` lookup chain (the app-window path).
 *   2. `createWidgetSurface(spec, deps)` — sync. Constructs the
 *      `WebContentsView` (via an injected factory so the module stays
 *      Electron-free for unit tests), registers its renderer identity under
 *      the parent app id (so the broker scopes capabilities exactly like an
 *      app window), parents it on the dashboard window, and loads the entry.
 *
 * The `WidgetHostController` drives phase 1 ahead of `WidgetHost.reconcile`,
 * which calls phase 2 for newly-placed widgets. The real Electron
 * `WebContentsView` constructor lives in `index.ts` (where electron is already
 * imported), passed in as `createView` — the same launcher / launch-setup split
 * that keeps `launcher.ts` testable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { encodeHandshake } from "@brainstorm-os/sdk";
import type { AppHandshake, FormatContext } from "@brainstorm-os/sdk-types";
import type { ThemeName } from "@brainstorm-os/tokens";
import { backgroundColorForTheme } from "../apps/launcher";
import type { Rectangle, WebContentsViewHandle } from "../apps/window-container";
import type { RendererIdentityRegistry } from "../ipc/renderer-identity";
import type { AppsRepository } from "../storage/registry-repo/apps-repo";
import type { WidgetPlacement, WidgetRect, WidgetSurface } from "./widget-host";

/** A resolved, ready-to-construct widget surface. Resolution is async (manifest
 *  read, capability + theme lookup); construction is sync — so the controller
 *  resolves specs ahead of the host's synchronous reconcile. */
export type WidgetSpec = {
	appId: string;
	/** `file://…?v=<sha>` — the same cache-busted entry URL an app window loads. */
	entryUrl: string;
	preloadPath: string;
	/** `--brainstorm-app-id` / `--brainstorm-handshake` / `--brainstorm-build`
	 *  (+ optional `--brainstorm-theme`) — read by the app-preload before app JS. */
	additionalArguments: string[];
	backgroundColor: string;
};

/** The installed-app fields a widget spec is built from. */
export type WidgetAppRecord = {
	version: string;
	sdk: string;
	bundleDir: string;
	bundleSha256: string;
};

/** Pure spec assembly — no IO. Builds the handshake (widget launch context +
 *  capabilities + first-paint theme/locale/format) and the launch arguments.
 *  Exported so the handshake wiring is unit-tested without a DB or filesystem. */
export function buildWidgetSpec(args: {
	placement: WidgetPlacement;
	record: WidgetAppRecord;
	capabilities: readonly string[];
	entryPath: string;
	preloadPath: string;
	theme?: ThemeName | null;
	locale?: string | null;
	format?: FormatContext | null;
}): WidgetSpec {
	const { placement, record, capabilities, entryPath, preloadPath } = args;
	const handshake: AppHandshake = {
		app: { id: placement.appId, version: record.version, sdkVersion: record.sdk },
		capabilities,
		launch: {
			reason: "widget",
			widgetId: placement.widgetId,
			...(placement.bind ? { bind: placement.bind } : {}),
		},
		...(args.locale ? { locale: args.locale } : {}),
		...(args.format ? { format: args.format } : {}),
	};
	const sha8 = record.bundleSha256.slice(0, 8);
	const additionalArguments = [
		`--brainstorm-app-id=${placement.appId}`,
		`--brainstorm-handshake=${encodeHandshake(handshake)}`,
		`--brainstorm-build=${sha8}`,
	];
	if (args.theme) additionalArguments.push(`--brainstorm-theme=${args.theme}`);
	return {
		appId: placement.appId,
		// `?v=<sha>` busts Chromium's file:// cache so a dev reseed serves fresh
		// entry HTML — identical to the app-window entry URL.
		entryUrl: `file://${join(record.bundleDir, entryPath)}?v=${sha8}`,
		preloadPath,
		additionalArguments,
		backgroundColor: backgroundColorForTheme(args.theme ?? undefined),
	};
}

/** Read + cache an app bundle's manifest `entry`, rejecting a path that escapes
 *  the bundle. Mirrors `LaunchOrchestrator.resolveEntryPath` (sync variant —
 *  the manifest is tiny and resolution sits off the widget hot path). Keyed by
 *  bundle sha, which invalidates on every install / update / dev rebuild. */
export function resolveEntryPathSync(
	bundleDir: string,
	bundleSha256: string,
	cache: Map<string, string>,
): string {
	const cached = cache.get(bundleSha256);
	if (cached !== undefined) return cached;
	const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")) as {
		entry?: string;
	};
	const entryPath = manifest.entry ?? "index.html";
	if (entryPath.includes("..") || entryPath.startsWith("/")) {
		throw new Error(`manifest.entry must be a relative path inside the bundle, got ${entryPath}`);
	}
	cache.set(bundleSha256, entryPath);
	return entryPath;
}

/** What `resolveWidgetSpec` needs to look up an app + its grants + first-paint
 *  context. Structural so a test can pass fakes. */
export type WidgetSpecContext = {
	openRegistry: () => Promise<{ makeAppsRepo: () => AppsRepository }>;
	getLedger: () => Promise<CapabilityLedger>;
	preloadPath: string;
	/** First-paint context; `null` falls back to the app-preload defaults. */
	theme: ThemeName | null;
	locale: string | null;
	format: FormatContext | null;
	/** Per-bundle entry-path cache (keyed by sha) — shared across reconciles. */
	entryCache: Map<string, string>;
};

/** Resolve a placement into a `WidgetSpec`, or null when the app is gone /
 *  its bundle is missing the manifest. Async (registry + ledger + manifest). */
export async function resolveWidgetSpec(
	placement: WidgetPlacement,
	ctx: WidgetSpecContext,
): Promise<WidgetSpec | null> {
	const { makeAppsRepo } = await ctx.openRegistry();
	const record = makeAppsRepo().getActive(placement.appId);
	if (!record) return null;
	let entryPath: string;
	try {
		entryPath = resolveEntryPathSync(record.bundleDir, record.bundleSha256, ctx.entryCache);
	} catch (error) {
		console.warn(`[widget-surface] ${placement.appId} entry resolve failed:`, error);
		return null;
	}
	const ledger = await ctx.getLedger();
	// Reconstruct the full `service.verb[:scope]` — a widget reasons over scoped
	// caps the same as a full app; dropping the scope here strips them to bare
	// verbs (the launch-orchestrator scope bug, same shape).
	const capabilities = ledger
		.listActive(placement.appId)
		.map((grant) => (grant.scope === null ? grant.capability : `${grant.capability}:${grant.scope}`));
	return buildWidgetSpec({
		placement,
		record,
		capabilities,
		entryPath,
		preloadPath: ctx.preloadPath,
		theme: ctx.theme,
		locale: ctx.locale,
		format: ctx.format,
	});
}

/** The dashboard window's child-view surface — `BrowserWindow.contentView`. */
export interface ChildViewMount {
	addChildView(view: WebContentsViewHandle): void;
	removeChildView(view: WebContentsViewHandle): void;
}

/** Constructs the Electron `WebContentsView` for a widget (preload + sandbox +
 *  per-widget handshake args). Injected so this module needs no electron. */
export type WidgetViewFactory = (spec: {
	appId: string;
	preloadPath: string;
	additionalArguments: string[];
	backgroundColor: string;
}) => WebContentsViewHandle;

export type WidgetSurfaceDeps = {
	identities: RendererIdentityRegistry;
	/** The dashboard window's child-view surface, or null when no dashboard
	 *  window is up (lock screen / early boot) — then no surface is created. */
	getMountPoint: () => ChildViewMount | null;
	createView: WidgetViewFactory;
};

function roundRect(rect: WidgetRect): Rectangle {
	return {
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		width: Math.max(0, Math.round(rect.width)),
		height: Math.max(0, Math.round(rect.height)),
	};
}

/** Construct the live surface for a resolved spec. Registers the renderer
 *  identity under the parent app id (broker scoping), parents the view on the
 *  dashboard window hidden (the next layout tick reveals on-screen ones), and
 *  loads the entry. Returns null when there's no dashboard window to host it. */
export function createWidgetSurface(
	spec: WidgetSpec,
	deps: WidgetSurfaceDeps,
): WidgetSurface | null {
	const mount = deps.getMountPoint();
	if (!mount) return null;
	const view = deps.createView({
		appId: spec.appId,
		preloadPath: spec.preloadPath,
		additionalArguments: spec.additionalArguments,
		backgroundColor: spec.backgroundColor,
	});
	view.setBackgroundColor?.(spec.backgroundColor);
	mount.addChildView(view);
	view.setVisible(false);
	const webContentsId = view.webContents.id;
	deps.identities.register(webContentsId, spec.appId);
	console.info(`[widget] mounted ${spec.appId} wc ${webContentsId} → ${spec.entryUrl}`);
	void view.webContents.loadURL(spec.entryUrl);
	let destroyed = false;
	const alive = () => !destroyed && !view.webContents.isDestroyed();
	return {
		webContentsId,
		setBounds: (rect) => {
			if (alive()) view.setBounds(roundRect(rect));
		},
		setVisible: (visible) => {
			if (alive()) view.setVisible(visible);
		},
		// Reuse the same pause channel an app window uses: the app-preload
		// mirrors `window:visibility-changed` onto `dataset.appHidden` +
		// `brainstorm:app-visibility`, which `@brainstorm-os/sdk/widget` reads.
		sendVisibility: (visible) => {
			if (alive()) view.webContents.send("window:visibility-changed", visible);
		},
		destroy: () => {
			if (destroyed) return;
			destroyed = true;
			deps.identities.unregister(webContentsId);
			try {
				deps.getMountPoint()?.removeChildView(view);
			} catch {
				// Dashboard window already torn down — nothing to detach from.
			}
			if (!view.webContents.isDestroyed()) view.webContents.close();
		},
	};
}
