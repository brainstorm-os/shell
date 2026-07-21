/**
 * Wires the AppLauncher + LaunchOrchestrator against the currently-active
 * vault session. Rebuilds both when the session id changes (vault switch);
 * windows belonging to the old session close as the previous launcher
 * goes out of scope on the next switch.
 */

import { join } from "node:path";
import { regionalToFormatContext } from "@brainstorm-os/protocol/format-context";
import {
	ActionTrustTier,
	type OpenTarget,
	OpenTargetKind,
	OsHandoffConsent,
} from "@brainstorm-os/sdk-types";
import { BaseWindow, WebContentsView, app, nativeTheme, screen, shell } from "electron";
import { resolveAppName } from "../apps/app-name";
import { AppSignatureStatus } from "../apps/app-signature";
import { wireExternalLinkRouting } from "../apps/external-link-routing";
import { firstPartyAppById } from "../apps/first-party";
import { LaunchOrchestrator } from "../apps/launch-orchestrator";
import { AppLauncher, type ChromeViewFactory, type ContainerFactory } from "../apps/launcher";
import type {
	BaseWindowHandle,
	TabViewFactory,
	WebContentsViewHandle,
} from "../apps/window-container";
import { defaultHandlerKey } from "../dashboard/dashboard-store";
import { GENERIC_OBJECT_EDITOR_APP_ID } from "../intents/defaults-catalog";
import { makeEntityTargetResolver } from "../intents/entity-target";
import { IntentsBus, OPEN_VERB } from "../intents/intents-bus";
import { getOpenWithPromptHost } from "../ipc/open-with-prompt";
import { getOsHandoffPromptHost } from "../ipc/os-handoff-prompt";
import type { RendererIdentityRegistry } from "../ipc/renderer-identity";
import { EntitiesRepository } from "../storage/entities-repo";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { IntentsRepository } from "../storage/registry-repo/intents-repo";
import { OpenersRepository } from "../storage/registry-repo/openers-repo";
import { getActiveVaultSession } from "../vault/session";
import { readSpellcheckDictionary } from "../vault/vault-spellcheck-dictionary-store";
import {
	SPELLCHECK_CONTEXT_CHANNEL,
	enableSessionSpellcheck,
	hydrateSessionDictionary,
	spellcheckContextFromParams,
} from "../web/spellcheck";
import { brainstormChromeOptions } from "../window/chrome-options";
import type { MonitorInfo } from "../window/monitor";
import { WindowIndex } from "../window/window-index";

export type LaunchSetup = {
	getOrchestrator: () => Promise<LaunchOrchestrator | null>;
	getOrchestratorSync: () => LaunchOrchestrator | null;
	getLauncherSync: () => AppLauncher | null;
	getWindowIndexSync: () => WindowIndex | null;
	getIntents: () => Promise<IntentsBus | null>;
	getIntentsSync: () => IntentsBus | null;
	closeAppWindows: (appId: string) => void;
	onSessionRebuilt: (listener: () => void) => () => void;
	/** Stamp the dashboard window as just-focused on the shared focus clock so
	 *  dock-click activation can compare it against app-window recency. */
	stampDashboardFocus: () => void;
	/** The dashboard's last-focus stamp on the shared clock (0 if never focused). */
	getDashboardLastFocusedAt: () => number;
};

