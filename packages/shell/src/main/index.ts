import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	ANTHROPIC_PROVIDER_ID,
	APP_TAB_COMMAND_CHANNEL,
	APP_WEBVIEW_EVENT_CHANNEL,
	GEMINI_PROVIDER_ID,
	GLM_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	OLLAMA_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
	StoredAssetKind,
	TabCommandKind,
	type TypeSchemaForExtract,
	WEBVIEW_SERVICE,
	extractFieldsFromTypeSchema,
} from "@brainstorm/sdk-types";
import { DEFAULT_THEME, ThemeName, themes } from "@brainstorm/tokens";
import {
	net,
	BrowserWindow,
	Menu,
	Tray,
	WebContentsView,
	app,
	dialog,
	session as electronSession,
	ipcMain,
	nativeImage,
	nativeTheme,
	powerMonitor,
	protocol,
	shell,
	webContents,
} from "electron";
import { AppearanceMode, AppearanceSlot } from "../shared/appearance";
import {
	DEFAULT_SELECTIVE_SYNC_POLICY,
	SelectiveSyncMode,
	entityMatchesPolicy,
} from "../shared/selective-sync-types";
import { UPDATE_STATE_EVENT } from "../shared/update-wire-types";
import { makeAiServiceHandler } from "./ai/ai-service";
import { recordAiUsage } from "./ai/ai-usage-log";
import { type AnthropicHttp, createAnthropicProvider } from "./ai/anthropic-provider";
import { createGeminiProvider } from "./ai/gemini-provider";
import { type OllamaHttp, createOllamaProvider } from "./ai/ollama-provider";
import { createOpenAiProvider } from "./ai/openai-provider";
import { ProviderRegistry } from "./ai/provider-registry";
import { wireExternalLinkRouting } from "./apps/external-link-routing";
import { validateManifest } from "./apps/manifest";
import { appSelfManagesTabs } from "./apps/window-container";
import type { WebContentsViewHandle } from "./apps/window-container";
import { AssetKind } from "./assets/asset-types";
import { resolveAssetForServe } from "./assets/serve-asset";
import { serveVaultMedia } from "./assets/serve-media";
import { VaultMediaDomain, isSealedMedia } from "./assets/vault-media-crypto";
import { makeAutomationsServiceHandler } from "./automations/automations-service";
import { RegistrySchedulerStore } from "./automations/scheduler-store";
import {
	AUTOMATIONS_APP_ID,
	type AutomationsDeployment,
	buildAutomationsDeployment,
} from "./automations/wiring";
import { makeBillingServiceHandler } from "./billing/billing-service";
import {
	BLOCK_FRAME_SCHEME_PRIVILEGE,
	registerBlockFrameProtocol,
} from "./blocks/block-frame-protocol";
import { makeBlocksServiceHandler } from "./blocks/blocks-service";
import { makeBpGraphRouter } from "./bp/graph-router";
import { makeBpHookRouter } from "./bp/hook-router";
import { makeBpRouter } from "./bp/router";
import { makeCalDavServiceHandler } from "./caldav/caldav-service";
import { resolveMembers } from "./collab/access-record";
import { makeConnectorsServiceHandler } from "./connectors/connectors-service";
import { makeNetworkEgress } from "./connectors/egress";
import { buildConnectorsServiceDeps } from "./connectors/wiring";
import { makeCoversServiceHandler } from "./covers/covers-service";
import { readAiProviderKey } from "./credentials/ai-provider-keys";
import type { AssetDekWrap } from "./credentials/asset-dek-wrap";
import { bytesToBase64 } from "./credentials/crypto";
import { verifySignature } from "./credentials/identity";
import { wrapDekForRecipient } from "./credentials/member-wraps";
import { makeDashboardServiceHandler } from "./dashboard/dashboard-service";
import {
	WIDGET_FRAME_SCHEME_PRIVILEGE,
	registerWidgetFrameProtocol,
} from "./dashboard/widget-frame-protocol";
import { WidgetHostController } from "./dashboard/widget-host-controller";
import type { ChildViewMount } from "./dashboard/widget-surface-factory";
import { attachWebContentsLogging, installMainProcessLogging } from "./diagnostics/error-log";
import { makeDndServiceHandler } from "./dnd/dnd-service";
import { DragSessionStore } from "./dnd/drag-session";
import { createFileExporter } from "./dnd/file-exporter";
import { createElectronGhostWindow, createGhostOverlay } from "./dnd/ghost-overlay";
import { type ApplyRemoteDocFn, makeEntitiesServiceHandler } from "./entities/entities-service";
import { EntityChangeEmitter } from "./entities/entity-change-emitter";
import { installEntityDek } from "./entities/install-wrap";
import { rehomeAssetDeks } from "./entities/rehome-asset-deks";
import { retroWrapNullDeks } from "./entities/retro-wrap-deks";
import {
	broadcastVaultEntitiesStaleSignal,
	isVaultEntityWriteEnvelope,
	setVaultEntitiesStaleExtraTarget,
} from "./entities/vault-entities-broadcast";
import {
	listVaultEntities,
	makeVaultEntitiesServiceHandler,
} from "./entities/vault-entities-service";
import { deliverYDocUpdateToApps } from "./entities/ydoc-remote-broadcast";
import { makeExportServiceHandler } from "./export/export-service-handler";
import { productionRenderHtmlToPdf } from "./export/print-to-pdf";
import { CrashQueue, crashQueueDir } from "./feedback/crash-queue";
import { installCrashHooks } from "./feedback/crash-reporter-hooks";
import { CrashReporterService } from "./feedback/crash-reporter-service";
import { newRequestId } from "./feedback/feedback-payload";
import { FeedbackService, defaultFeedbackFetcher } from "./feedback/feedback-service";
import { FeedbackSettingsStore, feedbackSettingsPath } from "./feedback/feedback-settings-store";
import { getSharedRecentLogBuffer, scopeForUrl } from "./feedback/recent-log-buffer";
import { APP_FILES_WATCH_CHANNEL, makeFilesServiceHandler } from "./files/files-service";
import { gatherStorageInventory } from "./files/gather-storage-inventory";
import { listWallpaperEntries } from "./files/wallpaper-entries";
import {
	ALLOWED_ICON_EXTS,
	deleteIconByUrl,
	iconSeal,
	listIcons,
	uploadIconBytes,
} from "./icons/icon-store";
import { makeIconsServiceHandler } from "./icons/icons-service-handler";
import { makeImportServiceHandler } from "./import/import-service";
import { OPEN_VERB } from "./intents/intents-bus";
import { makeIntentsServiceHandler } from "./intents/intents-service";
import { registerAiSettingsHandlers } from "./ipc/ai-settings-handlers";
import { registerAppsHandlers } from "./ipc/apps-handlers";
import { registerBinHandlers } from "./ipc/bin-handlers";
import { registerBrokerHandler } from "./ipc/broker-handler";
import { getCapabilityPromptHost } from "./ipc/capability-prompt";
import { wireCapabilityPromptIpc } from "./ipc/capability-prompt-ipc";
import { registerChromeTabsHandlers } from "./ipc/chrome-tabs-handlers";
import { listCovers } from "./ipc/covers-handlers";
import { registerCoversHandlers } from "./ipc/covers-handlers";
import {
	broadcastThemePreviewToWindows,
	ensureThumbnail,
	rebindDashboardToActiveVault,
	registerDashboardHandlers,
	republishDashboardSnapshot,
	setWidgetSnapshotHook,
} from "./ipc/dashboard-handlers";
import { registerFeedbackHandlers } from "./ipc/feedback-handlers";
import { registerFilesHandlesHandlers } from "./ipc/files-handles-handlers";
// Help corpus + indexer + handlers are dynamic-imported below — the bundled
// `help-corpus/corpus.json` is ~100 KB on its own and inlines into whatever
// module first imports it. Routing it through a lazy chunk keeps the main
// process bundle under budget without delaying anything user-facing (the
// Help overlay is rarely the first surface touched after boot).
import { registerIconsHandlers } from "./ipc/icons-handlers";
import { registerImportExportHandlers } from "./ipc/import-export-handlers";
import { SHELL_INTENT_SOURCE, registerIntentHandlers } from "./ipc/intent-handlers";
import { registerLedgerHandlers } from "./ipc/ledger-handlers";
import { registerMarketplaceHandlers } from "./ipc/marketplace-handlers";
import { registerMcpSettingsHandlers } from "./ipc/mcp-settings-handlers";
import {
	ensureNetworkSettingsBroadcast,
	registerNetworkSettingsHandlers,
	shouldClearPreviewCacheOnChange,
} from "./ipc/network-settings-handlers";
import { getOpenWithPromptHost } from "./ipc/open-with-prompt";
import { wireOpenWithPromptIpc } from "./ipc/open-with-prompt-ipc";
import { getOsHandoffPromptHost } from "./ipc/os-handoff-prompt";
import { wireOsHandoffPromptIpc } from "./ipc/os-handoff-prompt-ipc";
import { registerPairingHandlers } from "./ipc/pairing-handlers";
import { registerProfileHandlers } from "./ipc/profile-handlers";
import {
	ensurePropertiesBroadcast,
	registerPropertiesHandlers,
	republishPropertiesSnapshot,
} from "./ipc/properties-handlers";
import { registerDashboard } from "./ipc/renderer-identity";
import { registerSearchHandlers } from "./ipc/search-handlers";
import { registerShortcutsHandlers } from "./ipc/shortcuts-handlers";
import { registerSpellcheckHandlers } from "./ipc/spellcheck-handlers";
import { registerSyncStatusHandlers } from "./ipc/sync-status-handlers";
import { registerAutoUpdateHandlers, registerUpdateHandlers } from "./ipc/update-handlers";
import { registerVaultHandlers } from "./ipc/vault-handlers";
import { registerVaultLockHandlers } from "./ipc/vault-lock-handlers";
import { registerWebPrivacyHandlers } from "./ipc/web-privacy-handlers";
import { registerWidgetBridgeHandlers } from "./ipc/widget-bridge-handlers";
import { registerWindowsHandlers } from "./ipc/windows-handlers";
import {
	type MailSessionSyncHandle,
	listEnabledMailAccountIds,
	startMailSessionSync,
} from "./mailbox/mail-session-registration";
import { GMAIL_TOKEN_URL, type MailServiceApi, createMailService } from "./mailbox/mailbox-service";
import { createWorkerMailTransport } from "./mailbox/worker-mail-transport";
import { recordMcpCall } from "./mcp/mcp-audit-log";
import { connectMcpServer } from "./mcp/mcp-connect";
import { makeMcpServiceHandler } from "./mcp/mcp-service";
import { nodeStdioSpawn } from "./mcp/mcp-stdio-spawn";
import { makeFileAuditSink } from "./network/audit-log";
import { executeNetworkFetch } from "./network/network-service";
import {
	makeNetworkServiceHandler,
	productionApplyProxyConfig,
	productionFetchImpl,
	productionLookupHost,
} from "./network/network-service-handler";
import { LinkPreviewCache } from "./network/preview-cache";
import { schedulePreviewCachePrune } from "./network/preview-cache-scheduler";
import { DEFAULT_ON_PRIVACY } from "./network/privacy-config";
import { DEFAULT_PROXY_CONFIG } from "./network/proxy-config";
import { makePlatformServiceHandler } from "./platform/platform-service";
import { makePropertiesServiceHandler } from "./properties/properties-service";
import { UsageIndex } from "./properties/usage-index";
import { mentionTargets, shouldNotify } from "./roster/mention-notifier";
import { makeRosterServiceHandler } from "./roster/roster-service";
import { deepLinkFromArgv, parseEntityDeepLink } from "./runtime/deep-link";
import { createLaunchSetup } from "./runtime/launch-setup";
import { SHELL_ACTION_CHANNEL, createMenuSetup } from "./runtime/menu-setup";
import { createShortcutSetup } from "./runtime/shortcut-setup";
import { collectIndexableEntities } from "./search/collect-indexable";
import { StubEmbedder } from "./search/embedder";
import { SearchIndexer, pickIndexable } from "./search/search-indexer";
import { makeSearchServiceHandler } from "./search/search-service";
import { type VectorIndexer, createVectorIndexer } from "./search/vector-indexer";
import { SelectionStore, makeSelectionServiceHandler } from "./selection/selection-service";
import { makeSettingsServiceHandler } from "./settings/settings-service";
import { makeSharingServiceHandler } from "./sharing/sharing-service";
import { setActiveShortcutRegistry } from "./shortcuts/active-registry";
import { migrateBindingsFileToEntity, readOverridesFromEntity } from "./shortcuts/bindings-entity";
import type { ShortcutRegistry } from "./shortcuts/shortcut-registry";
import { makeShortcutsServiceHandler } from "./shortcuts/shortcuts-service";
import { makeSpellcheckServiceHandler } from "./spellcheck/spellcheck-service";
import { AssetRefsRepository, EntitiesRepository } from "./storage/entities-repo";
import { AppsRepository } from "./storage/registry-repo/apps-repo";
import { BlocksRepository } from "./storage/registry-repo/blocks-repo";
import { EntityTypesRepository } from "./storage/registry-repo/entity-types-repo";
import { SchedulerFiresRepository } from "./storage/registry-repo/scheduler-fires-repo";
import { SettingsRepository } from "./storage/settings-repo";
import { getActiveRelay } from "./sync/active-relay";
import {
	disposeLiveSyncEngine,
	getLiveSyncEngine,
	installLiveSyncEngine,
} from "./sync/live-sync-wiring";
import { RestoreEngine } from "./sync/restore-engine";
import { getRestoreEngine, setRestoreEngine } from "./sync/restore-wiring";
import { SelectiveSyncStore, selectiveSyncPolicyPath } from "./sync/selective-sync-store";
import { ThemePreviewService, makeThemeServiceHandler } from "./theme/theme-preview-service";
import { getUiNotifyHost } from "./ui/notify-host";
import { makeOsNotifier } from "./ui/os-notification-host";
import { type ComposedTray, getTrayHost } from "./ui/tray-host";
import { makeUiServiceHandler } from "./ui/ui-service";
import { AutoUpdateEngine } from "./update/auto-update-engine";
import { createElectronAutoUpdater, isAutoUpdateSupported } from "./update/electron-auto-updater";
import { DEFAULT_UPDATE_FEED_URL, fetchUpdateFeedJson } from "./update/update-feed-fetch";
import { UpdatePrefsStore, updatePrefsPath } from "./update/update-prefs-store";
import { UpdateService } from "./update/update-service";
import { readAiSettings } from "./vault/ai-settings-store";
import { appActivityIdleSeconds, noteAppActivity } from "./vault/app-activity-tracker";
import { createAppLockWatcher } from "./vault/app-lock-watcher";
import { readRegistry, writeRegistry } from "./vault/registry";
import {
	ROOT_FOLDER_ENTITY_ID,
	type VaultSession,
	activeVaultHasPin,
	getActiveVaultAutoLockMinutes,
	getActiveVaultSession,
	isVaultLocked,
	lockOnBootIfPinSet,
	onActiveVaultSessionChanged,
} from "./vault/session";
import { activateVault, getDefaultVault } from "./vault/vault";
import { CookieJarRepository, createWebCookieJar } from "./web/web-cookie-jar";
import { createWebPrivacyRuntime } from "./web/web-privacy-runtime";
import { createLockedWebView } from "./web/web-view-factory";
import { PERSISTENT_WEB_PARTITION, makeWebViewServiceHandler } from "./web/web-view-service";
import { brainstormChromeOptions } from "./window/chrome-options";
import { DockActivation, resolveDockActivation } from "./window/dashboard-activation";
import { focusStealingDisabled, revealWindow } from "./window/reveal-window";
import { type WorkersHandle, setWorkersHandle, startWorkers } from "./workers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const isMac = process.platform === "darwin";

// Dogfood build flag: force-enable DevTools (the Alt+Cmd+I toggle) even in the
// packaged app for local inspection. SECURITY (13.8): a real distributable
// MUST set this back to `isDev` — an always-available inspector defeats the
// lock screen and exposes renderer state. Not safe to distribute while true.
const DEVTOOLS_ENABLED = true;

// Packaged builds run under the product name "Brainstorm" so their userData
// (and the single-instance lock keyed on it) is distinct from a developer's
// `electron-vite dev` session, whose app name stays the package name
// `@brainstorm/shell`. Without this, launching the packaged app while `bun run
// dev` is open makes `requestSingleInstanceLock()` fail and the packaged app
// silently quits. Must run before the first `getPath("userData")` access
// (the single-instance lock below). Dev is intentionally left untouched.
if (!isDev) {
	app.setName("Brainstorm");
}

// Bundled brand wallpapers copied into each new vault's `dashboard/wallpapers/`
// so a fresh vault opens on-brand. The light slot opens on the Rose pitch
// wallpaper (the warm low-poly peaks that pairs with the default Rose theme);
// the dark slot keeps the stormy-sea image the welcome screen uses.
const DEFAULT_LIGHT_WALLPAPER_FILE = "rose-peaks.jpg";
const DEFAULT_DARK_WALLPAPER_FILE = "stormy-sea.png";
// Suffix the dashboard appends to derive a wallpaper's blur-up thumbnail URL
// (mirrors `THUMB_SUFFIX` in dashboard-handlers / wallpaper.ts).
const WALLPAPER_THUMB_SUFFIX = ".thumb.jpg";

// 10.9c — boot instrumentation. Captured at module-load time so every
// `bootStage(name)` call below reports wall-clock elapsed against the
// SAME zero. The 10.9b smoke v3/v4/v5 all hung between BOOT and dashboard
// window creation; the markers below pinpoint WHERE so a subsequent
// soak attempt either succeeds or reveals the exact stalled milestone.
const BOOT_START = Date.now();
function bootStage(stage: string): void {
	console.log(`[brainstorm/boot] ${stage} ${Date.now() - BOOT_START}`);
}

// During shutdown, child stdio pipes may close before the main process is
// finished writing logs. Without explicit error listeners, the resulting
// EPIPE bubbles up as an Uncaught Exception dialog. Best-effort silencing.
process.stdout.on?.("error", () => undefined);
process.stderr.on?.("error", () => undefined);
process.on("uncaughtException", (err) => {
	if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
	forwardMainErrorToRenderer(err);
});
process.on("unhandledRejection", (reason) => {
	forwardMainErrorToRenderer(reason);
});

const MAIN_ERROR_CHANNEL = "main:error" as const;

function forwardMainErrorToRenderer(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error("[brainstorm] main process error:", error);
	const target = dashboardWindow;
	if (!target || target.isDestroyed()) return;
	try {
		target.webContents.send(MAIN_ERROR_CHANNEL, { message });
	} catch {
		// Best-effort — the renderer may already be gone.
	}
}

// Register the `brainstorm://` privileged scheme BEFORE app is ready so the
// renderer can fetch vault-scoped assets (wallpapers etc.) without crossing
// the http→file boundary that Electron correctly blocks by default.
protocol.registerSchemesAsPrivileged([
	{
		scheme: "brainstorm",
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			stream: true,
			corsEnabled: true,
		},
	},
	// `bsblock://` — the BP block sandbox origin (see block-frame-protocol.ts).
	// Standard scheme so a block document doesn't inherit the embedder's CSP.
	BLOCK_FRAME_SCHEME_PRIVILEGE,
	// `bswidget://` — the dashboard widget iframe origin (widget-frame-protocol.ts).
	WIDGET_FRAME_SCHEME_PRIVILEGE,
]);