export function createLaunchSetup(args: {
	mainDir: string;
	identities: RendererIdentityRegistry;
	containerFactory?: ContainerFactory;
	tabViewFactory?: TabViewFactory;
	chromeViewFactory?: ChromeViewFactory;
	/** Reveal + focus the dashboard when the last visible app window closes
	 *  (see AppLauncherOptions.revealDashboard). */
	revealDashboard?: () => void;
	/** Mailbox-4 — shell-side handler for the `send` intent verb. Late-bound
	 *  (the mail service is built after launch setup), so index.ts passes a
	 *  closure that resolves the live service per dispatch. */
	sendMail?: (payload: Record<string, unknown>, sourceApp: string) => Promise<unknown>;
}): LaunchSetup {
	const containerFactory = args.containerFactory ?? defaultContainerFactory;
	const baseTabViewFactory = args.tabViewFactory ?? defaultTabViewFactory;
	const chromeViewFactory = args.chromeViewFactory ?? defaultChromeViewFactory;
	const sessionListeners = new Set<() => void>();
	// One monotonic focus clock shared by every app window (via WindowIndex)
	// and the dashboard window. It outlives per-session rebuilds so stamps stay
	// comparable across vault switches — dock-click activation reads both.
	let focusSeq = 0;
	const nextFocusStamp = () => ++focusSeq;
	let dashboardLastFocusedAt = 0;
	let cached: {
		orchestrator: LaunchOrchestrator;
		launcher: AppLauncher;
		windowIndex: WindowIndex;
		intents: IntentsBus;
		appsRepo: AppsRepository;
		session: ReturnType<typeof getActiveVaultSession>;
	} | null = null;

	// Every app renderer gets the external-link guard: a `window.open` /
	// `target="_blank"` anchor (bookmark source links, editor bookmark
	// cards) re-enters the open-resolution ladder attributed to the app —
	// so the registered in-vault opener (the Browser app for http/https)
	// handles it — instead of Electron's default bare popup window, which
	// bypasses the ladder entirely.
	const tabViewFactory: TabViewFactory = (spec) => {
		const view = baseTabViewFactory(spec);
		wireExternalLinkRouting(view.webContents, (url) => {
			void routeRendererLink({ app: spec.appId, webContentsId: view.webContents.id }, url);
		});
		return view;
	};

	async function routeRendererLink(
		source: { app: string; webContentsId?: number },
		url: string,
	): Promise<void> {
		const intents = cached?.intents ?? null;
		if (!intents) return;
		try {
			const result = await intents.dispatch({ verb: OPEN_VERB, payload: { url } }, source);
			if (!result.handled) {
				console.warn(
					`[intents] link from ${source.app} not opened: ${result.message ?? result.reason}`,
				);
			}
		} catch (error) {
			console.warn(`[intents] link from ${source.app} failed to dispatch:`, error);
		}
	}

	async function build() {
		const session = getActiveVaultSession();
		if (!session) {
			if (cached !== null) {
				cached.windowIndex.dispose();
				cached = null;
				notifyRebuilt();
			}
			return null;
		}
		// Compare by session *instance*, not vault id — a re-activation of the
		// same vault disposes the old session (closing its SQLite handles), so
		// repos cached against the old session would call into a closed DB.
		if (cached && cached.session === session) return cached;
		if (cached) cached.windowIndex.dispose();
		const registry = await session.dataStores.open("registry");
		const ledger = await session.capabilityLedger();
		const appsRepo = new AppsRepository(registry);
		const intentsRepo = new IntentsRepository(registry);
		const openersRepo = new OpenersRepository(registry);
		const launcher = new AppLauncher({
			mainDir: args.mainDir,
			appsRepo,
			identities: args.identities,
			containerFactory,
			tabViewFactory,
			chromeViewFactory,
			resolveAppName: (appId) => resolveAppName(appsRepo, appId),
			...(args.revealDashboard ? { revealDashboard: args.revealDashboard } : {}),
		});
		const orchestrator = new LaunchOrchestrator({
			appsRepo,
			ledger,
			launcher,
			getActiveTheme: async () => {
				const active = getActiveVaultSession();
				if (!active) return null;
				const dashboard = await active.dashboardStore();
				return dashboard.activeTheme(nativeTheme.shouldUseDarkColors);
			},
			getActiveLocale: async () => {
				const active = getActiveVaultSession();
				if (!active) return null;
				const dashboard = await active.dashboardStore();
				return dashboard.snapshot().locale.language;
			},
			getActiveFormat: async () => {
				const active = getActiveVaultSession();
				if (!active) return null;
				const snapshot = (await active.dashboardStore()).snapshot();
				return regionalToFormatContext(snapshot.locale.language, snapshot.regional);
			},
		});
		// Resolve a bare entity id to its `{ type, mime }` against whatever
		// vault is active at call time — never the captured `session`, since
		// a vault switch closes its `entities.db` handle.
		const resolveEntityTarget = makeEntityTargetResolver(async () => {
			const active = getActiveVaultSession();
			if (!active) return null;
			return new EntitiesRepository(await active.dataStores.open("entities"));
		});
		const intents = new IntentsBus({
			intents: intentsRepo,
			orchestrator,
			launcher,
			openers: openersRepo,
			resolveEntityTarget,
			...(args.sendMail ? { sendMail: args.sendMail } : {}),
			// Default editor for an object no app specifically claims (per
			// the universal-body design + doc-31 §Resolution fallback).
			genericEntityViewerAppId: GENERIC_OBJECT_EDITOR_APP_ID,
			// Settings → Defaults override — read from the active vault's
			// dashboard doc at dispatch time (never the captured `session`;
			// a vault switch swaps the store). A missing override → null →
			// the bus keeps its built-in pick.
			resolveDefaultHandler: async (verb, entityType) => {
				if (!entityType) return null;
				const active = getActiveVaultSession();
				if (!active) return null;
				const dashboard = await active.dashboardStore();
				return dashboard.snapshot().defaultHandlers[defaultHandlerKey(verb, entityType)] ?? null;
			},
			// OpenRes-1b — the open-resolution ladder's external rungs.
			getVaultPath: () => getActiveVaultSession()?.vaultPath ?? null,
			resolveOsHandoffConsent: async (signature) => {
				const active = getActiveVaultSession();
				if (!active) return OsHandoffConsent.FirstUse;
				const dashboard = await active.dashboardStore();
				// The store only ever holds Granted/Denied; absence is FirstUse.
				return dashboard.snapshot().osHandoffConsent[signature] ?? OsHandoffConsent.FirstUse;
			},
			// An app/agent may only hand off to the OS with an explicit
			// `system.open-external` grant (read the *active* vault's ledger
			// at call time — a vault switch swaps it). Shell-sourced opens
			// are handled in the bus (always allowed — user click in chrome).
			mayHandoff: async (sourceApp) => {
				const active = getActiveVaultSession();
				if (!active) return false;
				try {
					const activeLedger = await active.capabilityLedger();
					return activeLedger.has(sourceApp, "system.open-external");
				} catch {
					return false; // fail closed
				}
			},
			// The single OS-handoff egress chokepoint (doc 57 §System
			// default). `shell.openExternal` for a scheme, `shell.openPath`
			// for a file; both failure shapes normalized.
			openExternal: async (target: OpenTarget) => {
				try {
					if (target.kind === OpenTargetKind.Scheme) {
						await shell.openExternal(target.uri);
						return { ok: true };
					}
					if (target.kind === OpenTargetKind.File) {
						const err = await shell.openPath(target.path);
						return err ? { ok: false, error: err } : { ok: true };
					}
					return { ok: false, error: "not an OS-handoff target" };
				} catch (error) {
					return { ok: false, error: (error as Error).message };
				}
			},
			// OpenRes-1c — first-use interactive consent prompt + sticky
			// memory. The bus's `needsConsent` branch calls these instead
			// of fail-closed refusing.
			promptOsHandoffConsent: (signature, uri) => getOsHandoffPromptHost().request(signature, uri),
			recordOsHandoffConsent: async (signature, decision) => {
				const active = getActiveVaultSession();
				if (!active) return;
				const dashboard = await active.dashboardStore();
				dashboard.setOsHandoffConsent(signature, decision);
			},
			// OpenRes-1c slice 6 — multi-candidate "Open with…" picker.
			// Raised only when two or more in-vault openers claim the
			// same scheme/extension. `resolveAppLabel` reads the
			// manifest name (cached) so the modal shows "Web Browser"
			// rather than `io.brainstorm.web-browser`.
			promptOpenWith: (signature, uri, candidates) =>
				getOpenWithPromptHost().request(signature, uri, candidates),
			resolveAppLabel: (appId) => resolveAppName(appsRepo, appId),
			recordDefaultHandler: async (verb, signature, appId) => {
				const active = getActiveVaultSession();
				if (!active) return;
				const dashboard = await active.dashboardStore();
				// `defaultHandlerKey(verb, signature)` matches the catalog +
				// resolver path: an os-handoff `signature` (`scheme:https`)
				// composes into `open:scheme:https` — same shape `slice 2`
				// pins via Settings → Defaults.
				dashboard.setDefaultHandler(verb, signature, appId);
			},
			// The action surface (doc 63 / AS-4): a contribution ranks inline
			// only when its app is first-party or catalog-signed (verified);
			// everything else (sideloaded / unsigned / bad signature) is
			// quarantined under More actions (OQ-AS-3). Read from the apps
			// registry row — never trusts the contributor's own claim.
			resolveTrustTier: (appId) => resolveActionTrustTier(appsRepo, appId),
			// The action surface (doc 63 / AS-4): the user's disabled-contributor
			// set, read from the active vault's dashboard doc at suggest time.
			resolveDisabledContributors: async () => {
				const active = getActiveVaultSession();
				if (!active) return new Set<string>();
				const dashboard = await active.dashboardStore();
				return new Set(dashboard.snapshot().disabledContributors);
			},
		});
		const windowIndex = new WindowIndex({
			launcher,
			getMonitors: defaultGetMonitors,
			resolveAppMeta: (appId) => resolveAppMeta(appsRepo, appId),
			nextFocusStamp,
		});
		cached = { orchestrator, launcher, windowIndex, intents, appsRepo, session };
		notifyRebuilt();
		return cached;
	}

	function notifyRebuilt(): void {
		for (const listener of sessionListeners) {
			try {
				listener();
			} catch (error) {
				console.warn("[launch-setup] session listener threw:", error);
			}
		}
	}

	return {
		getOrchestrator: async () => (await build())?.orchestrator ?? null,
		getOrchestratorSync: () => cached?.orchestrator ?? null,
		getLauncherSync: () => cached?.launcher ?? null,
		getWindowIndexSync: () => cached?.windowIndex ?? null,
		getIntents: async () => (await build())?.intents ?? null,
		getIntentsSync: () => cached?.intents ?? null,
		closeAppWindows: (appId) => cached?.launcher.closeApp(appId),
		onSessionRebuilt: (listener) => {
			sessionListeners.add(listener);
			return () => {
				sessionListeners.delete(listener);
			};
		},
		stampDashboardFocus: () => {
			dashboardLastFocusedAt = nextFocusStamp();
		},
		getDashboardLastFocusedAt: () => dashboardLastFocusedAt,
	};
}

function resolveAppMeta(
	appsRepo: AppsRepository,
	appId: string,
): { appId: string; appName: string } {
	return { appId, appName: resolveAppName(appsRepo, appId) };
}

/** The action surface (doc 63 / AS-4): the trust tier of a contributing app.
 *  A bundled first-party app or one whose manifest signature verified against a
 *  trusted key ranks inline (`Trusted`); everything else — sideloaded, unsigned,
 *  untrusted key, or a failed signature check — is quarantined (`Sideloaded`)
 *  under "More actions…" until the user promotes it (OQ-AS-3). Read from the
 *  registry row; the contributor's own manifest can never claim a higher tier. */
function resolveActionTrustTier(appsRepo: AppsRepository, appId: string): ActionTrustTier {
	if (firstPartyAppById(appId)) return ActionTrustTier.Trusted;
	const record = appsRepo.getActive(appId);
	if (record?.signatureStatus === AppSignatureStatus.Verified) return ActionTrustTier.Trusted;
	return ActionTrustTier.Sideloaded;
}

function defaultGetMonitors(): readonly MonitorInfo[] {
	return screen.getAllDisplays().map((d) => ({
		id: d.id,
		bounds: d.bounds,
		workArea: d.workArea,
		scaleFactor: d.scaleFactor,
		primary: d.id === screen.getPrimaryDisplay().id,
	}));
}