function registerBrainstormProtocol(): void {
	protocol.handle("brainstorm", async (request) => {
		const url = new URL(request.url);
		// brainstorm://wallpaper/<filename>  — vault-scoped wallpapers, encrypted
		// at rest (OQ-240): the serve helper decrypts a sealed blob (or streams a
		// legacy plaintext file) and rejects path traversal the same way.
		if (url.host === "wallpaper") {
			const session = getActiveVaultSession();
			if (!session) return new Response(null, { status: 404 });
			// Encrypted at rest (OQ-240): the serve helper decrypts a sealed blob
			// (or streams a legacy plaintext file) and rejects path traversal.
			const served = await serveVaultMedia(
				session.vaultPath,
				VaultMediaDomain.Wallpaper,
				url.pathname,
				session,
			);
			if (served.status !== 404) return served;
			// The dashboard requests a `<file>.thumb.jpg` blur-up underlay for
			// every image wallpaper, but the seeded default's thumbnail is never
			// minted (thumbs are minted on upload) — so it 404'd on every boot
			// (F-246). Lazy-mint it from the original (decrypting if sealed,
			// re-sealing the thumb) at the one chokepoint: heals new AND existing
			// vaults, no boot-time work.
			const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
			if (!relative.endsWith(WALLPAPER_THUMB_SUFFIX)) return served;
			const base = join(session.vaultPath, "dashboard", "wallpapers");
			const originalName = relative.slice(0, -WALLPAPER_THUMB_SUFFIX.length);
			const original = normalize(join(base, originalName));
			if (!original.startsWith(base + sep) && original !== base) return served;
			try {
				const raw = await readFile(original);
				const plain = isSealedMedia(raw)
					? Buffer.from(session.openMedia(VaultMediaDomain.Wallpaper, originalName, raw))
					: raw;
				await ensureThumbnail(base, originalName, plain, (name, b) =>
					session.sealMedia(VaultMediaDomain.Wallpaper, name, b),
				);
				return await serveVaultMedia(
					session.vaultPath,
					VaultMediaDomain.Wallpaper,
					url.pathname,
					session,
				);
			} catch {
				return new Response(null, { status: 404 });
			}
		}
		// brainstorm://emoji/<codepoint>.webp  — built-in emoji glyphs from
		// the shell's art directory (iamcal/emoji-data img-apple-160 set,
		// re-encoded WebP q80). Static shell assets — no vault required,
		// no path-traversal beyond the filename pattern check.
		if (url.host === "emoji") {
			const file = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
			if (!/^[0-9a-f-]+\.webp$/.test(file)) {
				return new Response(null, { status: 400 });
			}
			const artDir = isDev ? join(__dirname, "../../art") : join(process.resourcesPath, "art");
			const target = normalize(join(artDir, "emoji", file));
			const baseEmoji = join(artDir, "emoji");
			if (!target.startsWith(baseEmoji + sep)) {
				return new Response(null, { status: 403 });
			}
			// A glyph newer than the bundled set (e.g. Emoji-14+ 1faea/1faef) has
			// no webp — return a clean 404 instead of letting net.fetch on a
			// missing file:// throw and surface as ERR_UNEXPECTED in the renderer.
			if (!(await stat(target).catch(() => null))) {
				return new Response(null, { status: 404 });
			}
			const upstream = await net.fetch(pathToFileURL(target).toString());
			if (!upstream.ok) return upstream;
			const headers = new Headers(upstream.headers);
			// Codepoint-keyed and shipped with the bundle — never changes.
			// Long-lived caching keeps the icon picker scroll fast when rows
			// remount through the virtualizer.
			headers.set("Cache-Control", "public, max-age=31536000, immutable");
			return new Response(upstream.body, { status: upstream.status, headers });
		}
		// brainstorm://icon/<sha256>.<ext>  — user-uploaded icon images for the
		// universal icon model (foundations/39-universal-icons.md). Encrypted at
		// rest (OQ-240) + path-traversal rejected by the shared serve helper.
		if (url.host === "icon") {
			const session = getActiveVaultSession();
			if (!session) return new Response(null, { status: 404 });
			return serveVaultMedia(session.vaultPath, VaultMediaDomain.Icon, url.pathname, session);
		}
		// brainstorm://cover/<sha256>.<ext>  — user-uploaded cover images
		// (foundations/50-object-covers.md, B7.2). Encrypted at rest (OQ-240).
		if (url.host === "cover") {
			const session = getActiveVaultSession();
			if (!session) return new Response(null, { status: 404 });
			return serveVaultMedia(session.vaultPath, VaultMediaDomain.Cover, url.pathname, session);
		}
		// brainstorm://app-icon/<appId>  — manifest-declared icon asset.
		// The handler reads the installed bundle's manifest, validates the
		// icon path stays inside the bundle, and streams it. Apps without a
		// declared icon get 404 — the renderer falls back to initials.
		if (url.host === "app-icon") {
			const session = getActiveVaultSession();
			if (!session) return new Response(null, { status: 404 });
			const appId = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
			if (!appId || appId.includes("..") || appId.includes("/")) {
				return new Response(null, { status: 400 });
			}
			const target = await resolveAppIconPath(appId);
			if (!target) return new Response(null, { status: 404 });
			const response = await net.fetch(pathToFileURL(target).toString());
			const headers = new Headers(response.headers);
			// A `?v=<version>` request is immutable: the renderer cache-busts on
			// app update, so the bytes for a given version never change. Caching
			// them aggressively means lock→unlock and relaunch repaint icons from
			// cache instead of re-reading every bundle off disk (no placeholder
			// flash). Unversioned requests stay `no-cache` to be safe. Mirrors the
			// emoji handler above.
			headers.set(
				"Cache-Control",
				url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "no-cache",
			);
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}
		// brainstorm://app-file/<appId>/<sha256>.<ext>  — content-addressed
		// app upload written via `storage.uploadFile`. Files live at
		// `<vault>/data/apps/<appId>/files/`. v1 lets any renderer fetch any
		// app's files (notes embed images from their own app, no cross-app
		// reads happen yet). When apps start embedding each other's content
		// the protocol grows an explicit grant check.
		if (url.host === "app-file") {
			const session = getActiveVaultSession();
			if (!session) return new Response(null, { status: 404 });
			const segments = url.pathname.replace(/^\/+/, "").split("/");
			if (segments.length !== 2) return new Response(null, { status: 400 });
			const appSeg = segments[0];
			const fileSeg = segments[1];
			if (!appSeg || !fileSeg) return new Response(null, { status: 400 });
			const appId = decodeURIComponent(appSeg);
			const file = decodeURIComponent(fileSeg);
			if (!/^[A-Za-z0-9._-]+$/.test(appId)) {
				return new Response(null, { status: 400 });
			}
			if (!/^[0-9a-f]{64}\.[a-z0-9]+$/.test(file)) {
				return new Response(null, { status: 400 });
			}
			const base = join(session.vaultPath, "data", "apps", appId, "files");
			const target = normalize(join(base, file));
			if (!target.startsWith(base + sep)) {
				return new Response(null, { status: 403 });
			}
			return net.fetch(pathToFileURL(target).toString());
		}
		// brainstorm://asset/<assetId>  — encrypted binary asset (favicon /
		// cover / future uploads). Unlike the plaintext stores above, the
		// bytes are decrypted in-process via the per-asset DEK before serving;
		// without an unlocked vault (master key) nothing decrypts. Validation
		// + fail-closed posture live in `resolveAssetForServe`; access
		// enforcement beyond "session active" is OQ-237.
		if (url.host === "asset") {
			const session = getActiveVaultSession();
			if (!session) return new Response(null, { status: 404 });
			const assetId = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
			const store = await session.assetStore();
			const result = await resolveAssetForServe(store, assetId);
			if (!result.ok) return new Response(null, { status: result.status });
			const headers = new Headers();
			headers.set("Content-Type", result.mime);
			// Decrypted vault bytes — don't let them linger in a shared cache.
			headers.set("Cache-Control", "no-store");
			return new Response(Buffer.from(result.bytes), { status: 200, headers });
		}
		return new Response(null, { status: 404 });
	});
}

async function resolveAppIconPath(appId: string): Promise<string | null> {
	const session = getActiveVaultSession();
	if (!session) return null;
	const registry = await session.dataStores.open("registry");
	const repo = new AppsRepository(registry);
	const record = repo.getActive(appId);
	if (!record) return null;
	let manifest: { icon?: unknown };
	try {
		const raw = await readFile(join(record.bundleDir, "manifest.json"), "utf8");
		manifest = JSON.parse(raw) as { icon?: unknown };
	} catch {
		return null;
	}
	if (typeof manifest.icon !== "string" || manifest.icon.length === 0) return null;
	if (manifest.icon.includes("..")) return null;
	const target = normalize(join(record.bundleDir, manifest.icon));
	if (!target.startsWith(record.bundleDir + sep) && target !== record.bundleDir) {
		return null;
	}
	return target;
}

function resolveIconPath(): string {
	const artDir = isDev ? join(__dirname, "../../art") : join(process.resourcesPath, "art");
	// PNG is the universal format for nativeImage at runtime (icns parsing in
	// nativeImage is unreliable). The .icns file is reserved for the production
	// app bundle, where electron-builder embeds it as the .app icon via its own
	// configuration — not loaded through nativeImage at runtime.
	return join(artDir, "icon.png");
}

// Window chrome (titleBar + traffic-light position) lives in
// `./window/chrome-options.ts` so the dashboard and app windows share one
// source of truth. Phase 6 of the apps-lifecycle plan will replace this with
// the full glass-chrome treatment.

function createDashboardWindow(): BrowserWindow {
	const iconImage = nativeImage.createFromPath(resolveIconPath());

	const window = new BrowserWindow({
		width: 1280,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		title: "Brainstorm",
		icon: iconImage,
		// Match the default theme's primary surface so the first paint
		// (before the renderer mounts and `ControlledThemeProvider` swaps
		// in the persisted theme) doesn't flash a hardcoded colour. The
		// dashboard-handlers' tokens broadcast retargets this as soon as a
		// vault session loads, so once the user picks a non-default theme
		// the bg follows.
		backgroundColor: themes[DEFAULT_THEME].color.background.primary,
		show: false,
		autoHideMenuBar: true,
		...brainstormChromeOptions(),
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			// Dev only: in a packaged build the inspector must not be available to
			// defeat the lock screen / inspect renderer state (13.8 security).
			devTools: DEVTOOLS_ENABLED,
		},
	});

	window.once("ready-to-show", () => {
		revealWindow(window);
	});

	const rendererUrl = process.env.ELECTRON_RENDERER_URL;
	if (isDev && rendererUrl) {
		void window.loadURL(rendererUrl);
	} else {
		void window.loadFile(join(__dirname, "../renderer/index.html"));
	}

	return window;
}

function setupSingleInstance(): void {
	const gotLock = app.requestSingleInstanceLock();
	if (!gotLock) {
		app.quit();
		return;
	}
	app.on("second-instance", (_event, argv) => {
		const existing = BrowserWindow.getAllWindows()[0];
		if (existing) {
			if (existing.isMinimized()) existing.restore();
			existing.focus();
		}
		// Windows / Linux deliver a deeplink to the already-running instance as a
		// launch argument on the second instance's argv.
		const link = deepLinkFromArgv(argv);
		if (link) handleInboundDeepLink(link);
	});
}

// Diagnostics first — before any window or worker exists — so a crash
// during early boot is still captured. Every WebContents (shell + every
// sandboxed app window, created later in launch-setup) is wired here via
// the global hook, so there's a single point of capture.
installMainProcessLogging();
app.on("web-contents-created", (_event, contents) => {
	attachWebContentsLogging(contents);
	// Feedback-1 — feed the per-window console.warn/.error stream into
	// the in-memory ring buffer too. The diagnostics sink above writes
	// NDJSON to disk for triage; the ring buffer is purely RAM-resident
	// and only surfaces if the user opts in on a specific feedback
	// report. Scope label matches the diagnostics convention.
	let url = "";
	try {
		url = contents.getURL();
	} catch {
		url = "";
	}
	getSharedRecentLogBuffer().attach(contents, scopeForUrl(url));
});

setupSingleInstance();

// ── Inbound OS deeplinks (`brainstorm://entity/<id>` from a browser / mail /
// Spotlight) ─────────────────────────────────────────────────────────────
// The router is wired once the open path exists (in `whenReady`); links that
// arrive before then — a cold-start `open-url` on macOS, or the launch argv —
// queue here and flush once ready.
const pendingDeepLinks: string[] = [];
let deepLinkRouter: ((url: string) => void) | null = null;
function handleInboundDeepLink(url: string): void {
	if (deepLinkRouter) deepLinkRouter(url);
	else pendingDeepLinks.push(url);
}

// Register as the OS handler for the `brainstorm://` scheme so external
// deeplinks launch/focus us. In dev the running binary is Electron itself, so
// the relaunch command must carry execPath + the entry script.
if (process.defaultApp) {
	const entry = process.argv[1];
	if (entry) app.setAsDefaultProtocolClient("brainstorm", process.execPath, [normalize(entry)]);
} else {
	app.setAsDefaultProtocolClient("brainstorm");
}
// macOS delivers deeplinks via `open-url` — it can fire on cold start before a
// window exists, so the URL is queued (above) until the router is ready.
app.on("open-url", (event, url) => {
	event.preventDefault();
	handleInboundDeepLink(url);
});

let workers: WorkersHandle | null = null;
let dashboardWindow: BrowserWindow | null = null;

const FULLSCREEN_CHANNEL = "window:fullscreen-changed" as const;

// Set once at bootstrap (where `launchSetup` is in scope). Lets the
// module-level dashboard tracker stamp the dashboard's last-focus on the same
// monotonic clock as app windows, so dock-click activation can compare them.
let stampDashboardFocus: (() => void) | null = null;

function registerAndTrack(window: BrowserWindow): void {
	if (!workers) return;
	const webContentsId = window.webContents.id;
	registerDashboard(workers.context.identities, webContentsId);
	window.on("focus", () => stampDashboardFocus?.());
	const emitFullscreen = () => {
		if (window.isDestroyed()) return;
		window.webContents.send(FULLSCREEN_CHANNEL, window.isFullScreen());
	};
	window.on("enter-full-screen", emitFullscreen);
	window.on("leave-full-screen", emitFullscreen);
	window.on("closed", () => {
		workers?.context.identities.unregister(webContentsId);
		if (dashboardWindow === window) {
			dashboardWindow = null;
		}
	});
}

ipcMain.handle("window:is-fullscreen", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	return win ? win.isFullScreen() : false;
});

async function autoActivateDefaultVault(): Promise<void> {
	const entry = await getDefaultVault().catch(() => null);
	bootStage("vault-catalog-scanned");
	if (!entry) {
		bootStage("vault-restored-none");
		return;
	}
	try {
		await activateVault(entry.id);
		// 13.8 — a vault with an app-lock PIN boots LOCKED so a cold launch
		// re-prompts for the PIN, exactly like idle/sleep auto-lock. Engage the
		// lock BEFORE warming the ledger: a keyring hard-lock disposes the
		// freshly-opened session, so warming it first would be wasted work — the
		// ledger re-warms lazily after `vault:unlock`. The dashboard reads
		// `vault:lock-status` on mount and renders only the lock screen.
		if ((await lockOnBootIfPinSet()) !== null) {
			bootStage("vault-restored-locked");
		} else {
			await workers?.context.warmupLedger();
			bootStage("vault-restored");
		}
	} catch (error) {
		console.warn(
			`[brainstorm] auto-activate default vault failed (${entry.id}): ${(error as Error).message}`,
		);
		// Clear the broken default so the renderer falls back to the welcome
		// screen instead of showing a dashboard whose backing session never
		// loaded. The registry entry itself stays so the user can still pick
		// the vault explicitly (and supply a passphrase, recover, etc.).
		try {
			const registry = await readRegistry();
			if (registry.defaultVaultId === entry.id) {
				registry.defaultVaultId = null;
				await writeRegistry(registry);
			}
		} catch (clearError) {
			console.warn("[brainstorm] failed to clear broken default vault:", clearError);
		}
		bootStage("vault-restored-none");
	}
}