// App containers take their `backgroundColor` from the active Brainstorm
// theme's `color.background.primary` — the paint shown for newly-exposed
// pixels during a resize AND the first paint before any tab renders. The
// per-tab fullscreen / visibility signals and first-paint reveal are owned by
// `WindowContainer` (one OS window can now host several tab renderers), not the
// factory; the factory just constructs the bare OS window / tab view.

const defaultContainerFactory: ContainerFactory = (spec) => {
	// The default app-window size; overridable via env so the marketing
	// screenshot harness can capture larger (maximised-looking) windows
	// without changing the product default.
	const envSize = (key: string, fallback: number): number => {
		const v = Number.parseInt(process.env[key] ?? "", 10);
		return Number.isFinite(v) && v > 0 ? v : fallback;
	};
	const window = new BaseWindow({
		width: envSize("BRAINSTORM_APP_WINDOW_WIDTH", 1100),
		height: envSize("BRAINSTORM_APP_WINDOW_HEIGHT", 720),
		title: spec.title,
		show: false,
		backgroundColor: spec.backgroundColor,
		autoHideMenuBar: true,
		...brainstormChromeOptions(),
	});
	return window as unknown as BaseWindowHandle;
};

const defaultTabViewFactory: TabViewFactory = (spec) => {
	const view = new WebContentsView({
		webPreferences: {
			preload: spec.preloadPath,
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			additionalArguments: spec.additionalArguments,
			// Dogfood build: DevTools force-enabled on app renderers even when
			// packaged (mirrors DEVTOOLS_ENABLED in main/index.ts). Revert to
			// `!app.isPackaged` for a real distributable — 13.8 security.
			devTools: true,
		},
	});
	view.setBackgroundColor(spec.backgroundColor);
	// B11.16a — enable Chromium's spellchecker on the app renderer session
	// (idempotent; app renderers share session.defaultSession). Only elements
	// that opt in (spellcheck=true / contentEditable — B11.16b) are checked.
	enableSessionSpellcheck(view.webContents.session, app.getPreferredSystemLanguages());
	// B11.17a — hydrate the active vault's custom dictionary into the session
	// (once). Async store read; failures leave the dictionary empty.
	const dictVaultPath = getActiveVaultSession()?.vaultPath;
	if (dictVaultPath) {
		const dictSession = view.webContents.session;
		void readSpellcheckDictionary(dictVaultPath)
			.then((words) => hydrateSessionDictionary(dictSession, words))
			.catch(() => {});
	}
	// B11.16c — Electron shows no native context menu, so push the misspelled
	// word + suggestions to the renderer, which renders them through fancy-menus.
	const wc = view.webContents;
	wc.on("context-menu", (_event, params) => {
		const context = spellcheckContextFromParams({
			misspelledWord: params.misspelledWord,
			dictionarySuggestions: params.dictionarySuggestions,
			isEditable: params.isEditable,
			x: params.x,
			y: params.y,
		});
		if (context && !wc.isDestroyed()) wc.send(SPELLCHECK_CONTEXT_CHANNEL, context);
	});
	return view as unknown as WebContentsViewHandle;
};

const defaultChromeViewFactory: ChromeViewFactory = (spec) => {
	const additionalArguments: string[] = [];
	if (spec.theme) additionalArguments.push(`--brainstorm-theme=${spec.theme}`);
	const view = new WebContentsView({
		webPreferences: {
			preload: join(__dirname, "../preload/chrome-preload.js"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			additionalArguments,
			// The tab strip is a shell-internal chrome surface, never an
			// inspectable app renderer. Disabling DevTools outright stops the
			// global Toggle-DevTools shortcut from opening (and stranding) an
			// inspector on the strip when focus happens to rest there.
			devTools: false,
		},
	});
	view.setBackgroundColor("#00000000");
	const rendererUrl = process.env.ELECTRON_RENDERER_URL;
	if (!app.isPackaged && rendererUrl) {
		void view.webContents.loadURL(`${rendererUrl}/chrome/tab-strip.html`);
	} else {
		void view.webContents.loadFile(join(__dirname, "../renderer/chrome/tab-strip.html"));
	}
	return view as unknown as WebContentsViewHandle;
};