void app.whenReady().then(async () => {
	// Net-1c — process-singleton link-preview cache (24h TTL, 1024-entry
	// LRU). Declared at the top of the IIFE so vault-switch hooks
	// further down can capture it for `clear()` calls without crossing
	// a temporal-dead-zone boundary when the boot vault is already
	// open at start.
	const previewCache = new LinkPreviewCache();
	// Net-1c — periodic prune so expired entries don't sit in memory
	// until the LRU cap evicts them. Default 30 min cadence. The
	// scheduler stops on shutdown via the `before-quit` hook below.
	const previewCachePruner = schedulePreviewCachePrune({ cache: previewCache });
	app.on("before-quit", () => {
		previewCachePruner.stop();
	});

	if (isMac && app.dock) {
		// `app.dock.hide()` switches the activation policy to Accessory,
		// which on macOS forces NSEvent posting changes that break
		// Playwright's WebContents handle ("Target page, context or browser
		// has been closed" inside the typing loop). The `showInactive()`
		// path below already prevents focus theft on each new window; we
		// don't need to hide the dock icon to achieve the no-focus UX, and
		// the Accessory activation policy has too many side effects for
		// the Playwright harness.
		const iconPath = resolveIconPath();
		const dockIcon = nativeImage.createFromPath(iconPath);
		if (dockIcon.isEmpty()) {
			console.warn(`[brainstorm] failed to load dock icon from ${iconPath}`);
		} else {
			app.dock.setIcon(dockIcon);
		}
	}

	workers = startWorkers(__dirname);
	bootStage("workers-spawned");
	setWorkersHandle(workers);
	registerVaultHandlers();
	registerBrokerHandler({
		// Foreground app IPC counts as user activity for auto-lock — only when a
		// Brainstorm window is focused, so a background/unfocused renderer polling
		// the broker can't hold the lock open after the user walks away.
		noteActivity: () => {
			if (BrowserWindow.getFocusedWindow() !== null) noteAppActivity();
		},
	});
	registerSpellcheckHandlers();
	registerLedgerHandlers();
	registerBrainstormProtocol();
	registerBlockFrameProtocol({
		getBlocksRepo: async () => {
			const session = getActiveVaultSession();
			if (!session) return null;
			return new BlocksRepository(await session.dataStores.open("registry"));
		},
	});
	// `bswidget://<appId>/…` — serves a widget app's bundle to its dashboard
	// iframe from a distinct origin (Stage 7.3b).
	registerWidgetFrameProtocol({
		entryCache: new Map(),
		getAppRecord: async (appId) => {
			const session = getActiveVaultSession();
			if (!session) return null;
			const record = new AppsRepository(await session.dataStores.open("registry")).getActive(appId);
			return record ? { bundleDir: record.bundleDir, bundleSha256: record.bundleSha256 } : null;
		},
	});

	await autoActivateDefaultVault();

	// OQ-240 — re-seal any legacy plaintext cover/icon/wallpaper files at rest
	// on every vault open (idempotent; sealed files are skipped). Fire-and-
	// forget so it never delays activation.
	const migrateMedia = (session: VaultSession | null) => {
		if (session) {
			void session.migrateMediaAtRest().catch((error) => {
				console.warn("[brainstorm] media at-rest migration failed:", error);
			});
		}
	};
	onActiveVaultSessionChanged(migrateMedia);
	migrateMedia(getActiveVaultSession());

	// Mailbox-4 — late-bound shell-side handler for the `send` intent verb.
	// The mail service is built after launch setup (it needs the worker
	// bridge), so the bus reads through this ref per dispatch. Fail closed
	// until it is assigned.
	let mailServiceApi: MailServiceApi | null = null;
	const launchSetup = createLaunchSetup({
		mainDir: __dirname,
		identities: workers.context.identities,
		// Closing the last visible app window hands focus back to the
		// dashboard — without this, a fullscreen/Spaces session is left on an
		// empty black Space after the app window hides.
		revealDashboard: () => {
			if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
			if (dashboardWindow.isMinimized()) dashboardWindow.restore();
			revealWindow(dashboardWindow);
			if (!focusStealingDisabled()) dashboardWindow.focus();
		},
		sendMail: (payload, _sourceApp) => {
			const api = mailServiceApi;
			if (!api) {
				const err = new Error("mail service unavailable");
				err.name = "Unavailable";
				throw err;
			}
			return api.send(payload);
		},
	});
	stampDashboardFocus = () => launchSetup.stampDashboardFocus();

	// Inbound-deeplink router: parse `brainstorm://entity/<id>`, focus the
	// dashboard, and dispatch an `open` for that entity through the same ladder
	// a dashboard link uses (shell-sourced). Then flush any links queued during
	// boot + the cold-start launch argv.
	deepLinkRouter = (url: string) => {
		const entityId = parseEntityDeepLink(url);
		if (!entityId) return;
		if (dashboardWindow && !dashboardWindow.isDestroyed()) {
			if (dashboardWindow.isMinimized()) dashboardWindow.restore();
			revealWindow(dashboardWindow);
			if (!focusStealingDisabled()) dashboardWindow.focus();
		}
		void launchSetup
			.getIntents()
			.then((intents) =>
				intents?.dispatch({ verb: OPEN_VERB, payload: { entityId } }, { app: SHELL_INTENT_SOURCE }),
			)
			.catch((error) => console.warn("[deep-link] open dispatch failed:", error));
	};
	const coldLink = deepLinkFromArgv(process.argv);
	if (coldLink) pendingDeepLinks.push(coldLink);
	for (const queued of pendingDeepLinks.splice(0)) deepLinkRouter(queued);

	// The dashboard renderer gets the same external-link guard as app tab
	// views: links route through the open ladder (shell-sourced, so the
	// OS-handoff option stays available) instead of Electron's default
	// popup window.
	const wireDashboardLinkRouting = (wc: Electron.WebContents) =>
		wireExternalLinkRouting(wc, (url) => {
			void launchSetup
				.getIntents()
				.then((intents) =>
					intents?.dispatch({ verb: OPEN_VERB, payload: { url } }, { app: SHELL_INTENT_SOURCE }),
				)
				.catch((error) => console.warn("[intents] dashboard link dispatch failed:", error));
		});
	// Stage 7.3 — dashboard widget host. Each placed widget is a broker-scoped
	// `WebContentsView` (the parent app's bundle in widget-mode) overlaid on the
	// dashboard window. The controller resolves specs asynchronously and drives
	// the synchronous `WidgetHost`; geometry + visibility come from the renderer
	// via `dashboard:layout-widgets`.
	const widgetController = new WidgetHostController({
		surfaceDeps: {
			identities: workers.context.identities,
			getMountPoint: () =>
				dashboardWindow && !dashboardWindow.isDestroyed()
					? (dashboardWindow.contentView as unknown as ChildViewMount)
					: null,
			createView: (spec) => {
				const view = new WebContentsView({
					webPreferences: {
						preload: spec.preloadPath,
						contextIsolation: true,
						sandbox: true,
						nodeIntegration: false,
						webSecurity: true,
						additionalArguments: spec.additionalArguments,
						devTools: DEVTOOLS_ENABLED,
						// We hide a widget view (`setVisible(false)`) while it's dragged so
						// the native overlay doesn't separate from its moving card chrome.
						// Chromium's default background throttling then suspends the hidden
						// view, so on drop it wakes + repaints with a visible ~1s blank.
						// Off-screen pausing is done explicitly via the app-visibility
						// channel (OQ-6), so throttling here only hurts — turn it off.
						backgroundThrottling: false,
					},
				});
				view.setBackgroundColor(spec.backgroundColor);
				return view as unknown as WebContentsViewHandle;
			},
		},
		preloadPath: join(__dirname, "../preload/app-preload.js"),
		getActiveSession: () => getActiveVaultSession(),
	});
	// Stage 7.3b: widgets now render as sandboxed iframes in the dashboard
	// renderer (DashboardWidgetsLayer + the widget-bridge), NOT native
	// WebContentsView overlays — so a DOM widget clips to its card, z-orders under
	// menus/DevTools, and drags/resizes smoothly. Reconcile to ZERO native
	// surfaces (the controller still tears any down on vault change); the native
	// host wiring stays dormant for now. Full removal is a follow-up.
	setWidgetSnapshotHook(() => {
		void widgetController.reconcile([]);
	});
	// No snapshot fires without a session, so tear surfaces down explicitly when
	// the vault locks / closes / switches away.
	onActiveVaultSessionChanged((session) => {
		if (!session) widgetController.destroyAll();
	});
	// Renderer-reported geometry + visibility for the native overlays.
	ipcMain.handle("dashboard:layout-widgets", (_event, layouts: unknown) => {
		widgetController.layout(Array.isArray(layouts) ? layouts : []);
	});

	registerAppsHandlers({
		getOrchestrator: () => launchSetup.getOrchestrator(),
		getLauncherSync: () => launchSetup.getLauncherSync(),
		onSessionRebuilt: (listener) => launchSetup.onSessionRebuilt(listener),
		getDashboard: () => dashboardWindow,
		closeAppWindows: (appId) => {
			launchSetup.closeAppWindows(appId);
			// Uninstall: drop the app's live widget surfaces immediately (the
			// placement lingers in the dashboard doc but resolves to nothing).
			widgetController.destroyForApp(appId);
		},
	});
	registerWindowsHandlers({
		launchSetup,
		getDashboard: () => dashboardWindow,
	});
	registerChromeTabsHandlers({
		getLauncher: () => launchSetup.getLauncherSync(),
		getOrchestrator: () => launchSetup.getOrchestrator(),
	});
	registerDashboardHandlers(
		() => dashboardWindow,
		() => launchSetup.getLauncherSync()?.allWindows() ?? [],
	);
	// Widget iframe bridge (Stage 7.3b): the dashboard renderer proxies a
	// sandboxed widget iframe's calls here, capability-scoped to the widget's app.
	registerWidgetBridgeHandlers({
		getIntents: () => launchSetup.getIntents(),
	});
	// Widget iframes have no own webContents, so route the vault-entities
	// staleness signal to the dashboard window too — its parent bridge forwards
	// it to each subscribed widget iframe.
	setVaultEntitiesStaleExtraTarget(() =>
		dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : null,
	);
	// Feedback-3 + Help-1 — bundled changelog and Help corpus served via
	// `help:get-changelog` / `help:get-topic` / `help:search`. No vault
	// session required (both are build artifacts). The help-handlers
	// module owns the ~100 KB `corpus.json` static import; dynamic-importing
	// pushes that weight out of the main bundle into a lazy chunk that
	// resolves before any IPC request lands (boot finishes after this
	// promise has plenty of time to settle).
	void import("./ipc/help-handlers")
		.then(({ registerHelpHandlers, ensureHelpIndexer }) => {
			registerHelpHandlers(ipcMain);
			// Warm the help_fts index from the bundled corpus on boot so the
			// first `help:search` call doesn't pay the rebuild latency in the
			// user-visible path. Failures here are non-fatal (the on-demand
			// call inside `help:search` retries; we only log).
			void ensureHelpIndexer().catch((error) => {
				console.error("[brainstorm] help: failed to warm help indexer:", error);
			});
		})
		.catch((error) => {
			console.error("[brainstorm] help: failed to load help-handlers chunk:", error);
		});
	registerPropertiesHandlers(() => dashboardWindow, {
		getAppWindows: () => launchSetup.getLauncherSync()?.allWindows() ?? [],
		getUsageIndex: () => usageIndex,
	});
	// Net-1e — per-vault privacy + proxy-override settings IPC. The
	// `onSettingsChanged` hook wipes the preview cache when the user
	// flips link-preview policy (Off→On, Allowlist host-list shrink,
	// etc.) so privacy-gone-cold doesn't leak through a stale cache.
	//
	// Net-1f — the same `registerNetworkSettingsHandlers` mounts six
	// new privileged read-only channels for the Settings → Privacy →
	// Network panel: `network-audit:recent` / `:blocked` / `:per-app-summary`
	// + `network-cache:stats` / `network-cache:clear` + `network-broker:state`.
	// Dashboard-only — never broker-exposed. The audit path closure is
	// the same one the file sink writes to, so the panel always reads
	// the live audit log.
	const networkAuditPath = join(app.getPath("userData"), "network-audit.jsonl");
	const aiUsagePath = join(app.getPath("userData"), "ai-usage.jsonl");
	// 11.9 — late-bound to the provider registry (built further down), so a
	// routing-default change from Settings → AI takes effect live. Null until
	// the registry exists; an already-open vault is applied post-registry below.
	let applyAiDefaultProvider: ((id: string | null) => void) | null = null;
	registerAiSettingsHandlers({
		aiUsagePath,
		applyDefaultProvider: (id) => applyAiDefaultProvider?.(id),
	});
	// MCP-3 — Settings → AI → MCP servers (dashboard-privileged, not broker).
	// The tools inspector connects over the HTTP transport (egress broker), so it
	// shares the network audit sink + SSRF/size/time guards; the auth secret is
	// resolved main-only inside `connectMcpServer`.
	registerMcpSettingsHandlers({
		fetchJson: async (input) => {
			const res = await executeNetworkFetch(
				{
					appId: "_shell.mcp",
					url: input.url,
					method: "POST",
					headers: { ...input.headers },
					body: new TextEncoder().encode(JSON.stringify(input.bodyJson)),
					timeoutMs: input.timeoutMs,
					sizeCapBytes: input.sizeCapBytes,
				},
				{
					fetchImpl: productionFetchImpl,
					lookupHost: productionLookupHost,
					auditSink: makeFileAuditSink(networkAuditPath),
				},
			);
			return { status: res.status, text: new TextDecoder().decode(res.body) };
		},
	});
	registerNetworkSettingsHandlers(() => dashboardWindow, {
		getAppWindows: () => launchSetup.getLauncherSync()?.allWindows() ?? [],
		onSettingsChanged: (next, previous) => {
			if (shouldClearPreviewCacheOnChange(next, previous)) {
				previewCache.clear();
			}
		},
		getAuditPath: () => networkAuditPath,
		getPreviewCache: () => previewCache,
	});

	// Feedback-1 — bug-report client. Shell-only `FeedbackService`
	// (never broker-exposed); the dashboard renderer reaches it through
	// privileged `feedback:*` IPC channels declared in
	// `feedback-handlers.ts`. The recent-log ring buffer is purely
	// in-memory (no on-disk persistence); webContents wiring lands per
	// window via the `web-contents-created` hook below so app console
	// output flows into the buffer too (the user typically wants to
	// attach a recent app error when reporting an app bug).
	const feedbackBuildTimeEndpoint =
		process.env.BRAINSTORM_FEEDBACK_ENDPOINT && process.env.BRAINSTORM_FEEDBACK_ENDPOINT.length > 0
			? process.env.BRAINSTORM_FEEDBACK_ENDPOINT
			: null;
	const feedbackSettingsStore = new FeedbackSettingsStore({
		path: feedbackSettingsPath(app.getPath("userData")),
		buildTimeDefaultEndpoint: feedbackBuildTimeEndpoint,
	});
	const feedbackRecentLogBuffer = getSharedRecentLogBuffer();
	const feedbackService = new FeedbackService({
		fetcher: defaultFeedbackFetcher,
		executeOptions: {
			fetchImpl: productionFetchImpl,
			lookupHost: productionLookupHost,
			auditSink: makeFileAuditSink(networkAuditPath),
		},
		settingsStore: feedbackSettingsStore,
		getVaultPath: () => getActiveVaultSession()?.vaultPath ?? null,
	});
	// Feedback-2 — opt-in crash reporter. Shell-only service (never
	// broker-exposed). Three pieces wire up here:
	//   1. CrashQueue under `<userData>/crash-reports/`.
	//   2. CrashReporterService composed with the queue + the same
	//      privileged network broker fetcher Feedback-1 uses (so audit log,
	//      SSRF guard, proxy rules all apply identically).
	//   3. installCrashHooks attaches process.on(uncaughtException) +
	//      unhandledRejection + the per-webContents render-process-gone
	//      + unresponsive listeners. The Crashpad bootstrap is also hooked
	//      with `uploadToServer: false` — we intercept locally and queue
	//      rather than letting Crashpad POST its own dumps; native dump
	//      capture is a follow-up rung (v1 = JS-side only).
	const crashQueue = new CrashQueue({ dir: crashQueueDir(app.getPath("userData")) });
	const crashBootStartMs = Date.now();
	const crashReporterService = new CrashReporterService({
		queue: crashQueue,
		settingsStore: feedbackSettingsStore,
		getVaultPath: () => getActiveVaultSession()?.vaultPath ?? null,
		clientVersion: app.getVersion(),
		clientPlatform: process.platform,
		readRecentLog: () => feedbackRecentLogBuffer.read(),
		newRequestId,
		fetcher: defaultFeedbackFetcher,
		executeOptions: {
			fetchImpl: productionFetchImpl,
			lookupHost: productionLookupHost,
			auditSink: makeFileAuditSink(networkAuditPath),
		},
		getBootStartMs: () => crashBootStartMs,
	});
	const { crashReporter: electronCrashReporter } = await import("electron");
	installCrashHooks({
		service: crashReporterService,
		app,
		crashReporter: electronCrashReporter,
	});

	registerFeedbackHandlers({
		service: feedbackService,
		recentLogBuffer: feedbackRecentLogBuffer,
		crashReporterService,
		crashQueue,
	});

	// 13.6 — manual-download update check (app-global). The shell's own
	// egress to a build-time-constant release feed; results carry only a
	// download page the renderer opens via the OS-handoff chokepoint.
	const updateFeedUrl =
		process.env.BRAINSTORM_UPDATE_FEED_URL && process.env.BRAINSTORM_UPDATE_FEED_URL.length > 0
			? process.env.BRAINSTORM_UPDATE_FEED_URL
			: DEFAULT_UPDATE_FEED_URL;
	const updatePrefsStore = new UpdatePrefsStore({
		path: updatePrefsPath(app.getPath("userData")),
	});
	registerUpdateHandlers(
		new UpdateService({
			prefs: updatePrefsStore,
			getCurrentVersion: () => app.getVersion(),
			fetchFeedJson: () => fetchUpdateFeedJson(updateFeedUrl),
		}),
	);

	// 13.12 — in-app auto-update on packaged builds (electron-updater). Shares
	// the 13.6 channel pref; pushes lifecycle state to the dashboard renderer.
	const autoUpdateEngine = new AutoUpdateEngine({
		updater: createElectronAutoUpdater(),
		getChannel: async () => (await updatePrefsStore.load()).channel,
		supported: isAutoUpdateSupported(),
		onState: (state) => {
			const target = dashboardWindow;
			if (!target || target.isDestroyed()) return;
			try {
				target.webContents.send(UPDATE_STATE_EVENT, state);
			} catch {
				// Best-effort — the renderer may already be gone.
			}
		},
	});
	registerAutoUpdateHandlers(autoUpdateEngine);

	const CRASH_SUBMIT_BOOT_DELAY_MS = 30_000;
	const CRASH_SUBMIT_INTERVAL_MS = 15 * 60_000;
	setTimeout(() => {
		void crashReporterService.submitPending().catch((error) => {
			console.warn(`[crash-reporter] boot submit failed: ${(error as Error).message}`);
		});
	}, CRASH_SUBMIT_BOOT_DELAY_MS).unref();
	const crashSubmitInterval = setInterval(() => {
		void crashReporterService.submitPending().catch((error) => {
			console.warn(`[crash-reporter] periodic submit failed: ${(error as Error).message}`);
		});
	}, CRASH_SUBMIT_INTERVAL_MS);
	crashSubmitInterval.unref?.();
	app.on("before-quit", () => {
		void (async () => {
			try {
				await crashQueue.prune();
			} catch (error) {
				console.warn(`[crash-reporter] before-quit prune failed: ${(error as Error).message}`);
			}
			try {
				await Promise.race([
					crashReporterService.submitPending(),
					new Promise((resolve) => setTimeout(resolve, 5_000)),
				]);
			} catch (error) {
				console.warn(`[crash-reporter] before-quit submit failed: ${(error as Error).message}`);
			}
		})();
	});

	// Subscribe to the active vault's PropertiesStore at boot + on every
	// session rebuild so app windows receive `app:properties-changed`
	// signals even when no dashboard read has warmed up the listener.
	void ensurePropertiesBroadcast(() => dashboardWindow);
	launchSetup.onSessionRebuilt(() => {
		void ensurePropertiesBroadcast(() => dashboardWindow);
	});
	registerMarketplaceHandlers({ mainDir: __dirname });
	registerIconsHandlers({ getDashboard: () => dashboardWindow });
	registerCoversHandlers({ getDashboard: () => dashboardWindow });
	registerImportExportHandlers({ getDashboard: () => dashboardWindow });
	registerFilesHandlesHandlers({ getDashboard: () => dashboardWindow });
	// Stage 10.5c — install the live-transport singleton BEFORE the pairing
	// handlers register (the pairing handlers read from it). The default
	// state is loopback — the first `setActiveVaultSession` after boot
	// triggers the orchestrator's `onSessionChanged` which reads vault.json
	// and rebuilds the port (`WebSocketRelayPort` when a `syncRelay` is
	// configured, loopback otherwise).
	{
		const { ActiveRelayOrchestrator, installActiveRelay } = await import("./sync/active-relay");
		const { WebSocketRelayPort } = await import("./sync/websocket-relay-port");
		const { makeChallengeResponder } = await import("./sync/challenge-responder");
		const { bytesToBase64Url } = await import("./pairing/pairing-channel");
		// SYNC-4b — the gated-admission challenge responder. Reads the LIVE vault
		// session lazily per challenge (account + identity signer) + the cached
		// entitlement token; returns null (stay open/unauthenticated) when there's
		// no session or no token — the v1 state. An open node never challenges, so
		// this stays dormant until a managed/gated node + a 14.3 token exist.
		const onChallenge = makeChallengeResponder({
			account: () => {
				const s = getActiveVaultSession();
				return s ? bytesToBase64Url(s.identity.publicKey) : null;
			},
			signNonce: (nonce) => {
				const s = getActiveVaultSession();
				return s ? s.signPayload(nonce) : null;
			},
			loadToken: async () => {
				const s = getActiveVaultSession();
				if (!s) return null;
				try {
					return (await s.billingService()).currentToken();
				} catch {
					return null;
				}
			},
		});
		installActiveRelay(
			new ActiveRelayOrchestrator({
				makeRelayPort: (url) => {
					const port = new WebSocketRelayPort({ url, onChallenge });
					port.connect();
					return port;
				},
			}),
		);
		const bootSession = getActiveVaultSession();
		if (bootSession) {
			const { getActiveRelay } = await import("./sync/active-relay");
			const relay = getActiveRelay();
			if (relay) {
				void relay.onSessionChanged({
					vaultId: bootSession.vaultId,
					vaultPath: bootSession.vaultPath,
				});
			}
		}
	}
	registerPairingHandlers({ getDashboard: () => dashboardWindow });
	// Collab-C6 — privileged Settings → Identity profile get/set (the dashboard
	// surface; apps use the capability-gated `roster` service instead).
	registerProfileHandlers();
	// Stage 10.13 — per-device selective-sync policy store (app-global). The
	// live-sync engine's `policyAdmits` predicate reads its cache; the
	// dashboard reads/writes it via the sync-status IPC below. Warm the cache
	// now so the first `trackOpen` sees a real policy, not the absent-default.
	const selectiveSyncStore = new SelectiveSyncStore({
		path: selectiveSyncPolicyPath(app.getPath("userData")),
	});
	void selectiveSyncStore.load();
	// Stage 10.7 — sync-status surface. Lazy-import the store so the
	// `ActiveRelayOrchestrator` singleton above is guaranteed installed
	// before we wire the observer. One store per vault-session lifetime;
	// the start/stop flips inside `onActiveVaultSessionChanged` below.
	{
		const { SyncStatusStore } = await import("./sync/sync-status-store");
		const { getActiveRelay } = await import("./sync/active-relay");
		const relay = getActiveRelay();
		if (relay) {
			const syncStatusStore = new SyncStatusStore({
				activeRelay: relay,
				getVaultSession: () => {
					const session = getActiveVaultSession();
					return session ? { vaultPath: session.vaultPath } : null;
				},
			});
			registerSyncStatusHandlers({
				getDashboard: () => dashboardWindow,
				syncStatusStore,
				selectiveSyncStore,
				// 10.13 — re-evaluate which tracked entities still sync.
				onPolicyChanged: () => {
					void getLiveSyncEngine()?.refreshPolicy();
				},
				// 10.14 — offer cold restore when this keystore-intact device has
				// an empty entities.db AND the active transport has a durable node.
				isRestoreAvailable: async () => {
					if (!getActiveVaultSession()) return false;
					// The orchestrator always exposes requestCatalog; probe the live
					// PORT to confirm a durable node is actually reachable (not loopback).
					if (!getActiveRelay()?.hasDurableNode()) return false;
					const repo = await getEntitiesRepoForActiveSession();
					if (!repo) return false;
					// `ensureRootFolder()` seeds the system root Folder on EVERY vault
					// open, so a freshly-wiped-and-relaunched device never has a literal
					// count of 0. "Empty enough to restore" means nothing beyond that one
					// bootstrapped system row.
					const total = repo.count();
					return total === 0 || (total === 1 && repo.get(ROOT_FOLDER_ENTITY_ID) !== null);
				},
				// 10.14 — run a restore pass, then rebuild the search index so the
				// recovered rows are findable (the remote-apply path doesn't index).
				runRestore: async () => {
					const engine = getRestoreEngine();
					if (!engine) throw new Error("sync: restore unavailable (no session / no durable node)");
					const summary = await engine.restore();
					await rebuildSearchIndex();
					return summary;
				},
			});
			onActiveVaultSessionChanged(() => {
				syncStatusStore.notifyVaultSessionChanged();
			});
		}
	}
	if (isDev) {
		const { registerDevHandlers } = await import("./ipc/dev-handlers");
		registerDevHandlers({
			mainDir: __dirname,
			broadcastVaultEntitiesStale: () =>
				broadcastVaultEntitiesStaleSignal(launchSetup.getLauncherSync()?.allWindows() ?? []),
			getIntents: () => launchSetup.getIntents(),
		});
		if (process.env.BRAINSTORM_SOAK_DEBUG === "1") {
			const { registerSoakHandlers } = await import("./ipc/soak-handlers");
			registerSoakHandlers();
			// Note: the wire-receive listener closes over the active session
			// + dekStore at `dev:soak:install-wire-receiver` time. On a vault
			// swap the closure goes stale; receiving a frame after that point
			// trips `dekStore.open` against a zeroed master key. The current
			// soak never swaps sessions mid-run (the harness owns the vault
			// lifecycle), so this is latent. A previous attempt re-registered
			// the handlers on every session change to harden against future
			// callers; it caused an 18 MB/min RSS regression on the 1-min
			// soak (some allocation hidden in the dispose/re-register cycle
			// that the lightweight soak path made visible). Left as a known
			// latent until a real session-swap test materializes.
		}
		if (process.env.BRAINSTORM_COLLAB_DEBUG === "1") {
			// Collab-C4-live — two-user share/co-edit dogfood surface. Same
			// dev-only env-gate discipline as the soak handlers; the bridge
			// rebinds to the active session on a vault swap (unlike the soak
			// wire-receiver, which is a single-vault-lifecycle closure).
			const { registerCollabDevHandlers } = await import("./ipc/collab-dev-handlers");
			registerCollabDevHandlers();
		}
	}

	// Welcome-2 (9.3.5.V 7d) — the production first-launch template gallery's
	// import channel. Registered unconditionally (unlike the dev handlers). The
	// applyDocUpdate closure resolves the ACTIVE session at call time (the
	// channel is registered once, but acts on whichever vault is open), planting
	// template note bodies through the ydoc worker exactly like the welcome seed.
	{
		const { registerWelcomeHandlers } = await import("./ipc/welcome-handlers");
		registerWelcomeHandlers({
			makeApplyDocUpdate: (vaultPath) => async (entityId, updateB64) => {
				const handler = workersRef.broker.getServiceHandler("ydoc");
				if (!handler) throw new Error("ydoc worker service unavailable");
				await handler({
					v: 1,
					msg: `tmpl_${entityId}`,
					app: "io.brainstorm.shell",
					service: "ydoc",
					method: "applyUpdate",
					args: [{ vaultPath, entityId, updateB64 }],
					caps: [],
				});
			},
			broadcastVaultEntitiesStale: () =>
				broadcastVaultEntitiesStaleSignal(launchSetup.getLauncherSync()?.allWindows() ?? []),
		});
	}

	// Storage worker needs the active vault path to know where to write
	// per-app kv data. Push it on every active-session change so a vault
	// switch points the worker at the new path and clears its cache.
	// Storage worker needs the active vault path so it knows where to write
	// per-app KV data. We push the path on every active-session change and
	// once at boot for the auto-activated default vault. Both paths are
	// fire-and-forget so a worker stall can never block dashboard window
	// creation — failures land in the console + are visible in DevTools.
	const workersRef = workers;
	const pushStorageVault = (vaultPath: string): void => {
		void workersRef.storageBridge
			.send({
				v: 1 as const,
				msg: `set-vault-${Date.now()}`,
				app: "_shell",
				service: "storage",
				method: "setVault",
				args: [{ path: vaultPath }],
				caps: [],
			})
			.catch((error) => {
				console.warn("[brainstorm] storage setVault failed:", error);
			});
	};
	onActiveVaultSessionChanged((session) => {
		if (session) pushStorageVault(session.vaultPath);
	});
	const activeAtBoot = getActiveVaultSession();
	if (activeAtBoot) pushStorageVault(activeAtBoot.vaultPath);
	// A respawned storage worker boots with no vault bound — re-push the active
	// vault so its calls don't fail "database connection is not open".
	workersRef.setStorageRespawnHook(() => {
		const session = getActiveVaultSession();
		if (session) pushStorageVault(session.vaultPath);
	});

	workers.broker.registerService(
		"intents",
		makeIntentsServiceHandler({ getBus: () => launchSetup.getIntents() }),
	);

	// Global lexical search (Stage 9.22 preview drop — early shipment of
	// Stage 11's lexical half). One SearchIndexer per active vault session;
	// the writer-side connection to `search.db` lives in the main process
	// (single-writer guarantee — see search-indexer.ts header for the
	// FTS-on-Windows rationale).
	//
	// Declared BEFORE the storage-handler wrap below so that wrap's closure
	// over `rebuildSearchIndex` is past the TDZ — otherwise a note write
	// arriving between the wrap registration and these declarations would
	// raise `ReferenceError: Cannot access ... before initialization`.
	let searchIndexer: SearchIndexer | null = null;
	let rebuildToken: symbol = Symbol("idle");

	// 11.2 — semantic (vector) index seam, maintained in lockstep with the
	// lexical index on the same `search.db` handle. Gated OFF for v1 beta:
	// the only embedder available today is `StubEmbedder`, whose vectors are
	// semantically meaningless, so populating a vector index in production
	// would burn disk + cycles for zero user value. 11.3 swaps in the real
	// `multilingual-e5-small` model AND flips this flag; the storage +
	// maintenance + bench path it activates is already built and tested
	// (vector-store / vector-indexer suites + the vector BenchEngine). The
	// query surface (`search.semantic` / `search.hybrid`) stays gated until
	// the hybrid-retrieval rung — 11.2 wires maintenance only, no new broker
	// verb, no new capability.
	const VECTOR_INDEXING_ENABLED = false;
	let vectorIndexer: VectorIndexer | null = null;

	// B5.10 — lazy property + dictionary usage index. One per active vault
	// session (swapped on session change); subsequent reads return the
	// cached snapshot until the entities mutation hooks invalidate it.
	let usageIndex: UsageIndex | null = null;

	// Single accessor for the active vault's `entities.db` repo — shared by
	// the search collector, the entities service, and the vault-entities
	// aggregator so all three read the same cached `open("entities")`
	// handle (DRY; was duplicated three times).
	const getEntitiesRepoForActiveSession = async (): Promise<EntitiesRepository | null> => {
		const session = getActiveVaultSession();
		if (!session) return null;
		try {
			return new EntitiesRepository(await session.dataStores.open("entities"));
		} catch (error) {
			// A fail-closed open (e.g. an at-rest key mismatch after dev-vault
			// churn) must not escape as an unhandled rejection through the many
			// callers of this accessor. Every caller already treats a null repo
			// as "unavailable" and degrades; surface the cause as a warning and
			// return null so the session stays responsive rather than crashing.
			console.warn(
				`[brainstorm] entities repo unavailable for active session: ${(error as Error).message}`,
			);
			return null;
		}
	};

	const getSettingsRepoForActiveSession = async (): Promise<SettingsRepository | null> => {
		const session = getActiveVaultSession();
		if (!session) return null;
		try {
			return new SettingsRepository(await session.dataStores.open("settings"));
		} catch (error) {
			console.warn(
				`[brainstorm] settings repo unavailable for active session: ${(error as Error).message}`,
			);
			return null;
		}
	};

	const rebuildSearchIndex = async (): Promise<void> => {
		const session = getActiveVaultSession();
		if (!session || !searchIndexer) return;
		const ourToken = Symbol("rebuild");
		rebuildToken = ourToken;
		try {
			// 9.22.5 — entities.db is the authoritative source (every
			// first-party app writes there since 9.3.5.x); the kv-notes
			// scan stays an additive fallback inside the collector.
			const entities = await collectIndexableEntities(
				session.vaultPath,
				getEntitiesRepoForActiveSession,
			);
			if (rebuildToken !== ourToken) return; // superseded by a newer rebuild
			if (!searchIndexer) return;
			searchIndexer.rebuild(entities);
			if (vectorIndexer) await vectorIndexer.rebuild(entities);
		} catch (error) {
			console.warn(`[brainstorm] search index rebuild failed: ${(error as Error).message}`);
		}
	};

	// The reindex is a full-vault scan + FTS rebuild (synchronous better-sqlite3
	// work on the main thread once entities are collected). `rebuildToken`
	// coalesces concurrent in-flight rebuilds, but a burst of *sequential*
	// writes (a keystroke-storm save fans several `entities` writes) would still
	// run one full rebuild each. Trailing-debounce the write-path trigger so a
	// burst collapses into a single reindex after it settles — search lags a
	// write by <300ms, imperceptible and already true of the cross-window stale
	// fan-out. Vault-open + the explicit `reindex` hook still call directly.
	let searchReindexTimer: ReturnType<typeof setTimeout> | null = null;
	const scheduleSearchReindex = (): void => {
		if (searchReindexTimer) clearTimeout(searchReindexTimer);
		searchReindexTimer = setTimeout(() => {
			searchReindexTimer = null;
			void rebuildSearchIndex();
		}, 250);
	};

	// B5.10 — drop the old session's cache (entity refs no longer apply)
	// and bind a fresh UsageIndex to the new session's entities + catalog.
	// Idempotent: the new instance starts dirty so the first read in the
	// new session triggers one recompute, no eager scan on swap. The
	// PropertiesStore is opened up front so the catalog reader can be
	// synchronous (one snapshot() call) — without this, the recompute
	// would need a two-step async dance every time.
	const swapUsageIndex = async (): Promise<void> => {
		const session = getActiveVaultSession();
		if (!session) {
			usageIndex = null;
			return;
		}
		const propertiesStore = await session.propertiesStore();
		usageIndex = new UsageIndex({
			readEntities: async () => {
				const snap = await listVaultEntities(session.vaultPath, getEntitiesRepoForActiveSession);
				return snap.entities;
			},
			readCatalog: () => {
				const base = propertiesStore.snapshot();
				return { properties: base.properties, dictionaries: base.dictionaries };
			},
		});
	};

	const swapSearchIndexer = async (): Promise<void> => {
		// A reindex queued under the outgoing session must not fire after the
		// swap — it would read the now-active session and run a redundant full
		// rebuild of the wrong vault. Cancel it before tearing down.
		if (searchReindexTimer) {
			clearTimeout(searchReindexTimer);
			searchReindexTimer = null;
		}
		const previous = searchIndexer;
		const previousVector = vectorIndexer;
		searchIndexer = null;
		vectorIndexer = null;
		previous?.dispose();
		previousVector?.dispose();
		const session = getActiveVaultSession();
		if (!session) return;
		try {
			const db = await session.dataStores.open("search");
			searchIndexer = new SearchIndexer(db);
			// 11.2 — construct the vector indexer on the SAME search.db handle
			// when enabled (11.3). `createVectorIndexer` returns null when
			// sqlite-vec can't load (e.g. a platform missing the prebuilt
			// binary) — lexical search keeps working regardless.
			if (VECTOR_INDEXING_ENABLED) {
				const vector = createVectorIndexer(db, new StubEmbedder());
				vectorIndexer = vector?.indexer ?? null;
			}
			await rebuildSearchIndex();
		} catch (error) {
			console.warn(`[brainstorm] search index open failed: ${(error as Error).message}`);
			searchIndexer = null;
			vectorIndexer = null;
		}
	};

	// 6.7 — migrate the legacy flat `<vault>/shell/shortcut-bindings.json`
	// into a `brainstorm/ShortcutBindings/v1` entity exactly once per vault
	// open (one-shot read-and-store, NO shape change), then load the
	// user's effective overrides into the shortcut registry. Idempotent +
	// no-clobber + non-destructive (see bindings-entity.ts);
	// boot-independent — same session-changed hook everything else uses.
	// The registry's public API is unchanged: the renderer/apps still see
	// the same resolved-binding map.
	let shortcutRegistry: ShortcutRegistry | null = null;
	const loadShortcutBindings = async (): Promise<void> => {
		const repo = await getEntitiesRepoForActiveSession();
		const session = getActiveVaultSession();
		const registry = shortcutRegistry;
		if (!repo || !session || !registry) return;
		try {
			const r = await migrateBindingsFileToEntity(session.vaultPath, repo);
			if (r.migrated) {
				console.log("[brainstorm] shortcut-bindings: migrated flat file → entity");
			}
			registry.applyOverrides(readOverridesFromEntity(repo));
		} catch (error) {
			console.warn(
				`[brainstorm] shortcut-bindings migration/load failed: ${(error as Error).message}`,
			);
		}
	};

	// 6.10b — mirror every installed app's manifest `shortcuts: [...]` into
	// the live `ShortcutRegistry` under `app/<app-id>/<id>`. Install /
	// uninstall keep the registry in sync inside this session; this pass
	// hydrates apps installed in a prior session (the registry is
	// session-scoped — there's no on-disk mirror to load from). Manifest
	// shape was validated at install time; if a re-read fails (corruption,
	// missing file) the app is skipped, not the boot.
	const loadInstalledAppShortcuts = async (): Promise<void> => {
		const session = getActiveVaultSession();
		const registry = shortcutRegistry;
		if (!session || !registry) return;
		try {
			const db = await session.dataStores.open("registry");
			const appsRepo = new AppsRepository(db);
			const records = appsRepo.listActive();
			for (const record of records) {
				try {
					const raw = await readFile(join(record.bundleDir, "manifest.json"), "utf8");
					const parsed = JSON.parse(raw) as unknown;
					const r = validateManifest(parsed);
					if (!r.ok) continue;
					registry.registerApp(r.manifest.id, r.manifest.shortcuts ?? []);
				} catch (error) {
					console.warn(
						`[brainstorm] shortcut-mirror: skipped ${record.id}: ${(error as Error).message}`,
					);
				}
			}
		} catch (error) {
			console.warn(`[brainstorm] shortcut-mirror: pass failed: ${(error as Error).message}`);
		}
	};

	// 9.8.2b-shell — guarantee the vault's canonical root Folder exists in
	// `entities.db` before any app reads `vaultEntities.list()`, so the
	// Files app resolves a real (initially empty) root instead of a
	// synthetic placeholder. Idempotent + fail-safe (see
	// VaultSession.ensureRootFolder); ordered first so the bridge / search
	// passes that follow already see the row.
	const ensureRootFolder = async (): Promise<boolean> => {
		const session = getActiveVaultSession();
		if (!session) return false;
		const r = await session.ensureRootFolder();
		if (r.created) {
			console.log("[brainstorm] root-folder bootstrap: created vault root Folder");
		}
		return r.created;
	};

	// Welcome-1b-wire — preseed first-launch starter content on the open that
	// first created the vault (the `ensureRootFolder().created` signal), so an
	// existing/dogfood vault is never touched. Stamp-gated + removable via Bin.
	// Plants the bundled note bodies through the ydoc worker (plaintext at
	// 10.1; the row's null DEK is retro-wrapped by `runRetroWrapNullDeks`
	// later on this same pass). Opt-out checkbox on the create-vault step is
	// the remaining real-shell surface.
	const seedWelcomeOnFreshVault = async (): Promise<void> => {
		const session = getActiveVaultSession();
		if (!session) return;
		try {
			const { runWelcomeSeed } = await import("./welcome/run-welcome-seed");
			const result = await runWelcomeSeed({
				session,
				applyDocUpdate: async (entityId, updateB64) => {
					const handler = workersRef.broker.getServiceHandler("ydoc");
					if (!handler) throw new Error("ydoc worker service unavailable");
					await handler({
						v: 1,
						msg: `welcome_${entityId}`,
						app: "io.brainstorm.shell",
						service: "ydoc",
						method: "applyUpdate",
						args: [{ vaultPath: session.vaultPath, entityId, updateB64 }],
						caps: [],
					});
				},
			});
			console.log(
				`[brainstorm] welcome seed: ${result.outcome} (created ${result.created}, planted ${result.planted}${result.errors.length ? `, ${result.errors.length} errors` : ""})`,
			);
			for (const error of result.errors) console.warn(`[brainstorm] welcome seed: ${error}`);
		} catch (error) {
			console.warn(`[brainstorm] welcome seed failed: ${(error as Error).message}`);
		}
	};

	// On the open that first created the vault, give it a polished out-of-box
	// appearance: the Rose theme in an explicit Light mode, with the bundled
	// pitch wallpaper. Both slots are seeded (the dark slot keeps Midnight +
	// the stormy-sea image) so toggling appearance lands on a well-formed pair.
	// Scoped to the fresh-vault open (the same `ensureRootFolder().created`
	// signal as the welcome seed) so an existing vault's chosen appearance is
	// never overwritten.
	const seedNewVaultDefaults = async (): Promise<void> => {
		const session = getActiveVaultSession();
		if (!session) return;
		try {
			const dashboard = await session.dashboardStore();
			const artDir = isDev ? join(__dirname, "../../art") : join(process.resourcesPath, "art");
			const wallpaperDir = join(session.vaultPath, "dashboard", "wallpapers");
			// Copy the assets BEFORE touching the store so the store writes below
			// run back-to-back (no await between them) — an observer never sees a
			// half-applied "Rose theme but no wallpaper" state.
			const copyWallpaper = async (file: string): Promise<boolean> => {
				try {
					await copyFile(join(artDir, "wallpaper", file), join(wallpaperDir, file));
					return true;
				} catch (error) {
					// A missing bundled asset must not strand the theme/mode defaults.
					console.warn(`[brainstorm] default wallpaper copy failed: ${(error as Error).message}`);
					return false;
				}
			};
			await mkdir(wallpaperDir, { recursive: true });
			const lightReady = await copyWallpaper(DEFAULT_LIGHT_WALLPAPER_FILE);
			const darkReady = await copyWallpaper(DEFAULT_DARK_WALLPAPER_FILE);
			// Store the resolvable vault-protocol URL, not a bare filename (which
			// resolves to the renderer root and 404s — F-007).
			const imageWallpaper = (file: string) => ({
				kind: "image" as const,
				value: `brainstorm://wallpaper/${file}`,
			});
			await dashboard.batch(() => {
				dashboard.setAppearanceMode(AppearanceMode.Light);
				dashboard.setAppearancePair(AppearanceSlot.Light, {
					theme: ThemeName.Rose,
					wallpaper: lightReady
						? imageWallpaper(DEFAULT_LIGHT_WALLPAPER_FILE)
						: { kind: "solid", value: "#fdf4f6" },
				});
				dashboard.setAppearancePair(AppearanceSlot.Dark, {
					theme: ThemeName.Midnight,
					wallpaper: darkReady
						? imageWallpaper(DEFAULT_DARK_WALLPAPER_FILE)
						: { kind: "solid", value: "#14161b" },
				});
			});
			await dashboard.flush();
		} catch (error) {
			console.warn(`[brainstorm] new-vault defaults failed: ${(error as Error).message}`);
		}
	};

	// Stage 10.3a — install the per-device member wrap on an entity Y.Doc.
	// Builds the HPKE wrap on the main side (the worker stays crypto-free)
	// and ferries the pre-built payload to the ydoc worker through the
	// existing broker route. Idempotent — the worker no-ops on a recipient
	// pubkey that already has a wrap.
	const installEntityWrap = async (
		entityId: string,
		dek: Uint8Array,
		type?: string,
	): Promise<void> => {
		const session = getActiveVaultSession();
		if (!session) return;
		// Stage 10.14 — seal the entity `type` inside the wrap so a cold device
		// can materialize the row on restore (the type isn't in the doc).
		const wrap = wrapDekForRecipient(dek, session.deviceX25519.publicKey, entityId, type);
		const handler = workersRef.broker.getServiceHandler("ydoc");
		if (!handler) throw new Error("ydoc worker service unavailable");
		await handler({
			v: 1,
			msg: `ydoc_iw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
			app: "io.brainstorm.shell",
			service: "ydoc",
			method: "installWrap",
			args: [{ vaultPath: session.vaultPath, entityId, wrap }],
			caps: [],
		});
		void bytesToBase64;
	};

	// 10.x — retro-wrap any live entity that still carries `dek_id IS NULL`.
	// Must run AFTER every shell-internal singleton creator above
	// (`ensureRootFolder`, `loadShortcutBindings`) because
	// each of those currently writes rows with no DEK. Idempotent: a steady-
	// state vault sees zero null-dek rows, the pass runs one read query +
	// returns. Per-row errors stay localised. **Precondition for Stage
	// 10.3 sync wire path** — null-dek rows there are ambiguous (silent
	// skip vs. plaintext leak).
	const runRetroWrapNullDeks = async (): Promise<void> => {
		const session = getActiveVaultSession();
		const repo = await getEntitiesRepoForActiveSession();
		if (!session || !repo) return;
		try {
			const dekStore = await session.entityDekStore();
			const r = await retroWrapNullDeks({ repo, dekStore, installEntityWrap });
			if (r.wrapped > 0 || r.skipped > 0) {
				console.log(
					`[brainstorm] retro-wrap null-DEK pass: wrapped ${r.wrapped} entities (${r.skipped} skipped due to errors)`,
				);
			}
		} catch (error) {
			console.warn(`[brainstorm] retro-wrap pass failed: ${(error as Error).message}`);
		}
	};

	// Asset-B1 — install a pre-sealed asset-DEK wrap on an entity Y.Doc. The
	// seal (under the entity DEK) happens on the main side; this only ferries the
	// opaque envelope to the ydoc worker (which stays crypto-free), mirroring
	// `installEntityWrap`. Idempotent on the worker side.
	const installAssetDekWrap = async (
		entityId: string,
		assetId: string,
		wrap: AssetDekWrap,
	): Promise<{ appended: boolean }> => {
		// Throw (don't return) when the session is gone mid-pass: the re-home
		// caller stamps `rehomed_at` on resolution, so a silent no-op here would
		// mark the pair re-homed without ever installing the wrap — stranding that
		// asset's DEK off the doc forever. A throw defers the pair to the next boot.
		const session = getActiveVaultSession();
		if (!session) throw new Error("no active vault session");
		const handler = workersRef.broker.getServiceHandler("ydoc");
		if (!handler) throw new Error("ydoc worker service unavailable");
		await handler({
			v: 1,
			msg: `ydoc_iad_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
			app: "io.brainstorm.shell",
			service: "ydoc",
			method: "installAssetDekWrap",
			args: [{ vaultPath: session.vaultPath, entityId, assetId, wrap }],
			caps: [],
		});
		// The worker round-trip resolves once the wrap is on the doc (a throw
		// would have propagated). The `appended` flag is informational; the
		// re-home pass stamps its marker on resolution regardless.
		return { appended: true };
	};

	// Asset-B1 — re-home each referenced asset's DEK from the master-key wrap
	// into the owning entity's Y.Doc (sealed under the entity DEK), so a paired
	// device that fetches the ciphertext blob can open it. Runs AFTER the
	// retro-wrap pass (which mints the entity DEKs this pass seals under).
	// Idempotent: `asset_refs.rehomed_at` is the marker, so steady-state boot is
	// one empty query.
	const runRehomeAssetDeks = async (): Promise<void> => {
		const session = getActiveVaultSession();
		if (!session) return;
		try {
			const db = await session.dataStores.open("entities");
			const r = await rehomeAssetDeks({
				assetRefs: new AssetRefsRepository(db),
				assetDekStore: await session.assetDekStore(),
				entityDekStore: await session.entityDekStore(),
				installAssetDekWrap,
			});
			if (r.rehomed > 0 || r.skipped > 0 || r.localOnly > 0) {
				console.log(
					`[brainstorm] asset-DEK re-home pass: re-homed ${r.rehomed} (${r.deferred} deferred, ${r.localOnly} local-only, ${r.skipped} skipped)`,
				);
			}
		} catch (error) {
			console.warn(`[brainstorm] asset-DEK re-home pass failed: ${(error as Error).message}`);
		}
	};

	let activeNetworkSettingsSubscription: { dispose: () => void } | null = null;

	// Mailbox-2 — per-vault mail sync registration. Restarted on every vault
	// open/switch (the old vault's schedule stops; in-flight passes check the
	// stopped flag). No-op until the mail service exists; `registerService`
	// time calls it again to cover the already-open boot vault.
	let mailSessionSync: MailSessionSyncHandle | null = null;
	const restartMailSessionSync = (): void => {
		mailSessionSync?.stop();
		mailSessionSync = null;
		const api = mailServiceApi;
		if (!api || !getActiveVaultSession()) return;
		mailSessionSync = startMailSessionSync({
			listEnabledAccountIds: async () => {
				const repo = await getEntitiesRepoForActiveSession();
				return repo ? listEnabledMailAccountIds(repo) : [];
			},
			syncAccount: (accountRef) => api.syncAccount(accountRef),
			log: (message) => console.warn(`[mail] ${message}`),
		});
	};

	const onVaultOpened = async (): Promise<void> => {
		restartMailSessionSync();
		// Net-1c privacy hardening — wipe the link-preview cache so
		// vault A's preview snapshots never become visible in vault B's
		// session. Cheap (the cache is process-singleton in-memory) and
		// idempotent; fires on every vault open / switch.
		previewCache.clear();
		// Net-1e — pre-flight the per-vault network settings so the
		// network handler's sync `cachedVaultNetworkSettings` reader
		// returns a value on the first IPC after the switch, AND
		// subscribe to per-vault setting changes so a `set` from the
		// dashboard fans out + invalidates the preview cache.
		activeNetworkSettingsSubscription?.dispose();
		activeNetworkSettingsSubscription = null;
		const session = getActiveVaultSession();
		if (session) {
			try {
				await session.vaultNetworkSettings();
			} catch (error) {
				console.warn(`[brainstorm] vault network settings preload failed: ${(error as Error).message}`);
			}
			activeNetworkSettingsSubscription = ensureNetworkSettingsBroadcast(session);
		}
		const freshVault = await ensureRootFolder();
		if (freshVault) {
			await seedWelcomeOnFreshVault();
			await seedNewVaultDefaults();
			// The welcome seed creates entities through the privileged in-process
			// repo, which bypasses the entities-service write broadcast — so any
			// app window already open onto this fresh vault would keep showing its
			// empty state. Push the stale signal so they re-`list()` and surface
			// the starter content without a reopen.
			broadcastVaultEntitiesStaleSignal(launchSetup.getLauncherSync()?.allWindows() ?? []);
		}
		// 11.9 — apply this vault's AI routing default to the provider registry.
		if (session && applyAiDefaultProvider) {
			try {
				applyAiDefaultProvider((await readAiSettings(session.vaultPath)).defaultProvider);
			} catch (error) {
				console.warn(`[brainstorm] AI settings load failed: ${(error as Error).message}`);
			}
		}
		await loadShortcutBindings();
		await loadInstalledAppShortcuts();
		await runRetroWrapNullDeks();
		await runRehomeAssetDeks();
		await swapSearchIndexer();
		await swapUsageIndex();
		// Re-point the dashboard at THIS vault's store and push its snapshot:
		// the dashboard window persists across a vault switch (not remounted),
		// so without this the renderer keeps the previous vault's theme /
		// wallpaper / pinned icons. Runs on every open, after seeding, so a
		// freshly-seeded vault paints its Midnight/wallpaper/app-icon state.
		await rebindDashboardToActiveVault();
		// 6.10f — the registry was rebuilt for this vault (overrides from the
		// new vault's `brainstorm/ShortcutBindings/v1` entity + that vault's
		// app-layer manifests). Push a single repaint so Settings → Keyboard
		// + the cheatsheet pick up the new effective bindings without
		// requiring a manual refetch.
		if (dashboardWindow && !dashboardWindow.webContents.isDestroyed()) {
			dashboardWindow.webContents.send("shortcuts:bindings-changed");
		}
	};
	onActiveVaultSessionChanged(() => {
		void onVaultOpened();
	});
	if (getActiveVaultSession()) void onVaultOpened();

	// Wrap the storage handler the worker bridge registered at `startWorkers`
	// time so that successful vault-entity writes fan out a stale signal to
	// every app window. The Graph / Database / Files apps subscribe via
	// `services.vaultEntities.onChange` (preload-backed IPC) and re-`list()`
	// to repaint without polling. Mirrors the VP-6 properties broadcast
	// pattern. Replaced when the real entities service (Stage 9.3) takes
	// over.
	const innerStorageHandler = workers.broker.getServiceHandler("storage");
	if (innerStorageHandler) {
		workers.broker.registerService("storage", async (envelope) => {
			const result = await innerStorageHandler(envelope);
			if (isVaultEntityWriteEnvelope(envelope)) {
				broadcastVaultEntitiesStaleSignal(launchSetup.getLauncherSync()?.allWindows() ?? []);
				// Reindex on every vault-entity write — the rebuild is bounded
				// by the `rebuildToken` so rapid-fire writes coalesce into one
				// effective rebuild rather than queueing N partial passes.
				// Cheap at our scale (one readFile + one transaction); the
				// real entities service at Stage 9.3 will switch to a
				// per-entity update.
				scheduleSearchReindex();
				// B5.10 — invalidate the lazy usage index + repush the
				// composed properties broadcast snapshot so Settings → Data
				// pills update without polling.
				void republishPropertiesSnapshot();
			}
			return result;
		});
	}

	// 11b.6 — post-commit entity changes fan out to the automations engine's
	// `EntityEvent` triggers (and its live schedule re-derivation). Process-
	// singleton like the broker; the per-vault deployment below subscribes /
	// unsubscribes per session.
	const automationsChangeEmitter = new EntityChangeEmitter();

	// Stage 9.3.1 — the real entities service over `entities.db`. Runs
	// alongside the `vault-entities` preview below: apps migrate off the
	// per-app-KV aggregator onto this per-iteration (avoid-blocking — the
	// swap is per app, not a flag day). Successful mutations fan out the
	// same `app:vault-entities-changed` staleness signal + trigger a
	// search reindex, exactly like the storage-write wrap above, so
	// subscribers repaint without polling.
	// 10.12 — the entities service hands its system-only remote-apply closure
	// here at construction; the live-sync engine's `applyRemoteUpdate` routes
	// inbound decrypted frames through it (off the broker — never app-callable).
	let applyRemoteDocFn: ApplyRemoteDocFn | null = null;
	const entitiesHandler = makeEntitiesServiceHandler({
		onEntityChange: (change) => automationsChangeEmitter.emit(change),
		bindApplyRemoteDoc: (fn) => {
			applyRemoteDocFn = fn;
		},
		// 10.12 — an app opened a doc: let the live-sync engine subscribe its
		// relay channel if the entity is shared (>1 active member).
		onDocOpened: (entityId, type) => {
			void getLiveSyncEngine()?.trackOpen(entityId, type);
		},
		// 10.12 — a local doc write committed: emit it if the entity is shared
		// + tracked (a no-op otherwise, so solo edits never touch the relay).
		onLocalDocUpdate: (entityId, _type, update) => {
			void getLiveSyncEngine()?.noteLocalUpdate(entityId, update);
		},
		// 10.14 — the doc's tail compacted: emit a full-state Snapshot so the
		// durable node compacts its tail too (no-op unless shared + tracked).
		onDocCompacted: (entityId) => {
			void getLiveSyncEngine()?.noteCompaction(entityId);
		},
		getRepo: getEntitiesRepoForActiveSession,
		getLedger: async () => {
			const session = getActiveVaultSession();
			if (!session) return null;
			return await session.capabilityLedger();
		},
		// Stage 10.1 — every `entities.create` mints + seals a per-entity DEK
		// through this store before the row lands in `entities.db`.
		getDekStore: async () => {
			const session = getActiveVaultSession();
			if (!session) return null;
			return await session.entityDekStore();
		},
		// Stage 10.3a — append the per-device member wrap to the freshly-
		// created entity's Y.Doc while the DEK is still live (zeroed in
		// the service's `finally`). Idempotent on the worker side.
		installEntityWrap,
		newId: () => `ent_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
		getVaultPath: () => getActiveVaultSession()?.vaultPath ?? null,
		// 9.3.2b: proxy the `ydoc` worker in-process (the entities service
		// is already the per-type capability authority — loadDoc/applyDoc
		// reuse it; no app-callable `ydoc` service / privileged channel).
		ydoc: async (method, a) => {
			const handler = workersRef.broker.getServiceHandler("ydoc");
			if (!handler) throw new Error("ydoc worker service unavailable");
			return handler({
				v: 1,
				msg: `ydoc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
				app: "io.brainstorm.shell",
				service: "ydoc",
				method,
				args: [a],
				caps: [],
			});
		},
		// 9.3.2c — fan a canonical-applied delta to the other app windows
		// holding the entity open. `targetApps` is already the
		// read-gated, replica-holding subset (see ydoc-remote-broadcast).
		deliverDocUpdate: (entityId, updateB64, targetApps) =>
			// 9.3.2d — returns the no-live-window subset so the entities
			// service can prune renderers that died without `closeDoc`.
			deliverYDocUpdateToApps(
				launchSetup.getLauncherSync()?.allWindows() ?? [],
				entityId,
				updateB64,
				targetApps,
			),
		// 12.8 (doc 28 "Corrupted Yjs file") — a cold load recovered a doc with
		// a truncated tail; warn the user via the shared notify host (the same
		// notification-center surface apps post to) that the item's most recent
		// edits may not have been saved before a crash.
		onTruncatedTail: () => {
			getUiNotifyHost().post({
				appId: "io.brainstorm.shell",
				kind: "warning",
				title: "Recovered unsaved changes",
				body:
					"A document was recovered after an interrupted save. Its most recent edits may be missing.",
			});
		},
	});
	// 10.12 — (re)build the always-on live-sync engine on every vault session
	// activation; tear it down on deactivation. The engine's context is per
	// session (DEK store + sovereign key), so it can't be a process-singleton
	// like the relay orchestrator. The entities-service hooks above read the
	// current engine via `getLiveSyncEngine()`, so they always address this
	// session's engine.
	const wireSyncEnginesForSession = (session: VaultSession | null): void => {
		if (!session) {
			disposeLiveSyncEngine();
			setRestoreEngine(null);
			return;
		}
		void (async () => {
			try {
				const dekStore = await session.entityDekStore();
				const engine = installLiveSyncEngine({
					getRelay: () => getActiveRelay(),
					dekStore,
					devicePub: session.identity.publicKey,
					deviceSign: (bytes) => session.signPayload(bytes),
					deviceVerify: (sig, bytes, senderPub) => verifySignature(senderPub, bytes, sig),
					// Inbound frames only reach `resolveEntity` for tracked entities
					// (whose type the engine already holds), so this fallback is
					// effectively unused — return null rather than touch the repo.
					resolveEntityType: () => null,
					// Shared ⇔ the signed access record lists >1 ACTIVE member.
					// Read off the persisted doc (the worker persists synchronously
					// before `loadDoc` returns, so the record is current here).
					isShared: async (entityId) => {
						const { doc } = await session.ydocStore.load(entityId);
						try {
							return resolveMembers(doc, entityId).filter((m) => m.active).length > 1;
						} catch {
							return false;
						} finally {
							doc.destroy();
						}
					},
					applyRemoteUpdate: async (entityId, _type, update) => {
						await applyRemoteDocFn?.(entityId, Buffer.from(update).toString("base64"));
					},
					// 10.14 — recover a per-entity DEK (+ type) from an inbound
					// WrapBootstrap. HPKE-unwraps with the device X25519 secret (never
					// leaves the session), then — on a cold/restoring device OR a
					// freshly-received share — materializes the entities.db row from
					// the recovered type so the snapshot that follows has a parent to
					// update, and installs the DEK (sealed under the master key). The
					// row's createdBy/ownerApp is a best-effort derivation from the
					// type prefix (the real creator app isn't on the wire); a full
					// search rebuild after restore re-derives the rest.
					installWrap: async (wrap, entityId) => {
						const { dek, type } = session.unwrapMemberWrapWithType(wrap, entityId);
						try {
							const repo = await getEntitiesRepoForActiveSession();
							if (!repo) return type;
							if (!repo.get(entityId)) {
								if (!type) {
									console.warn(
										`[live-sync] cannot materialize ${entityId}: wrap carried no type (pre-10.14)`,
									);
									return null;
								}
								const slash = type.indexOf("/");
								const ownerApp = slash > 0 ? type.slice(0, slash) : "brainstorm";
								repo.create({
									id: entityId,
									type,
									properties: {},
									createdBy: ownerApp,
									now: Date.now(),
									dekId: null,
								});
							}
							installEntityDek(entityId, dek, dekStore, repo);
							return type;
						} finally {
							dek.fill(0);
						}
					},
					// 10.14 — full Yjs state of an entity (from the ydoc worker's
					// cached doc) so the engine can emit a Snapshot frame on
					// compaction. The worker holds the doc post-applyDoc, so this is
					// a cache read, not a disk reload.
					getEntitySnapshot: async (entityId) => {
						const handler = workersRef.broker.getServiceHandler("ydoc");
						if (!handler) return null;
						const reply = (await handler({
							v: 1,
							msg: `ydoc_snap_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
							app: "io.brainstorm.shell",
							service: "ydoc",
							method: "snapshot",
							args: [{ vaultPath: session.vaultPath, entityId }],
							caps: [],
						})) as { snapshotB64?: unknown } | null;
						const b64 = reply?.snapshotB64;
						return typeof b64 === "string" ? new Uint8Array(Buffer.from(b64, "base64")) : null;
					},
					// 10.13 — gate which shared entities sync by the device's
					// selective-sync policy. Everything ⇒ fast-path admit (no
					// entity lookup). Otherwise admit if dashboard-pinned or
					// active within the policy window (row `updatedAt`).
					policyAdmits: async (entityId) => {
						const policy = selectiveSyncStore.cached ?? DEFAULT_SELECTIVE_SYNC_POLICY;
						if (policy.mode === SelectiveSyncMode.Everything) return true;
						const pinned = isEntityPinnedOnDashboard(session, entityId);
						const repo = await getEntitiesRepoForActiveSession();
						const lastActiveMs = repo?.get(entityId)?.updatedAt ?? null;
						return entityMatchesPolicy(policy, { pinned, lastActiveMs }, Date.now());
					},
				});
				// 10.14 — bind a cold-restore orchestrator to this session. The
				// account key is the device's wire `sender` (base64url); the
				// catalog query rides the live WebSocket transport.
				setRestoreEngine(
					new RestoreEngine({
						account: Buffer.from(session.identity.publicKey).toString("base64url"),
						requestCatalog: (account) => {
							const relay = getActiveRelay();
							if (!relay?.requestCatalog) {
								return Promise.reject(new Error("sync: no durable node on the active transport"));
							}
							return relay.requestCatalog(account);
						},
						engine,
					}),
				);
			} catch (error) {
				console.error("[live-sync] failed to install engine for session:", error);
			}
		})();
	};
	onActiveVaultSessionChanged(wireSyncEnginesForSession);
	// A vault auto-restored at boot (`autoActivateDefaultVault`) is set BEFORE
	// this listener registers, and `onActiveVaultSessionChanged` does not replay
	// the current session to a late subscriber — so without this the live-sync
	// + restore engines would never wire after a normal app restart (only after
	// an in-session vault switch). Wire the already-active boot session now.
	{
		const bootSession = getActiveVaultSession();
		if (bootSession) wireSyncEnginesForSession(bootSession);
	}

	// 10.13 — an entity is "pinned" for selective-sync if it has a dashboard
	// icon targeting it (the user surfaced it on their dashboard ⇒ keep it
	// synced regardless of recency). Reads the open dashboard store's snapshot;
	// no store open ⇒ not pinned.
	function isEntityPinnedOnDashboard(
		session: {
			dashboardStoreIfOpen: () => {
				snapshot: () => { icons: Record<string, { kind: string; target: string }> };
			} | null;
		},
		entityId: string,
	): boolean {
		const store = session.dashboardStoreIfOpen();
		if (!store) return false;
		for (const icon of Object.values(store.snapshot().icons)) {
			if (icon.kind === "entity" && icon.target === entityId) return true;
		}
		return false;
	}

	const notifyMentionsFromCreate = (result: unknown): void => {
		const entity = result as { type?: unknown; properties?: unknown } | null;
		if (!entity || typeof entity.type !== "string" || !entity.properties) return;
		const session = getActiveVaultSession();
		if (!session) return;
		const targets = mentionTargets(entity.type, entity.properties as Record<string, unknown>);
		if (!targets || !shouldNotify(targets, session.identity.publicKeyBase64)) return;
		const who = targets.authorName.trim();
		getUiNotifyHost().post({
			appId: "io.brainstorm.shell",
			kind: "info",
			title: "You were mentioned",
			body: who ? `${who} mentioned you` : "Someone mentioned you",
		});
	};
	workers.broker.registerService("entities", async (envelope) => {
		const result = await entitiesHandler(envelope);
		if (
			envelope.method === "create" ||
			envelope.method === "update" ||
			envelope.method === "delete"
		) {
			broadcastVaultEntitiesStaleSignal(launchSetup.getLauncherSync()?.allWindows() ?? []);
			scheduleSearchReindex();
			// B5.10 — same trigger as the storage wrap above: an entity
			// write may have flipped a property value (a Select choice, a
			// new entity that uses a property at all), so the usage index
			// is dirty.
			void republishPropertiesSnapshot();
			// 7.13 — a pinned tile is live-resolved; re-push so a rename /
			// re-icon / delete / restore reflects on the dashboard without
			// the user touching the pin.
			republishDashboardSnapshot();
			// Collab-C6 — a just-created Message/Comment may @-mention the local
			// user; notify them (self-authored mentions self-suppress). Fires for
			// agent/other-authored mentions now; collaborator mentions light up
			// once channels/comments sync cross-vault (Collab-C5).
			if (envelope.method === "create") notifyMentionsFromCreate(result);
		}
		return result;
	});

	// IE-2 — the app-facing `import` service over the shared import engine.
	// Type-scoped like `entities` (the handler is the cap authority; reuses the
	// app's `entities.write:<targetType>` grant). A `run` creates entities, so it
	// fires the same stale-signal + reindex + snapshot republish wrap as a write.
	const importHandler = makeImportServiceHandler({
		getSession: () => getActiveVaultSession(),
		getLedger: async () => {
			const session = getActiveVaultSession();
			if (!session) return null;
			return await session.capabilityLedger();
		},
		now: () => Date.now(),
	});
	workers.broker.registerService("import", async (envelope) => {
		const result = await importHandler(envelope);
		if (envelope.method === "run") {
			broadcastVaultEntitiesStaleSignal(launchSetup.getLauncherSync()?.allWindows() ?? []);
			scheduleSearchReindex();
			void republishPropertiesSnapshot();
			republishDashboardSnapshot();
		}
		return result;
	});

	// Per-device app settings (Phase 4 of the kv→entities collapse) — the
	// SQLite-backed `settings` service for device-local UI state that must
	// NOT sync (Graph/Database view config, dictionary sort). App-scoped by
	// the broker-verified `envelope.app`; no capability gate (an app's own
	// private settings are not a cross-app surface — same posture the
	// retired `storage.kv` had). Backed by the per-device `settings.db`.
	workers.broker.registerService(
		"settings",
		makeSettingsServiceHandler({ getRepo: getSettingsRepoForActiveSession }),
	);

	// 6.10f — Settings → Keyboard rebinding round-trip. Privileged
	// ipcMain surface (apps already have the broker `shortcuts.register`
	// for their own dynamic ids; user-rebinding is a dashboard-only
	// action). Persists overrides into `brainstorm/ShortcutBindings/v1`
	// through `writeOverridesToEntity` and pushes
	// `shortcuts:bindings-changed` so Settings + the cheatsheet repaint
	// in lock-step with the live registry.
	registerShortcutsHandlers({
		getRegistry: () => shortcutRegistry,
		getRepo: getEntitiesRepoForActiveSession,
		getDashboard: () => dashboardWindow?.webContents ?? null,
	});

	// Stage 13.8c — app-lock IPC. Privileged ipcMain (never broker — a sandboxed
	// app must not lock/unlock the vault); the default broadcast fans
	// `app:lock-changed` to every window so all overlays show/tear-down together.
	// `onLockChange` hides every app window while locked (and reveals them on
	// unlock): app windows are sandboxed renderers that can't draw the lock
	// screen themselves, so the main process masks them — only the dashboard
	// (showing the lock route) stays visible. (13.8 surface.)
	const lockHandlers = registerVaultLockHandlers({
		onLockChange: (locked) => {
			const launcher = launchSetup.getLauncherSync();
			// Warm-kept (parked) renderers hold the now-locked session's data in
			// memory — tear them down on lock rather than just hiding them (they'd
			// otherwise be revealed by the unlock show-loop below). Visible windows
			// are masked/revealed as before.
			if (locked) launcher?.evictAllParked();
			for (const view of launcher?.allContainers() ?? []) {
				const base = view.container.baseWindow;
				if (base.isDestroyed()) continue;
				if (locked) base.hide();
				else revealWindow(base);
			}
			if (locked && dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.focus();
		},
	});

	// A parked renderer is bound to one vault session; when the active session
	// changes (vault close / switch, or a hard-lock disposing it) its warm-kept
	// data is stale and must not be reused — evict every parked window.
	onActiveVaultSessionChanged(() => {
		launchSetup.getLauncherSync()?.evictAllParked();
	});

	// Stop warm-keeping on quit so the close interceptor doesn't preventDefault
	// every app window's close and block a clean shutdown.
	app.on("before-quit", () => {
		launchSetup.getLauncherSync()?.prepareForQuit();
	});

	// Stage 13.8 — auto-lock: lock the vault after the per-vault idle timeout, or
	// immediately on system sleep / OS screen-lock. Reuses the handler's `lock()`
	// so it takes the same broadcast + app-window-mask path as `vault:lock`.
	const appLockWatcher = createAppLockWatcher({
		getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
		getAppIdleSeconds: () => appActivityIdleSeconds(),
		getAutoLockMinutes: () => getActiveVaultAutoLockMinutes(),
		hasPin: () => activeVaultHasPin(),
		isLocked: () => isVaultLocked(),
		lock: () => {
			lockHandlers.lock();
		},
		subscribeSystemLock: (handler) => {
			powerMonitor.on("suspend", handler);
			powerMonitor.on("lock-screen", handler);
			return () => {
				powerMonitor.off("suspend", handler);
				powerMonitor.off("lock-screen", handler);
			};
		},
	});
	appLockWatcher.start();

	// Stage 9.19 — the shell-only Bin / Trash. Privileged ipcMain surface
	// (not broker — restore/purge write across app data spaces, OQ-BIN-1);
	// after a mutation it fans out the *same* refresh the entities service
	// does on create/update/delete so a restored object reappears in its
	// app and on any pinned tile with no user action.
	registerBinHandlers({
		getRepo: getEntitiesRepoForActiveSession,
		deleteAsset: async (assetId) => {
			const session = getActiveVaultSession();
			if (!session) return;
			const store = await session.assetStore();
			await store.deleteAsset(assetId);
		},
		getSettingsRepo: getSettingsRepoForActiveSession,
		afterMutation: () => {
			broadcastVaultEntitiesStaleSignal(launchSetup.getLauncherSync()?.allWindows() ?? []);
			scheduleSearchReindex();
			void republishPropertiesSnapshot();
			republishDashboardSnapshot();
		},
	});

	// Stage 9.3 preview surface — until every app migrates onto the
	// entities service above, this scans persistent app KV files so the
	// Graph / Database / Files apps keep rendering real data. The
	// wire-format identifier must be a lowercase identifier per the
	// envelope validator (`SERVICE_PATTERN` in `ipc/envelope.ts`); the SDK
	// still exposes the proxy as `services.vaultEntities` because that's a
	// JS property name, separate from the on-the-wire service id.
	const vaultEntitiesHandler = makeVaultEntitiesServiceHandler({
		getVaultPath: () => getActiveVaultSession()?.vaultPath ?? null,
		// 9.3.5.2 — also surface the real `entities.db` store so any app
		// migrated onto the entities service stays visible here with no
		// consumer change. Same shared accessor the entities service +
		// search collector use.
		getEntitiesRepo: getEntitiesRepoForActiveSession,
		// The vault property catalog drives the catalog-driven reference
		// edges (any `entityRef` property → a graph link). Best-effort: a
		// failure degrades to "no ref edges", never an empty snapshot.
		getPropertyDefs: async () => {
			const session = getActiveVaultSession();
			if (!session) return null;
			const store = await session.propertiesStore();
			return Object.values(store.snapshot().properties);
		},
	});
	workers.broker.registerService("vault-entities", vaultEntitiesHandler);

	workers.broker.registerService(
		"properties",
		makePropertiesServiceHandler({
			getStore: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.propertiesStore();
			},
		}),
	);

	// doc 63 — the Agent context layer. Read-only `platform.catalog()` over the
	// installed-app registry (apps + their object types + action vocabulary).
	// `platform.read` is scarce; the handler re-checks it against the ledger.
	workers.broker.registerService(
		"platform",
		makePlatformServiceHandler({
			getRegistry: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.dataStores.open("registry");
			},
			getLedger: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.capabilityLedger();
			},
		}),
	);

	// Collab-C6 — the `roster` service: vault membership (the entity's signed
	// access record) joined to self-asserted display profiles, so apps render
	// names + faces for the pubkeys they collaborate with. `roster.read` /
	// `roster.write` are scarce; the handler re-checks them against the ledger.
	workers.broker.registerService(
		"roster",
		makeRosterServiceHandler({
			getSession: () => getActiveVaultSession(),
			getLedger: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.capabilityLedger();
			},
			now: () => Date.now(),
		}),
	);

	// Collab-C5 — the app-facing share/revoke surface over the proven Stage-10
	// crypto spine. `sharing.share` is scarce + re-checked; ongoing sync of a
	// now-shared entity rides the always-on LiveSyncEngine via refreshMembership.
	workers.broker.registerService(
		"sharing",
		makeSharingServiceHandler({
			getSession: () => getActiveVaultSession(),
			getRelay: () => getActiveRelay(),
			getLedger: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.capabilityLedger();
			},
			refreshMembership: (entityId, type) => {
				void getLiveSyncEngine()?.refreshMembership(entityId, type);
			},
			now: () => Date.now(),
		}),
	);

	workers.broker.registerService(
		"search",
		makeSearchServiceHandler({
			getIndexer: () => searchIndexer,
			getVectorIndexer: () => vectorIndexer,
		}),
	);

	// B11.17a — custom spellcheck dictionary writes. Capability-gated
	// (`editor.spellcheck.write` / `.read`); persists to the per-vault store and
	// mirrors into the live shared renderer session dictionary.
	workers.broker.registerService(
		"spellcheck",
		makeSpellcheckServiceHandler({
			getVaultPath: () => getActiveVaultSession()?.vaultPath ?? null,
			sink: {
				add: (word) => electronSession.defaultSession.addWordToSpellCheckerDictionary(word),
				remove: (word) => electronSession.defaultSession.removeWordFromSpellCheckerDictionary(word),
			},
		}),
	);

	// AI broker (Stage 11.5 slice) — the `ai` service routes
	// `services.ai.generate` to a registered `ModelProvider`. v1-beta ships
	// one provider: local Ollama (BYO, OQ-60), reached over the network
	// broker's `executeNetworkFetch` with `allowPrivate` so the shell can
	// POST to `localhost:11434` (apps never hold raw network reach for AI —
	// the gate is `ai.use`, enforced by the broker before this runs).
	// Endpoint + default model are dev/BYO config; the app-facing contract
	// is provider-agnostic.
	const ollamaHttp: OllamaHttp = async ({ url, bodyJson }) => {
		const res = await executeNetworkFetch(
			{
				appId: "_shell.ai",
				url,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: new TextEncoder().encode(JSON.stringify(bodyJson)),
				allowPrivate: true,
				timeoutMs: 120_000,
				sizeCapBytes: 8 * 1024 * 1024,
			},
			{
				fetchImpl: productionFetchImpl,
				lookupHost: productionLookupHost,
				auditSink: makeFileAuditSink(networkAuditPath),
			},
		);
		return { status: res.status, text: new TextDecoder().decode(res.body) };
	};
	const aiProviders = new ProviderRegistry();
	aiProviders.register(
		createOllamaProvider({
			endpoint: process.env.BRAINSTORM_OLLAMA_ENDPOINT ?? "http://localhost:11434",
			defaultModel: process.env.BRAINSTORM_OLLAMA_MODEL ?? "llama3.2",
			http: ollamaHttp,
		}),
		{ default: true },
	);
	// 11.6 — BYO cloud provider (Anthropic Claude). Reached over the same
	// network broker as Ollama but WITHOUT `allowPrivate` (the Claude API is a
	// public host); the `x-api-key` header is forwarded by `executeNetworkFetch`
	// but never logged (the audit records host/path/method/status only). The key
	// is owned by the shell: read per-request from the active vault's Tier-2
	// credential store (sealed at rest), with a dev-only `BRAINSTORM_ANTHROPIC_API_KEY`
	// fallback — it never crosses IPC to an app. Absent key → the provider fails
	// closed (`Unavailable`); registered always so a pinned `provider:"anthropic"`
	// resolves, but Ollama stays the default. The Settings AI panel (11.9) writes
	// the credential via `writeAiProviderKey`.
	// Shared transport for every cloud provider — POST JSON over the network
	// broker (public host, no `allowPrivate`; the auth header is forwarded but
	// never logged). The provider-specific Http types are structurally identical.
	const cloudHttp: AnthropicHttp = async ({ url, headers, bodyJson }) => {
		const res = await executeNetworkFetch(
			{
				appId: "_shell.ai",
				url,
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: new TextEncoder().encode(JSON.stringify(bodyJson)),
				timeoutMs: 120_000,
				sizeCapBytes: 8 * 1024 * 1024,
			},
			{
				fetchImpl: productionFetchImpl,
				lookupHost: productionLookupHost,
				auditSink: makeFileAuditSink(networkAuditPath),
			},
		);
		return { status: res.status, text: new TextDecoder().decode(res.body) };
	};
	// Resolve a provider's BYO key: the active vault's Tier-2 credential first,
	// then a dev-only env fallback. Read in main only; never crosses IPC.
	const cloudKey = (providerId: string, envVar: string) => async (): Promise<string | null> => {
		const session = getActiveVaultSession();
		if (session) {
			const stored = await readAiProviderKey(session.credentials, providerId);
			if (stored) return stored;
		}
		return process.env[envVar] ?? null;
	};
	aiProviders.register(
		createAnthropicProvider({
			defaultModel: process.env.BRAINSTORM_ANTHROPIC_MODEL ?? "claude-opus-4-8",
			getApiKey: cloudKey(ANTHROPIC_PROVIDER_ID, "BRAINSTORM_ANTHROPIC_API_KEY"),
			http: cloudHttp,
		}),
	);
	// OpenAI-compatible (configurable base URL → OpenAI / OpenRouter / Together /
	// Groq / local LM Studio). Pinned only by the key being present.
	aiProviders.register(
		createOpenAiProvider({
			...(process.env.BRAINSTORM_OPENAI_BASE_URL
				? { baseUrl: process.env.BRAINSTORM_OPENAI_BASE_URL }
				: {}),
			defaultModel: process.env.BRAINSTORM_OPENAI_MODEL ?? "gpt-4o-mini",
			getApiKey: cloudKey(OPENAI_PROVIDER_ID, "BRAINSTORM_OPENAI_API_KEY"),
			http: cloudHttp,
		}),
	);
	// z.ai GLM — OpenAI-compatible Chat Completions under z.ai's base URL, so it
	// rides the OpenAI provider with its own id, key custody, and default model.
	aiProviders.register(
		createOpenAiProvider({
			id: GLM_PROVIDER_ID,
			label: "GLM",
			baseUrl: process.env.BRAINSTORM_GLM_BASE_URL ?? "https://api.z.ai/api/paas/v4",
			defaultModel: process.env.BRAINSTORM_GLM_MODEL ?? "glm-5.2",
			getApiKey: cloudKey(GLM_PROVIDER_ID, "BRAINSTORM_GLM_API_KEY"),
			http: cloudHttp,
		}),
	);
	// Mistral AI (European) — OpenAI-compatible Chat Completions under la Plateforme's
	// base URL, so it rides the OpenAI provider with its own id, key custody, and model.
	aiProviders.register(
		createOpenAiProvider({
			id: MISTRAL_PROVIDER_ID,
			label: "Mistral",
			baseUrl: process.env.BRAINSTORM_MISTRAL_BASE_URL ?? "https://api.mistral.ai/v1",
			defaultModel: process.env.BRAINSTORM_MISTRAL_MODEL ?? "mistral-large-latest",
			getApiKey: cloudKey(MISTRAL_PROVIDER_ID, "BRAINSTORM_MISTRAL_API_KEY"),
			http: cloudHttp,
		}),
	);
	aiProviders.register(
		createGeminiProvider({
			...(process.env.BRAINSTORM_GEMINI_BASE_URL
				? { baseUrl: process.env.BRAINSTORM_GEMINI_BASE_URL }
				: {}),
			defaultModel: process.env.BRAINSTORM_GEMINI_MODEL ?? "gemini-2.0-flash",
			getApiKey: cloudKey(GEMINI_PROVIDER_ID, "BRAINSTORM_GEMINI_API_KEY"),
			http: cloudHttp,
		}),
	);
	// 11.9 — bind the routing applier now that the registry exists. A persisted
	// `defaultProvider` (Settings → AI) pins routing; `null` restores the
	// built-in default (local Ollama, registered first). Applied per vault open
	// (onVaultOpened) + immediately for an already-open vault.
	applyAiDefaultProvider = (id) => {
		aiProviders.setDefault(id && aiProviders.has(id) ? id : OLLAMA_PROVIDER_ID);
	};
	{
		const openSession = getActiveVaultSession();
		if (openSession) {
			void readAiSettings(openSession.vaultPath)
				.then((s) => applyAiDefaultProvider?.(s.defaultProvider))
				.catch(() => {});
		}
	}
	// 11.8 — per-call AI provenance. Each model-calling verb records one JSONL
	// row (app · verb · provider/model · tokens · outcome) via the network
	// audit's generic file sink; metadata only (never prompt/completion). The
	// raw log stays shell-side; a per-app summary surfaces later (AI panel /
	// budget enforcement 14.8).
	const aiUsageSink = makeFileAuditSink(aiUsagePath);
	workers.broker.registerService(
		"ai",
		makeAiServiceHandler({
			getProvider: (id) => aiProviders.get(id),
			onUsage: (rec) => void recordAiUsage(aiUsageSink, rec),
			// 11.5 `extract({ intoType })` — resolve a registered entity type's
			// inline JSON-Schema to extract fields (registry-coupled). Best-effort:
			// an unknown type / no schema returns null → the handler fails closed.
			resolveTypeFields: async (typeId) => {
				const session = getActiveVaultSession();
				if (!session) return null;
				const registry = await session.dataStores.open("registry");
				const record = new EntityTypesRepository(registry).get(typeId);
				if (!record?.schemaInline) return null;
				return extractFieldsFromTypeSchema(record.schemaInline as TypeSchemaForExtract);
			},
		}),
	);

	// 14.1 — the billing service. Reports the current plan + entitlement from
	// the per-device `account.db` cache (v1: hardcoded Free until the 14.3
	// refresh path caches a verified token). The scarce `billing.read` cap is
	// re-checked server-side against the live ledger (the broker's declared-caps
	// check is app-controlled), mirroring the network / mcp / ai services.
	workers.broker.registerService(
		"billing",
		makeBillingServiceHandler({
			getService: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.billingService();
			},
			getLedger: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.capabilityLedger();
			},
		}),
	);

	// DND-1 — the `selection` broker service (§Part IV.1). The
	// shell holds the focused app's published selection in one in-memory slot
	// (`selectionStore`), so selection-driven intents + the action surface +
	// keyboard "move to…" can read "what's selected" without each app
	// reinventing it. It is also the cross-app drag payload at rest (DND-2+).
	// Privacy by construction: one slot, stamped with the (broker-verified)
	// publishing app and validated against LIVE focus on every read — app B can
	// never read app A's selection unless A is focused. `selection.read` is a
	// scarce cap; `selection.publish` is opt-in per app manifest. Both re-checked
	// server-side against the live ledger (declared caps are app-controlled).
	const selectionStore = new SelectionStore();
	workers.broker.registerService(
		"selection",
		makeSelectionServiceHandler({
			store: selectionStore,
			getLedger: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.capabilityLedger();
			},
			getFocusedApp: () =>
				launchSetup
					.getWindowIndexSync()
					?.list()
					.find((w) => w.focused)?.appId ?? null,
		}),
	);

	// DND-5 — how long an exported file's decrypted temp copy may live before it's
	// reclaimed. Long enough for the user to complete the drag-drop, short enough
	// that plaintext vault bytes don't linger in the shared temp dir.
	const DRAG_EXPORT_TEMP_TTL_MS = 60_000;
	// DND-2 — the `dnd` broker service: the shell-mediated cross-app drag session
	// (§Part IV.2). Native HTML5 DnD can't cross the per-app
	// renderer boundary, so the shell stamps `sourceApp`, hit-tests the target
	// window via the window index, and negotiates the drop (kinds+point on hover
	// — OQ-DND-2 privacy — payload only on drop, caps re-checked fail-closed).
	// The pure session lifecycle + hit-test are unit-tested; here we wire the
	// real per-window notifier + window snapshot + the DND-2b ghost overlay (the
	// transparent click-through always-on-top window, OQ-DND-1 → option (a),
	// lazily created on the first drag). Remaining for end-to-end: the source
	// renderer's pointer-capture forwarding (`pointermove`→`dnd.move`, up→drop,
	// Esc→cancel) — pairs with the DND-3 `useDropTarget` SDK primitive.
	workers.broker.registerService(
		"dnd",
		makeDndServiceHandler({
			store: new DragSessionStore(),
			ghost: createGhostOverlay(createElectronGhostWindow),
			notify: (target, channel, payload) => {
				const window = launchSetup
					.getLauncherSync()
					?.allWindows()
					.find((w) => w.appId === target.appId && w.windowId === target.windowId);
				if (!window || window.webContents.isDestroyed()) return;
				try {
					window.webContents.send(channel, payload);
				} catch (error) {
					console.warn(`[dnd] notify ${channel} → ${target.appId}/${target.windowId} failed:`, error);
				}
			},
			windowEntries: () => launchSetup.getWindowIndexSync()?.list() ?? [],
			getLedger: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.capabilityLedger();
			},
			// DND-5 (scope D) — drag a file OUT to the OS. The renderer hands us the
			// decrypted bytes; we write them to a fresh temp dir (hostile names are
			// sanitised to a basename) and start the OS drag on the source app's
			// window via `webContents.startDrag`.
			exportFile: createFileExporter({
				resolveWindow: (app) => {
					const windows = launchSetup.getLauncherSync()?.allWindows() ?? [];
					const win =
						windows.find((w) => w.appId === app && w.webContents.isFocused()) ??
						windows.find((w) => w.appId === app);
					return win && !win.webContents.isDestroyed() ? win.webContents : null;
				},
				writeTemp: async (filename, bytes) => {
					const dir = await mkdtemp(join(tmpdir(), "bs-drag-"));
					const filePath = join(dir, filename);
					// `0o600` — these are DECRYPTED vault bytes; keep them owner-only,
					// not world-readable in the shared temp dir.
					await writeFile(filePath, bytes, { mode: 0o600 });
					// The OS copies the dragged file on drop, so reclaim the plaintext
					// shortly after — it must not linger and defeat encryption-at-rest.
					setTimeout(() => {
						void rm(dir, { recursive: true, force: true }).catch(() => {});
					}, DRAG_EXPORT_TEMP_TTL_MS);
					return filePath;
				},
				dragIcon: () => {
					const icon = nativeImage.createFromPath(resolveIconPath());
					return icon.isEmpty() ? icon : icon.resize({ width: 64, height: 64 });
				},
			}),
		}),
	);

	// MCP-1 — the MCP broker service. Apps (the Agent app) reach
	// `services.mcp.listTools / .callTool`; the SDK proxy declares the per-server
	// `mcp.server:<id>` cap, and the broker re-checks it against the ledger
	// server-side (the authoritative gate — declared caps are app-controlled).
	// Connections ride the HTTP transport over `executeNetworkFetch` (per-origin
	// egress gate, SSRF guard, size/time caps, network audit). The Tier-2 auth
	// secret is resolved main-only inside `connectMcpServer` (never crosses IPC).
	// Every `tools/call` lands one arg-SHAPE-only audit row in `mcp-audit.jsonl`.
	// stdio (local-process) transport is OUT OF SCOPE for v1 (OQ-MCP-2) — a
	// non-HTTP server is treated as unavailable, never spawned.
	const mcpAuditSink = makeFileAuditSink(join(app.getPath("userData"), "mcp-audit.jsonl"));
	const mcpFetchJson = async (input: {
		url: string;
		headers: Readonly<Record<string, string>>;
		bodyJson: unknown;
		timeoutMs: number;
		sizeCapBytes: number;
	}): Promise<{ status: number; text: string }> => {
		const res = await executeNetworkFetch(
			{
				appId: "_shell.mcp",
				url: input.url,
				method: "POST",
				headers: { ...input.headers },
				body: new TextEncoder().encode(JSON.stringify(input.bodyJson)),
				timeoutMs: input.timeoutMs,
				sizeCapBytes: input.sizeCapBytes,
			},
			{
				fetchImpl: productionFetchImpl,
				lookupHost: productionLookupHost,
				auditSink: makeFileAuditSink(networkAuditPath),
			},
		);
		return { status: res.status, text: new TextDecoder().decode(res.body) };
	};
	workers.broker.registerService(
		"mcp",
		makeMcpServiceHandler({
			getVaultPath: () => getActiveVaultSession()?.vaultPath ?? null,
			getLedger: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.capabilityLedger();
			},
			connect: (server) =>
				connectMcpServer(server, {
					fetchJson: mcpFetchJson,
					getCredentialStore: () => getActiveVaultSession()?.credentials ?? null,
					spawn: nodeStdioSpawn,
				}),
			onCall: (rec) => void recordMcpCall(mcpAuditSink, rec),
		}),
	);

	// Net-1a step 3 — network broker. Apps reach `services.network.fetch`
	// through this handler; the SDK proxy declares `network.fetch` as the
	// required capability, so the broker checks the ledger before the
	// envelope is forwarded. SSRF guard + IP-revalidation per redirect +
	// response-size/time caps + audit-log write happen inside the
	// executor (`executeNetworkFetch`). Production bindings: Electron's
	// `net.fetch` + Node `dns.promises.lookup`. Audit log lives at
	// `<userData>/network-audit.jsonl` — read by Settings → Privacy →
	// Network (Net-1a step 5).
	//
	// Net-1c — wire the preview cache singleton (declared at the top of
	// the IIFE) into the network service handler. The cache is cleared
	// on every vault switch (in `onVaultOpened` below) so vault A's
	// cached previews never leak into vault B.
	//
	// Net-1d — proxy config + apply binding. The `getProxyConfig` reader
	// is now vault-aware (Net-1e): it returns the active session's
	// `proxyOverride` when set, else `DEFAULT_PROXY_CONFIG` (system
	// proxy, per doc-38 §Decision "Brainstorm's default is system proxy
	// with a one-click 'use direct connection' override"). The
	// `cachedVaultNetworkSettings` getter returns null until the first
	// `vaultNetworkSettings()` load completes — `onVaultOpened`
	// pre-flights it, so a session that's been open more than one
	// event-loop tick has the cache primed.
	//
	// Net-1e — `getPrivacyConfig` reads the active session's privacy
	// policy (Off / On / Allowlist / Manual). When previews are blocked
	// (Off / Manual / Allowlist-miss) `handlePreview` throws a typed
	// `PreviewBlocked` error with a `reason` field — the SDK relays
	// that to apps so they can render the right affordance per doc-38
	// §User control. Default-on missing session = `DEFAULT_ON_PRIVACY`
	// (any URL previews) so a pre-vault-open paste still works.
	workers.broker.registerService(
		"network",
		makeNetworkServiceHandler({
			fetchImpl: productionFetchImpl,
			lookupHost: productionLookupHost,
			auditSink: makeFileAuditSink(networkAuditPath),
			previewCache,
			// SECURITY (Net-1a) — enforce the scarce egress caps
			// (network.fetch / .preview / .readable, none default-minimum)
			// against the live ledger server-side. The broker's declared-caps
			// check is app-controlled and bypassable by omitting the cap; this
			// is the authoritative gate. Mirrors the entities service.
			getLedger: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.capabilityLedger();
			},
			getProxyConfig: () => {
				const session = getActiveVaultSession();
				const settings = session?.cachedVaultNetworkSettings;
				return settings?.proxyOverride ?? DEFAULT_PROXY_CONFIG;
			},
			getPrivacyConfig: () => {
				const session = getActiveVaultSession();
				const settings = session?.cachedVaultNetworkSettings;
				return settings?.privacy ?? DEFAULT_ON_PRIVACY;
			},
			applyProxyConfig: productionApplyProxyConfig,
			// Net-2c — the readable service forwards fetched HTML to the
			// extraction worker (CPU-heavy parse, off the broker loop).
			extractReadable: (input) =>
				workers ? workers.extraction.extract(input) : Promise.resolve({ blocks: null }),
			// Asset subsystem — store a downloaded favicon/cover into the
			// active vault's encrypted asset store. Throws with no vault open;
			// the handler's `fetchAndStoreImage` catches and degrades to the
			// remote URL.
			storeImageAsset: async (input) => {
				const session = getActiveVaultSession();
				if (!session) throw new Error("no active vault session for asset storage");
				const store = await session.assetStore();
				return store.writeAsset(input);
			},
		}),
	);

	// Connector framework (doc 56) — the OAuth / request broker. `authorize`
	// / `revoke` need `connectors.oauth`; `request` needs `connectors.request`
	// + the derived `network.connect:<origin>`, all re-checked server-side
	// against the ledger. Tokens live in Tier 2 (CredentialStore) keyed by
	// the ConnectorAccount id and NEVER cross IPC; every egress rides Net-1's
	// `executeNetworkFetch` (SSRF + caps + audit). Real-shell OAuth round-trip
	// verification is pending — the engine is fully unit-tested.
	const connectorsEgress = makeNetworkEgress({
		executeOptions: {
			fetchImpl: productionFetchImpl,
			lookupHost: productionLookupHost,
			auditSink: makeFileAuditSink(networkAuditPath),
		},
		appId: "io.brainstorm.connectors",
	});
	const connectorsGetLedger = async () => {
		const session = getActiveVaultSession();
		if (!session) return null;
		return await session.capabilityLedger();
	};
	const connectorsCallEntities = (appId: string, method: string, arg: unknown) => {
		const handler = workersRef.broker.getServiceHandler("entities");
		if (!handler) throw new Error("entities service unavailable");
		return Promise.resolve(
			handler({
				v: 1,
				msg: `conn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
				app: appId,
				service: "entities",
				method,
				args: [arg],
				caps: [],
			}),
		);
	};
	const connectorsDeps = buildConnectorsServiceDeps({
		egress: connectorsEgress,
		getRepo: getEntitiesRepoForActiveSession,
		getCredentials: () => getActiveVaultSession()?.credentials ?? null,
		getLedger: connectorsGetLedger,
		callEntities: connectorsCallEntities,
		openExternal: (url) => shell.openExternal(url),
		notify: (n) =>
			getUiNotifyHost().post({
				appId: "io.brainstorm.connectors",
				kind: "warning",
				title: n.title,
				body: n.body,
			}),
	});
	// Connector-SEC1: token-endpoint egress is allowlisted from STATIC shell
	// code only — a `Connector/v1` entity can widen its `egressOrigins` but
	// never this set, so a repointed `tokenUrl` fails closed before the
	// refresh token / client secret leave the credential store.
	connectorsDeps.broker.registerTokenEndpoint(GMAIL_TOKEN_URL);
	workers.broker.registerService("connectors", makeConnectorsServiceHandler(connectorsDeps));

	// Mailbox-5 — the app-facing `mail` service (Gmail / IMAP connect, sync,
	// idempotent send, disconnect). OAuth + token custody ride the connector
	// broker above (Mailbox is the reference connector, Connector-7); an
	// IMAP app-password lives in Tier 2 keyed by the account entity id; the
	// data path is the MailTransport worker driven by the main-process
	// MailSyncEngine. Every broker method is re-checked server-side against
	// `mail.manage`; the `send` intent path was ledger-checked for
	// `intents.dispatch:send` by the broker before reaching the bus.
	mailServiceApi = createMailService({
		broker: connectorsDeps.broker,
		redirectProvider: connectorsDeps.redirectProvider,
		egress: connectorsEgress,
		getRepo: getEntitiesRepoForActiveSession,
		callEntities: connectorsCallEntities,
		transport: createWorkerMailTransport(workers.mailboxBridge),
		getCredentials: () => getActiveVaultSession()?.credentials ?? null,
		getLedger: connectorsGetLedger,
	});
	workers.broker.registerService("mail", mailServiceApi.handler);
	// Mailbox-2 — session-open registration: enabled accounts sync on vault
	// open and on a periodic schedule, Mailbox window closed or not.
	restartMailSessionSync();

	// 9.15.19 — the app-facing `caldav` service (CalDAV connect / list /
	// subscribe / two-way sync / disconnect). Basic credentials are sealed
	// in Tier 2 the moment connect validates them and the Authorization
	// header is injected main-side; every request is validated against the
	// account's frozen egress origins and rides the shared audited
	// connector egress. Every method re-checks `caldav.manage`.
	workers.broker.registerService(
		"caldav",
		makeCalDavServiceHandler({
			egress: connectorsEgress,
			getRepo: getEntitiesRepoForActiveSession,
			getCredentials: () => getActiveVaultSession()?.credentials ?? null,
			callEntities: connectorsCallEntities,
			getLedger: connectorsGetLedger,
		}),
	);

	// 11b.6 deploy — the automations engine goes live per vault session.
	// `buildAutomationsDeployment` (automations/wiring.ts) owns the
	// scheduler + runners; this block contributes only closures: entities
	// writes under the automations app identity (capability-checked, same
	// shape as connectors), the live ledger (app-grant ceiling per fire +
	// the 11b.15 designation gate), registry.db scheduler persistence, the
	// post-commit change emitter, the shared notify host, and Net-1 egress
	// for HTTP steps (11b.8 — SSRF guard + audit log inherited).
	const automationsEgress = makeNetworkEgress({
		executeOptions: {
			fetchImpl: productionFetchImpl,
			lookupHost: productionLookupHost,
			auditSink: makeFileAuditSink(networkAuditPath),
		},
		appId: AUTOMATIONS_APP_ID,
	});
	let automationsDeployment: AutomationsDeployment | null = null;
	const startAutomationsForActiveSession = async (): Promise<void> => {
		automationsDeployment?.stop();
		automationsDeployment = null;
		const session = getActiveVaultSession();
		if (!session) return;
		try {
			const registryDb = await session.dataStores.open("registry");
			const deployment = buildAutomationsDeployment({
				callEntities: (method, arg) => connectorsCallEntities(AUTOMATIONS_APP_ID, method, arg),
				getServiceHandler: (name) => workersRef.broker.getServiceHandler(name),
				getLedger: connectorsGetLedger,
				schedulerStore: new RegistrySchedulerStore(new SchedulerFiresRepository(registryDb)),
				entityChanges: automationsChangeEmitter,
				notify: (n) =>
					getUiNotifyHost().post({
						appId: AUTOMATIONS_APP_ID,
						kind: "info",
						title: n.title,
						...(n.body !== undefined ? { body: n.body } : {}),
					}),
				deviceId: session.deviceEd25519.publicKeyBase64,
				egress: automationsEgress,
			});
			automationsDeployment = deployment;
			const status = await deployment.start();
			// A vault switch racing the async start: the new session's start
			// already replaced the slot, so this deployment must shut down.
			if (automationsDeployment !== deployment) {
				deployment.stop();
				return;
			}
			console.log(
				`[automations] engine ${status.scheduling ? "scheduling" : "standby (another device is the automation host)"}`,
			);
		} catch (error) {
			console.warn(`[brainstorm] automations engine failed to start: ${(error as Error).message}`);
		}
	};
	onActiveVaultSessionChanged(() => {
		void startAutomationsForActiveSession();
	});
	if (getActiveVaultSession()) void startAutomationsForActiveSession();

	// The app-facing `automations` service: runNow (Manual trigger) +
	// hostStatus/claimHost (11b.15). `automations.run` re-checked
	// server-side against the live ledger inside the handler.
	workers.broker.registerService(
		"automations",
		makeAutomationsServiceHandler({
			getDeployment: () => automationsDeployment,
			getLedger: connectorsGetLedger,
		}),
	);

	// B7.2c — capability-gated cover content store. The broker checks
	// `covers.write` (uploadBytes/delete) / `covers.read` (list); this
	// handler shares the exact audited store core the dashboard
	// `covers:*` ipcMain handlers use.
	workers.broker.registerService(
		"covers",
		makeCoversServiceHandler({
			getVaultPath: () => getActiveVaultSession()?.vaultPath ?? null,
		}),
	);

	// 9.10 — Files host service. The broker checks `files.read` / `files.write`
	// (stamped by the SDK proxy) before this runs; the handler then resolves
	// the per-vault FileHandleRegistry, the only place token → path lookup is
	// allowed. Open / save dialogs run on the dashboard window so they parent
	// correctly; cancellation is data (not a thrown denial). `watch` events
	// fan out via the `app:files-watch` channel to every window of the
	// owning app — same pattern the vault-entities staleness signal uses.
	// Parent an OS file dialog to the window that ASKED for it. App windows are
	// `BaseWindow` containers (not `BrowserWindow`), so `getFocusedWindow()`
	// can't see them — parenting to `dashboardWindow` instead dragged the
	// dashboard forward and hid the requesting app (the "I see the dashboard,
	// not the book app" report). Prefer the app's focused container, else its
	// first live one, else the dashboard.
	const dialogParentFor = (appId: string): Electron.BaseWindow | null => {
		const containers = launchSetup.getLauncherSync()?.allContainers() ?? [];
		const forApp = containers.filter((c) => c.appId === appId && !c.parked);
		const chosen = forApp.find((c) => c.container.baseWindow.isFocused()) ?? forApp[0];
		if (chosen) return chosen.container.baseWindow as unknown as Electron.BaseWindow;
		return dashboardWindow;
	};
	workers.broker.registerService(
		"files",
		makeFilesServiceHandler({
			getRegistry: () => getActiveVaultSession()?.fileHandles ?? null,
			showOpenDialog: async (normalized, appId) => {
				const open: Electron.OpenDialogOptions = {
					filters: normalized.filters.slice(),
					properties: normalized.multi ? ["openFile", "multiSelections"] : ["openFile"],
				};
				if (normalized.title) open.title = normalized.title;
				const parent = dialogParentFor(appId);
				const result = parent
					? await dialog.showOpenDialog(parent, open)
					: await dialog.showOpenDialog(open);
				return { canceled: result.canceled, filePaths: result.filePaths };
			},
			showSaveDialog: async (normalized, appId) => {
				const save: Electron.SaveDialogOptions = {
					filters: normalized.filters.slice(),
				};
				if (normalized.title) save.title = normalized.title;
				if (normalized.suggestedName) save.defaultPath = normalized.suggestedName;
				const parent = dialogParentFor(appId);
				const result = parent
					? await dialog.showSaveDialog(parent, save)
					: await dialog.showSaveDialog(save);
				return { canceled: result.canceled, filePath: result.filePath ?? null };
			},
			emitWatch: (appId, event) => {
				const windows = launchSetup.getLauncherSync()?.windowsFor(appId) ?? [];
				for (const win of windows) {
					if (win.webContents.isDestroyed()) continue;
					try {
						win.webContents.send(APP_FILES_WATCH_CHANNEL, event);
					} catch (error) {
						console.warn(`[brainstorm] files watch emit to ${appId} failed:`, error);
					}
				}
			},
			// `files.import` — seal upload bytes into the active vault's
			// encrypted asset store. `markBound` immediately: the upload
			// gesture is the binding intent, so a stored upload is never
			// orphan-reap-eligible even before its File/v1 row lands.
			storeUploadAsset: async ({ bytes, mime }) => {
				const session = getActiveVaultSession();
				if (!session) throw new Error("files.import: no active vault session");
				const store = await session.assetStore();
				const result = await store.writeAsset({ bytes, mime, kind: AssetKind.Upload });
				store.markBound(result.assetId);
				return result;
			},
			// Files "Storage" view — aggregate every byte the vault keeps on disk
			// (encrypted asset-store uploads + the cover / wallpaper / icon
			// content stores) into one inventory. The pure normalize + order lives
			// in `gatherStorageInventory`; here we supply the real listers + stat.
			listStorageInventory: async () => {
				const session = getActiveVaultSession();
				if (!session) return [];
				const store = await session.assetStore();
				const repo = await getEntitiesRepoForActiveSession();
				const owners = repo?.listAssetOwners() ?? [];
				const ownerByAsset = new Map(owners.map((o) => [o.assetId, o]));
				const liveIds = new Set(owners.map((o) => o.assetId));
				const inventory = await gatherStorageInventory({
					vaultPath: session.vaultPath,
					listBoundAssets: () => store.listBound(),
					liveAssetIds: () => liveIds,
					listCovers: () => listCovers(session.vaultPath),
					listWallpapers: () => listWallpaperEntries(session.vaultPath),
					listIcons: () => listIcons(session.vaultPath),
					statSize: async (absPath) => {
						try {
							return (await stat(absPath)).size;
						} catch {
							return -1;
						}
					},
				});
				// Stamp the owning entity onto upload blobs so the Storage view
				// can open them in Preview; covers / wallpapers / icons aren't
				// entities and stay non-openable.
				return inventory.map((asset) => {
					const owner = asset.kind === StoredAssetKind.Upload ? ownerByAsset.get(asset.id) : undefined;
					return owner ? { ...asset, entityId: owner.id, entityType: owner.type } : asset;
				});
			},
		}),
	);

	// Browser-2 — the `WebView` host service: shell-managed, partitioned,
	// Node-less `WebContentsView`s the Browser app's chrome drives (the
	// chrome never touches the page DOM/bytes). Web content runs OUTSIDE any
	// Brainstorm renderer; `web.browse` is the High capability gating it.
	// Metadata events fan to the owning app's windows on the same broadcast
	// pattern as `files.watch`.
	// Page-view webContents → owning browser window. Menu accelerators fire
	// while OS focus rests on the page (not the chrome renderer), so the
	// New-Tab handler needs this to find its way back to the chrome.
	const webViewOwners = new Map<number, { appId: string; windowId: string }>();
	// Browser-7 — per-vault web-privacy stores: site-permission grants
	// (deny-default camera/mic/geo with explicit per-origin allows) + the
	// per-host egress aggregate the Settings → Privacy panel renders.
	const webPrivacy = createWebPrivacyRuntime({
		getVaultPath: () => getActiveVaultSession()?.vaultPath ?? null,
	});
	registerWebPrivacyHandlers(webPrivacy);

	// Browser-10 — the persistent encrypted cookie jar follows the active vault.
	// On open we hydrate the shared persistent web session from the vault's
	// `cookies.db`; on close (or vault switch) we tear it down — flushing the
	// listener and clearing the LIVE session so the next vault can't inherit
	// this one's cookies. The jar lives in the main process only; no page or app
	// renderer ever touches a cookie.
	let webCookieJar: Awaited<ReturnType<typeof openWebCookieJar>> | null = null;
	let cookieJarWork: Promise<unknown> = Promise.resolve();
	async function openWebCookieJar(session: VaultSession) {
		const repo = new CookieJarRepository(await session.dataStores.open("cookies"));
		const jar = createWebCookieJar(repo, electronSession.fromPartition(PERSISTENT_WEB_PARTITION));
		await jar.hydrate();
		return jar;
	}
	onActiveVaultSessionChanged((session) => {
		// Serialise open/close so a fast vault flip can't interleave hydrate of
		// the new jar with dispose of the old.
		const previous = webCookieJar;
		webCookieJar = null;
		cookieJarWork = cookieJarWork
			.then(async () => {
				await previous?.dispose();
				webCookieJar = session ? await openWebCookieJar(session) : null;
			})
			.catch((error) => {
				console.warn("[brainstorm] web cookie jar lifecycle failed:", error);
			});
	});

	workers.broker.registerService(
		WEBVIEW_SERVICE,
		makeWebViewServiceHandler({
			clearBrowsingData: () => webCookieJar?.clear(),
			setSitePermission: (origin, permission, allow) =>
				webPrivacy.permissions.set(origin, permission, allow),
			createView: (spec) => {
				const view = createLockedWebView(spec, {
					allowDevTools: DEVTOOLS_ENABLED,
					decidePermission: (origin, kind) => webPrivacy.permissions.decision(origin, kind),
					recordEgress: (host, blocked) => webPrivacy.egress.record(host, blocked),
					// New-tab / pre-paint surface follows the active theme (the
					// same `background.primary` the app windows paint) instead of
					// hardcoded white.
					resolveBackgroundColor: async () => {
						const session = getActiveVaultSession();
						if (!session) return null;
						const dashboard = await session.dashboardStore();
						const theme = dashboard.activeTheme(nativeTheme.shouldUseDarkColors);
						return themes[theme].color.background.primary;
					},
					// Cmd+W inside the page → close the Browser's own tab: route the
					// chord to the owning chrome renderer (same channel as Cmd+T).
					onCloseChord: () => {
						const win = launchSetup
							.getLauncherSync()
							?.getExistingWindow(spec.appId, spec.window.windowId);
						win?.webContents.send(APP_TAB_COMMAND_CHANNEL, { kind: TabCommandKind.CloseTab });
					},
				});
				webViewOwners.set(view.webContentsId, {
					appId: spec.appId,
					windowId: spec.window.windowId,
				});
				return {
					...view,
					destroy: () => {
						webViewOwners.delete(view.webContentsId);
						view.destroy();
					},
				};
			},
			resolveWindow: (appId) => {
				const win = launchSetup.getLauncherSync()?.windowsFor(appId)[0];
				if (!win) return null;
				return {
					baseWindow: win.container.baseWindow,
					windowId: win.windowId,
					bodyOrigin: () => {
						const body = win.container.bodyBounds();
						return { x: body.x, y: body.y };
					},
				};
			},
			emitEvent: (appId, event) => {
				const windows = launchSetup.getLauncherSync()?.windowsFor(appId) ?? [];
				for (const win of windows) {
					if (win.webContents.isDestroyed()) continue;
					try {
						win.webContents.send(APP_WEBVIEW_EVENT_CHANNEL, event);
					} catch (error) {
						console.warn(`[brainstorm] webView event emit to ${appId} failed:`, error);
					}
				}
			},
		}),
	);

	// 9.11 — block-id → providing-app registry, read-only + capability
	// gated (`blocks.read`). The host owns registration (manifest →
	// installer); apps only `list` / `resolve`. Same registry.db the
	// AppInstaller writes; opened lazily per call (cheap, session-scoped).
	workers.broker.registerService(
		"blocks",
		makeBlocksServiceHandler({
			getBlocksRepo: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return new BlocksRepository(await session.dataStores.open("registry"));
			},
		}),
	);

	// 9.3.3.1/.2/.3 — Block Protocol message router. Receives a BP
	// envelope from a host-app's bridge (which itself got it via the
	// 9.5.2 transport `onMessage`); dispatches by module. `graph` wires
	// to the real `entities` service handler — the same per-type cap
	// authority used by every other entities call, so no new privileged
	// channel. `hook` ships as a structural dispatcher only (OQ-BP-5 —
	// host overlay rendering is forward UI work); registrations return
	// NOT_IMPLEMENTED, destroys are idempotent.
	const bpGraphHandler = makeBpGraphRouter({
		entities: (envelope) => entitiesHandler(envelope),
	});
	const bpHookHandler = makeBpHookRouter();
	const bpRouter = makeBpRouter({ graph: bpGraphHandler, hook: bpHookHandler });
	workers.broker.registerService("bp", async (envelope) => {
		const args = envelope.args[0];
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			throw Object.assign(new Error("bp.dispatch: missing args"), { name: "Invalid" });
		}
		const entityId = (args as Record<string, unknown>).entityId;
		if (typeof entityId !== "string" || entityId === "") {
			throw Object.assign(new Error("bp.dispatch: missing entityId"), { name: "Invalid" });
		}
		const payload = (args as Record<string, unknown>).payload;
		return await bpRouter({ app: envelope.app, entityId }, payload);
	});

	// 6.10c — runtime-registered dynamic shortcuts + per-app active-scope
	// reporting from sandboxed app renderers. Capability-gated
	// (`shortcuts.register`, default-minimum). The shell-side registry is
	// the same singleton the broker chord-matcher reads, so a freshly
	// registered dynamic shortcut is visible to the cheatsheet
	// aggregator + conflict report immediately.
	workers.broker.registerService(
		"shortcuts",
		makeShortcutsServiceHandler({
			getRegistry: () => shortcutRegistry,
		}),
	);

	// 7.13 — pin-any-object-to-dashboard. The broker checks the unscoped
	// default-minimum `dashboard.pin` (stamped by the SDK proxy) before
	// this runs. The handler stores only the entity id on the
	// shell-owned dashboard doc — label/icon/opener-badge are live
	// resolved by `pin-resolver` on every dashboard read, never
	// persisted (no cross-app data leak).
	workers.broker.registerService(
		"dashboard",
		makeDashboardServiceHandler({
			getStore: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.dashboardStore();
			},
			getEntitiesRepo: getEntitiesRepoForActiveSession,
		}),
	);

	// B11.12 — export service. App-supplied self-contained HTML is rendered to
	// PDF in a sandboxed, script-disabled, network-blocked offscreen window
	// (print-to-pdf.ts); the broker checks `export.print-to-pdf` first.
	workers.broker.registerService(
		"export",
		makeExportServiceHandler({
			renderHtmlToPdf: productionRenderHtmlToPdf,
			// IE-8 — `serializeEntities` reads entities the app may read + serializes
			// to Markdown/CSV/JSON via the shared exporters (the inverse of `import`).
			getSession: () => getActiveVaultSession(),
			getLedger: async () => {
				const session = getActiveVaultSession();
				if (!session) return null;
				return await session.capabilityLedger();
			},
		}),
	);

	// B11.14 — app-facing icons store (custom emoji upload). Same content-
	// addressed vault icon store the dashboard `icons:*` IPC uses; the broker
	// checks `icons.read` / `icons.write` first.
	workers.broker.registerService(
		"icons",
		makeIconsServiceHandler({
			uploadBytes: async (name, bytesBase64) => {
				const session = getActiveVaultSession();
				if (!session) throw new Error("icons.uploadBytes: no active vault session");
				const ext = extname(name).toLowerCase();
				if (!ALLOWED_ICON_EXTS.has(ext)) {
					throw new Error(`icons.uploadBytes: unsupported file type: ${ext}`);
				}
				return uploadIconBytes(
					session.vaultPath,
					Buffer.from(bytesBase64, "base64"),
					ext,
					iconSeal(session),
				);
			},
			list: async () => {
				const session = getActiveVaultSession();
				return session ? listIcons(session.vaultPath) : [];
			},
			deleteIcon: async (url) => {
				const session = getActiveVaultSession();
				return session ? deleteIconByUrl(session.vaultPath, url) : false;
			},
		}),
	);

	// 7.7 — notification host. The broker checks `notifications.post`
	// (stamped by the SDK proxy) before this runs; the handler validates
	// shape and the pure host forwards to the dashboard renderer.
	const uiNotifyHost = getUiNotifyHost();
	// 7.8 — tray host. The broker checks `tray.publish`; the pure host
	// validates the spec + composes the menu model; the Electron `Tray`
	// is built from it below (after the dashboard window exists so a
	// click can fall back to focusing it).
	const trayHost = getTrayHost();
	workers.broker.registerService(
		"ui",
		makeUiServiceHandler({
			getHost: () => uiNotifyHost,
			getTrayHost: () => trayHost,
			// 9.8.9 — `ui.openSearch` (cap `search.open`): surface the global
			// search palette on the dashboard, pre-filled. Same focus dance as
			// a shell shortcut fired from an app window (shortcut-setup).
			openSearch: (query) => {
				const dashboard = dashboardWindow;
				if (!dashboard || dashboard.isDestroyed() || dashboard.webContents.isDestroyed()) return;
				if (dashboard.isMinimized()) dashboard.restore();
				dashboard.show();
				dashboard.focus();
				dashboard.webContents.send(SHELL_ACTION_CHANNEL, { action: "search", query });
			},
		}),
	);
	// 9.9.6 — transient cross-surface theme preview. The pure service sanitizes
	// the spec (canonical tokens + safe values only — `sanitizeThemePreview`)
	// then fans it out to the dashboard + every app window, auto-reverting after
	// the (clamped) duration. `theme.preview`-gated in the broker.
	const themePreviewService = new ThemePreviewService((payload) =>
		broadcastThemePreviewToWindows(
			payload,
			dashboardWindow,
			launchSetup.getLauncherSync()?.allWindows() ?? [],
		),
	);
	workers.broker.registerService("theme", makeThemeServiceHandler(themePreviewService));
	// Settings overhaul (Track C) — give the notify host its live dependencies:
	// read prefs + append history from the active vault's (already-open)
	// dashboard store synchronously, and raise OS-native popups when the shell
	// is unfocused. Defaults (pre-set) keep behaviour identical until a vault
	// opens; once open these enforce DND / per-app mute / osNative + persist the
	// notification center history.
	uiNotifyHost.setDeps({
		getPreferences: () =>
			getActiveVaultSession()?.dashboardStoreIfOpen()?.snapshot().notifications ?? null,
		recordHistory: (record) => {
			getActiveVaultSession()?.dashboardStoreIfOpen()?.pushNotification(record);
		},
		osNotify: makeOsNotifier({ isShellFocused: () => BrowserWindow.getFocusedWindow() !== null }),
		now: () => Date.now(),
	});

	// Privileged dashboard-renderer surfaces: search-results in the launcher
	// + intent.open dispatch when picking an entity hit. Same trust model as
	// dashboard / properties handlers — the shell renderer never goes through
	// the broker.
	registerSearchHandlers({
		getIndexer: () => searchIndexer,
		// 11.4 — share the broker `search.hybrid` fusion path for the launcher's
		// default search (degrades to lexical until 11.3 enables vector indexing).
		getVectorIndexer: () => vectorIndexer,
		reindex: rebuildSearchIndex,
		// Coverage source-of-truth: the same collector + indexable predicate
		// `rebuildSearchIndex` uses, so "indexed vs. available" can't drift
		// from what a rebuild would actually write.
		getAvailableCount: async () => {
			const session = getActiveVaultSession();
			if (!session) return null;
			const entities = await collectIndexableEntities(
				session.vaultPath,
				getEntitiesRepoForActiveSession,
			);
			return pickIndexable(entities).length;
		},
	});
	registerIntentHandlers(() => launchSetup.getIntents());

	const promptHost = getCapabilityPromptHost();
	wireCapabilityPromptIpc(promptHost);

	// OpenRes-1c — first-use OS-handoff consent prompt. Mirrors the
	// capability-prompt host: pure host posts the IPC, ipcMain wire
	// dispatches the reply. The dashboard renderer mount lives next to
	// `<CapabilityPromptHost />` in dashboard.tsx. The bus reads the
	// dashboard from launchSetup (which also owns its lifecycle).
	const osHandoffPromptHost = getOsHandoffPromptHost();
	wireOsHandoffPromptIpc(osHandoffPromptHost);

	// "Open with…" multi-candidate picker host (OpenRes-1c slice 6).
	// Same pattern as the os-handoff host above: pure host posts the
	// IPC, ipcMain wire dispatches the reply. The dashboard renderer
	// mount lives next to `<OpenWithPromptHost />` in dashboard.tsx.
	const openWithPromptHost = getOpenWithPromptHost();
	wireOpenWithPromptIpc(openWithPromptHost);

	// Compose + install the application menu. The router routes shell ids to
	// in-process handlers (which mostly forward to the dashboard via
	// `shell:action`); app ids go nowhere yet — the launcher (Stage 7) will
	// wire its per-app sender.
	const menu = createMenuSetup({
		getDashboard: () => dashboardWindow?.webContents ?? null,
		resolveFocusedTab: (webContentsId) => {
			const launcher = launchSetup.getLauncherSync();
			const hit = launcher?.containerForTabSender(webContentsId);
			if (hit) return { containerId: hit.container.id, appId: hit.appId, senderId: webContentsId };
			// Focus may rest on a Browser page `WebContentsView` (the normal
			// state while browsing) — map it back to the chrome tab driving it
			// so Cmd+T still lands.
			const owner = webViewOwners.get(webContentsId);
			if (!owner) return null;
			const win = launcher?.getExistingWindow(owner.appId, owner.windowId);
			if (!win) return null;
			return { containerId: win.container.id, appId: win.appId, senderId: win.webContentsId };
		},
		openFreshTab: (containerId, appId) => {
			void launchSetup
				.getOrchestratorSync()
				?.addTab(containerId, { appId, launch: { reason: "fresh" } });
		},
		// The Browser owns an internal tab model; route New Tab into its renderer
		// so Cmd+T adds a tab to its own strip instead of spawning a second
		// browser instance as a window-container tab.
		routeNewTabToApp: (senderId, appId) => {
			if (!appSelfManagesTabs(appId)) return false;
			webContents.fromId(senderId)?.send(APP_TAB_COMMAND_CHANNEL, { kind: TabCommandKind.NewTab });
			return true;
		},
		resolveActiveTabForChrome: (webContentsId) => {
			const hit = launchSetup.getLauncherSync()?.containerForChromeSender(webContentsId);
			return hit?.container.activeTab()?.webContentsId ?? null;
		},
	});
	// Install the menu with no help sections at boot — the corpus loader
	// is lazy-chunked (see the dynamic import wiring `registerHelpHandlers`
	// earlier) and reinstalls the menu once its sections are available.
	// `listSections` + `loadBundledHelpCorpus` both live behind the same
	// `./ipc/help-handlers` chunk, so this one dynamic import covers both.
	menu.installer.install({ focusedAppMenus: null, focusedAppId: null });
	void import("./ipc/help-handlers")
		.then(async ({ loadBundledHelpCorpus }) => {
			const { listSections } = await import("./help/help-corpus");
			const helpSections = listSections(loadBundledHelpCorpus());
			menu.installer.install({ focusedAppMenus: null, focusedAppId: null, helpSections });
		})
		.catch((error) => {
			console.error("[brainstorm] menu: failed to install help sections:", error);
		});

	const shortcuts = createShortcutSetup({
		getDashboard: () => dashboardWindow?.webContents ?? null,
		getWindowCount: () => launchSetup.getWindowIndexSync()?.list().length ?? 0,
	});
	// The boot session may have opened before the registry existed (the
	// `onVaultOpened` hook is wired earlier than this); run the migration +
	// override load now for that session. Subsequent vault switches go
	// through `onVaultOpened` → `loadShortcutBindings`.
	shortcutRegistry = shortcuts.registry;
	setActiveShortcutRegistry(shortcutRegistry);
	if (getActiveVaultSession()) {
		void loadShortcutBindings();
		void loadInstalledAppShortcuts();
	}

	// 6.10c — clear an app's dynamic shortcuts + active-scope state when
	// its last window closes (per §Aggregation across the sandbox
	// boundary: "Removed when the app's last window closes."). Tracks the
	// previous running set so each `onWindowsChanged` tick can diff to
	// find apps that went to zero. Re-subscribes on session rebuilds so
	// the listener follows the live launcher instance.
	let previousRunningApps = new Set<string>();
	let detachShortcutCleanup: (() => void) | null = null;
	const rebindShortcutCleanup = (): void => {
		detachShortcutCleanup?.();
		detachShortcutCleanup = null;
		previousRunningApps = new Set();
		const launcher = launchSetup.getLauncherSync();
		if (!launcher) return;
		detachShortcutCleanup = launcher.onWindowsChanged(() => {
			const registry = shortcutRegistry;
			if (!registry) return;
			const current = new Set(launcher.runningAppIds());
			for (const appId of previousRunningApps) {
				if (!current.has(appId)) {
					registry.unregisterAllDynamic(appId);
				}
			}
			previousRunningApps = current;
		});
	};
	launchSetup.onSessionRebuilt(rebindShortcutCleanup);
	rebindShortcutCleanup();

	// Shell shortcuts must reach EVERY Brainstorm BrowserWindow — dashboard,
	// every app window, and any later spawn — without depending on the
	// launcher's `onWindowsChanged` plumbing. The previous indirection (gated
	// on `onSessionRebuilt` firing before windows opened) silently missed
	// app windows on some boot orderings, so `⌘ Shift L` from a focused app
	// window did nothing — see §Delivery
	// mechanics. `attach()` is WeakSet-idempotent so multi-firing is a no-op.
	// Skip non-`window` webContents (devtools, BrowserView, webview, remote)
	// so DevTools keyboard stays unmodified.
	app.on("web-contents-created", (_event, webContents) => {
		if (webContents.getType() !== "window") return;
		shortcuts.attach(webContents);
	});

	bootStage("dashboard-window-creating");
	dashboardWindow = createDashboardWindow();
	registerAndTrack(dashboardWindow);
	shortcuts.attach(dashboardWindow.webContents);
	wireDashboardLinkRouting(dashboardWindow.webContents);
	promptHost.setDashboard(dashboardWindow.webContents);
	osHandoffPromptHost.setDashboard(dashboardWindow.webContents);
	openWithPromptHost.setDashboard(dashboardWindow.webContents);
	dashboardWindow.once("ready-to-show", () => bootStage("dashboard-window-shown"));
	dashboardWindow.webContents.once("dom-ready", () => bootStage("dashboard-renderer-domready"));
	dashboardWindow.webContents.once("did-finish-load", () => bootStage("dashboard-renderer-paint"));
	dashboardWindow.on("closed", () => {
		promptHost.setDashboard(null);
		osHandoffPromptHost.setDashboard(null);
		openWithPromptHost.setDashboard(null);
	});

	// 7.8 — render the pure tray model into a single OS `Tray`. The host
	// owns *what* the menu is; this owns the Electron object's lifecycle:
	// created on the first publish, rebuilt on every change, destroyed
	// when the last publisher clears (no empty icon left behind). Clicking
	// an item routes its intent through the existing IntentsBus attributed
	// to the publishing app — same path as the launcher / right-click.
	let tray: Tray | null = null;
	// Dedicated glyph-forward tray art — the full squircle icon collapses to a
	// dark blob (and, as a template, a featureless black silhouette) at ~18px.
	// macOS uses an alpha-only template the menu bar tints; Windows/Linux use
	// the glowing bolt. The art ships at 18/36px (@2x auto-picked), no resize.
	const trayIconFile = isMac ? "trayTemplate.png" : "tray.png";
	const trayIconPath = isDev
		? join(__dirname, "../../art", trayIconFile)
		: join(process.resourcesPath, "art", trayIconFile);
	const renderTray = (composed: ComposedTray | null): void => {
		if (!composed) {
			tray?.destroy();
			tray = null;
			return;
		}
		if (!tray) {
			const image = nativeImage.createFromPath(trayIconPath);
			if (isMac) image.setTemplateImage(true);
			tray = new Tray(image);
		}
		tray.setToolTip(composed.tooltip);
		const template = composed.entries.map((entry) => {
			if (entry.kind === "separator") return { type: "separator" as const };
			if (entry.kind === "header") return { label: entry.appId, enabled: false };
			return {
				label: entry.label,
				enabled: entry.enabled,
				click: () => {
					if (!entry.intent) return;
					const bus = launchSetup.getIntentsSync();
					if (!bus) return;
					void bus.dispatch(entry.intent, { app: entry.appId });
				},
			};
		});
		tray.setContextMenu(Menu.buildFromTemplate(template));
	};
	trayHost.setListener(renderTray);
	app.on("before-quit", () => {
		tray?.destroy();
		tray = null;
	});

	// Rebuild bundled apps from `apps/<dir>/` so source edits propagate
	// without a manual "Seed demo apps" click. Runs on boot AND whenever a
	// vault session opens. The old one-shot synchronous `&&
	// getActiveVaultSession()` check at whenReady meant a vault opened
	// *after* boot (picker / unlock — the normal case) NEVER re-seeded, so
	// source edits never reached the running shell no matter how many
	// restarts. That single missing `onActiveVaultSessionChanged` hook was
	// the root of the session-long "the fix never deploys" trap; this
	// mirrors the search-indexer / storage-vault wiring above. Opt out
	// with `BRAINSTORM_AUTO_SEED=0`. Removed once proper hot-reload lands.
	// Unmissable boot marker so ONE fresh `bun run dev` answers "is the
	// shell-side deploy fix even running?" from the terminal — no more
	// inferring it from a stale renderer console.
	console.log(
		`[brainstorm] BOOT shell-main marker=DEPLOYFIX-59069a1 isDev=${isDev} ` +
			`autoSeed=${process.env.BRAINSTORM_AUTO_SEED !== "0"} sessionAtBoot=${!!getActiveVaultSession()}`,
	);
	if (isDev && process.env.BRAINSTORM_AUTO_SEED !== "0") {
		bootStage("auto-seed-started");
		const repoRoot = join(__dirname, "..", "..", "..", "..");
		const appsDir = join(repoRoot, "apps");
		// Vaults that completed a SUCCESSFUL seed (apps built + reinstalled).
		// A failed seed must NOT land here — otherwise the boot-time race
		// (the session's DataStores get closed mid vite-build during boot
		// churn → "database connection is not open") permanently poisons the
		// vault: every later session-changed event sees it "already seeded"
		// and skips, so the fixed app bundles never deploy and `bun run dev`
		// silently serves a stale app forever (the "I don't see my fix" trap).
		const seededVaults = new Set<string>();
		// Vaults with a seed attempt in flight — guards against a concurrent
		// re-fire (session-changed can pulse several times during boot) while
		// still allowing a retry after a failure clears this.
		const seedingVaults = new Set<string>();
		// Bounded retry per vault so a genuinely broken seed can't spin.
		const seedAttempts = new Map<string, number>();
		const MAX_SEED_ATTEMPTS = 5;
		let firstSeedDoneLogged = false;
		const markFirstSeedDone = (): void => {
			if (!firstSeedDoneLogged) {
				firstSeedDoneLogged = true;
				bootStage("auto-seed-done");
			}
		};
		const runDevSeed = async (): Promise<void> => {
			const session = getActiveVaultSession();
			if (!session || seededVaults.has(session.vaultPath) || seedingVaults.has(session.vaultPath)) {
				return;
			}
			const vaultPath = session.vaultPath;
			const attempt = (seedAttempts.get(vaultPath) ?? 0) + 1;
			if (attempt > MAX_SEED_ATTEMPTS) {
				console.warn(
					`[brainstorm] dev: auto-seed gave up for ${vaultPath} after ${MAX_SEED_ATTEMPTS} attempts`,
				);
				markFirstSeedDone();
				return;
			}
			seedAttempts.set(vaultPath, attempt);
			seedingVaults.add(vaultPath);
			console.log(`[brainstorm] dev: runDevSeed FIRING for ${vaultPath} (attempt ${attempt})`);
			const { seedDemoApps } = await import("./dev/seed-demo-apps");
			void seedDemoApps(appsDir)
				.then((result) => {
					seedingVaults.delete(vaultPath);
					seededVaults.add(vaultPath);
					console.log(
						`[brainstorm] dev: auto-seed installed ${result.installed} apps, pinned ${result.pinned}, ${result.errors.length} errors`,
					);
					for (const error of result.errors) {
						console.warn(`[brainstorm] dev: auto-seed error: ${error}`);
					}
					markFirstSeedDone();
				})
				.catch((error) => {
					seedingVaults.delete(vaultPath);
					// Do NOT mark seeded — let it retry. Most failures here are the
					// transient boot-time session/DB-handle race; once the session
					// settles the retry succeeds and the fresh bundles deploy.
					console.warn(
						`[brainstorm] dev: auto-seed attempt ${attempt} failed: ${(error as Error).message} — will retry`,
					);
					if ((seedAttempts.get(vaultPath) ?? 0) < MAX_SEED_ATTEMPTS) {
						setTimeout(() => {
							void runDevSeed();
						}, 1500);
					} else {
						markFirstSeedDone();
					}
				});

			// The BrainstormProject content seed (implementation plan + OQs +
			// design docs → Tasks/Database/Notes/Graph) never runs on a RELEASE
			// boot — it stays a manual, explicit step via
			// `tools/mcp-server/src/seed/seed-cli.ts --vault <path>`, so a real
			// user's vault is never seeded out from under them. On the DEV path
			// only (this whole block is gated on `isDev && AUTO_SEED !== "0"`),
			// `reseedVaultContent` below re-anchors that projection to today on
			// each boot (see its rationale comment); the companions after it only
			// register property catalogs into the vault YDoc (the CLI can't write
			// it) and are idempotent, so they stay on the session hook.
			if (session) {
				// Re-anchor the BrainstormProject plan projection to *today* on
				// every dev boot. The projection is not a static one-shot: pending
				// tasks are laid into a 30-day window starting at the seed's `now`,
				// so an old seed drifts overdue as wall-clock moves on, and an
				// iteration marked done in the plan (✅) never reaches the vault
				// until the projection re-runs. `reseedVaultContent` runs the Bun
				// seed-cli (fresh `now`) — which parks a snapshot in the seed
				// sidecar because it can't open the encrypted `entities.db` — then
				// drains that sidecar in-process (master key + SQLCipher live here).
				// This supersedes the old bare-drain, which only landed a sidecar a
				// manual CLI-then-restart had left behind.
				void import("./dev/reseed-vault-content")
					.then(({ reseedVaultContent }) => reseedVaultContent(repoRoot, session))
					.then((result) => {
						if (!result.ok) {
							console.warn(`[brainstorm] dev: content reseed failed: ${result.reason}`);
							return;
						}
						const drained = result.drained;
						if (drained.applied) {
							console.log(
								`[brainstorm] dev: re-anchored plan projection (${drained.entitiesCreated} created, ${drained.entitiesUpdated} updated, ${drained.entitiesRemoved} removed, ${drained.linksWritten} links)`,
							);
							broadcastVaultEntitiesStaleSignal(launchSetup.getLauncherSync()?.allWindows() ?? []);
						}
					})
					.catch((error) => {
						console.warn(`[brainstorm] dev: content reseed failed: ${(error as Error).message}`);
					});

				// Register the
				// task/plan PropertyDefs + dictionaries into the vault properties
				// store (shell-side — the CLI can't write the properties YDoc).
				// Idempotent; throwaway dev hook. Folds into a collection schema
				// once the single-object-space remodel lands.
				void import("./dev/plan-properties")
					.then(({ seedPlanProperties }) => seedPlanProperties(session))
					.then((result) => {
						if (result.ok) {
							console.log(
								`[brainstorm] dev: plan properties seeded (${result.properties} props, ${result.dictionaries} dicts)`,
							);
						} else {
							console.warn(`[brainstorm] dev: plan properties seed: ${result.reason}`);
						}
					})
					.catch((error) => {
						console.warn(`[brainstorm] dev: plan properties seed failed: ${(error as Error).message}`);
					});

				// Contacts (brainstorm/Person/v1) property catalog. Same
				// throwaway-dev-hook posture as plan properties; separate so
				// Task/plan and Person semantics stay in distinct catalogs.
				void import("./dev/contact-properties")
					.then(({ seedContactProperties }) => seedContactProperties(session))
					.then((result) => {
						if (result.ok) {
							console.log(`[brainstorm] dev: contact properties seeded (${result.properties} props)`);
						} else {
							console.warn(`[brainstorm] dev: contact properties seed: ${result.reason}`);
						}
					})
					.catch((error) => {
						console.warn(`[brainstorm] dev: contact properties seed failed: ${(error as Error).message}`);
					});

				// NOTE: no demo-object / onboarding seed. A new vault is
				// empty by design — the project release roadmap is seeded
				// explicitly via `tools/mcp-server/src/seed/seed-cli.ts
				// --vault <path>`. Only the (idempotent, invisible) property
				// catalogs above are registered, because the CLI can't write
				// the shell-owned properties YDoc and the seeded roadmap
				// needs them to render status/priority chips.
			}
		};
		onActiveVaultSessionChanged(() => {
			void runDevSeed();
		});
		if (getActiveVaultSession()) void runDevSeed();
	} else if (!isDev) {
		// Packaged-mode bootstrap installer (doc 59 / 14.30): install the
		// curated offline bootstrap set (BOOTSTRAP_APPS) from the cached
		// bundles under process.resourcesPath/apps (placed there by
		// electron-builder's extraResources). No vite spawn, no source build,
		// read-only resource tree. The remaining first-party apps are
		// catalog-only (installed on demand once the catalog client lands,
		// 14.31+). Mirrors the dev-seeder's once-per-vault guard +
		// session-change hook shape so the install fires once per vault even
		// when the vault is opened after boot. No BRAINSTORM_AUTO_SEED env-var:
		// in a packaged shell the bootstrap install is non-negotiable — without
		// it the user has no apps.
		bootStage("auto-seed-started");
		const packagedAppsRoot = join(process.resourcesPath, "apps");
		const bootstrappedVaults = new Set<string>();
		let firstBootstrapDoneLogged = false;
		const runPackagedBootstrap = async (): Promise<void> => {
			const session = getActiveVaultSession();
			if (!session || bootstrappedVaults.has(session.vaultPath)) return;
			bootstrappedVaults.add(session.vaultPath);
			const [{ bootstrapApps }, { AppInstaller }, { BOOTSTRAP_APPS }, { getActiveShortcutRegistry }] =
				await Promise.all([
					import("./apps/seed-packaged-apps"),
					import("./apps/installer"),
					import("./apps/first-party"),
					import("./shortcuts/active-registry"),
				]);
			try {
				const registry = await session.dataStores.open("registry");
				const ledger = await session.capabilityLedger();
				const shortcutRegistry = getActiveShortcutRegistry();
				const installer = new AppInstaller(
					session.vaultPath,
					registry,
					ledger,
					shortcutRegistry ?? undefined,
				);
				const appsRepo = new AppsRepository(registry);
				const dashboard = await session.dashboardStore();
				const result = await bootstrapApps({
					appsRoot: packagedAppsRoot,
					appsRepo,
					installer,
					dashboard,
					apps: BOOTSTRAP_APPS,
				});
				console.log(
					`[brainstorm] packaged: bootstrap installed ${result.installed.length}, upgraded ${result.upgraded.length}, skipped ${result.skipped.length}, ${result.errors.length} errors`,
				);
				for (const error of result.errors) {
					console.warn(`[brainstorm] packaged: bootstrap error: ${error}`);
				}
			} catch (error) {
				console.warn(`[brainstorm] packaged: bootstrap failed: ${(error as Error).message}`);
			} finally {
				if (!firstBootstrapDoneLogged) {
					firstBootstrapDoneLogged = true;
					bootStage("auto-seed-done");
				}
			}
		};
		onActiveVaultSessionChanged(() => {
			void runPackagedBootstrap();
		});
		if (getActiveVaultSession()) void runPackagedBootstrap();
	} else {
		bootStage("auto-seed-skipped");
	}

	app.on("activate", () => {
		// Dock-icon activation returns you to what you were last doing. The
		// dashboard and every app window stamp their last-focus on one shared
		// clock, so we surface whichever was focused most recently — NOT
		// whichever happens to be `isVisible()`. (A shown-but-backgrounded
		// dashboard, sitting behind an app window or another OS app, still
		// reports visible on macOS — that old gate wrongly resurfaced the
		// dashboard even when you left off inside an app window.)
		const windowIndex = launchSetup.getWindowIndexSync();
		const mostRecentApp = windowIndex?.list()[0] ?? null;
		const decision = resolveDockActivation({
			dashboardWindow,
			dashboardLastFocusedAt: launchSetup.getDashboardLastFocusedAt(),
			mostRecentApp,
		});
		// `focus` returns false if the window died between snapshot and call —
		// fall through to the dashboard so the dock click never no-ops.
		if (decision.action === DockActivation.FocusApp && windowIndex?.focus(decision.windowId)) {
			return;
		}
		// Reopen the dashboard whenever it's gone — keyed off the dashboard
		// window's own lifecycle, NOT `getAllWindows().length`. Parked (hidden,
		// warm-kept) app windows are still live `BrowserWindow`s, so the count
		// stays non-zero after the user closes the dashboard while an app is
		// parked; gating on it left the app running with only unreachable hidden
		// windows and no way back to the dashboard.
		if (decision.action === DockActivation.CreateDashboard) {
			dashboardWindow = createDashboardWindow();
			registerAndTrack(dashboardWindow);
			shortcuts.attach(dashboardWindow.webContents);
			wireDashboardLinkRouting(dashboardWindow.webContents);
		} else if (dashboardWindow) {
			dashboardWindow.show();
			dashboardWindow.focus();
		}
	});
});

app.on("window-all-closed", () => {
	if (!isMac) {
		app.quit();
	}
});

app.on("will-quit", () => {
	workers?.dispose();
	workers = null;
	setWorkersHandle(null);
});
