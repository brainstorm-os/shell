import {
	LiveRegion,
	RegionId,
	getEscapeStack,
	installEscapeHandler,
	useRegionNavigation,
} from "@brainstorm/sdk/a11y";
import { AnimatePresence, motion } from "framer-motion";
import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardIcon, InstalledApp, VaultEntry, VaultSessionMeta } from "../preload";
import {
	AppearanceMode,
	AppearanceSlot,
	effectiveSlotFor,
	nextModeForToggle,
} from "../shared/appearance";
import {
	type ClockPrefs,
	DEFAULT_CHROME,
	DEFAULT_LANGUAGE,
	HeaderControlId,
	HourCyclePref,
	type NotificationRecord,
	effectiveHourCycle,
	hourCycleToHour12,
	isHeaderControlVisible,
} from "../shared/shell-prefs";
import type { MonitorSummary, TilePreset, WindowEntry } from "../shared/window-types";
import { onSystemPreferenceChange, systemPrefersDark } from "./dashboard/appearance-watcher";
import "./dashboard.css";
import { AppGrid } from "./dashboard/app-grid";
import { firstFreeCell } from "./dashboard/grid";
import { DashboardIconsLayer } from "./dashboard/icons-layer";
import { openAddWidgetMenu } from "./dashboard/widget-add-menu";
import { DashboardWidgetsLayer } from "./dashboard/widgets-layer";
import "./dashboard/icons-layer.css";
import { ActivityChip } from "./dashboard/activity-chip";
import "./dashboard/activity-chip.css";
import { SyncStatusChip } from "./dashboard/sync-status-chip";
import "./dashboard/sync-status-chip.css";
import { NotificationBell } from "./dashboard/notification-center";
import { useDashboard } from "./dashboard/use-dashboard";
import { VaultInfoPopover } from "./dashboard/vault-info-popover";
import "./dashboard/vault-info-popover.css";
import { VaultRecoveryPromptHost } from "./dashboard/vault-recovery-prompt";
import "./dashboard/vault-recovery-prompt.css";
import { VaultSwitcherPopover } from "./dashboard/vault-switcher-popover";
import "./dashboard/vault-switcher-popover.css";
import { WallpaperLayer, usePersistedWallpaper } from "./dashboard/wallpaper-layer";
import { WindowStrip } from "./dashboard/window-strip";
import "./dashboard/window-strip.css";
import { WindowSwitcher } from "./dashboard/window-switcher";
import "./dashboard/window-switcher.css";
import { t } from "./i18n/t";
import { Launcher } from "./launcher/launcher";
// Bin / Cheatsheet / Settings / WhatsNewPopover are conditional overlays —
// lazy-loading keeps them out of the dashboard entry chunk. Each lands in its
// own chunk; the Settings chunk includes most of the *Section components
// (Devices and Sync are split a second level deeper in settings/settings.tsx).
// Named import thunks so the idle-prefetch (warmOverlayChunks) and `lazy()` share
// the exact same dynamic-import specifier — Vite splits one chunk per overlay and
// dedupes the fetch. Warming them after first paint keeps the bundle-split benefit
// (out of the dashboard entry parse) while making the first open instant: without
// it, clicking an overlay fetches + parses the chunk on the critical path and the
// `Suspense fallback={null}` shows nothing until it lands (feels like a dead click).
const importBin = () => import("./bin/bin");
const importCheatsheet = () => import("./cheatsheet/cheatsheet");
const importHelp = () => import("./help/help");
const Bin = lazy(() => importBin().then((m) => ({ default: m.Bin })));
const Cheatsheet = lazy(() => importCheatsheet().then((m) => ({ default: m.Cheatsheet })));
const Help = lazy(() => importHelp().then((m) => ({ default: m.Help })));
import { ShellSurfaceId } from "./dashboard/shell-surfaces";
import { deriveHelpRoute } from "./help/derive-help-route";
import { formatOpenExplainer } from "./intents/open-explainer";
// Marketplace is a privileged overlay only reachable from the launcher / Cmd+Shift+M;
// lazy-loading it keeps ~13 KB raw (~3-4 KB gz) out of the dashboard entry chunk.
const importMarketplace = () => import("./marketplace/marketplace");
const Marketplace = lazy(() => importMarketplace().then((m) => ({ default: m.Marketplace })));
import { CapabilityPromptHost } from "./settings/capability-prompt";
import "./settings/capability-prompt.css";
const importWhatsNew = () => import("./dashboard/whats-new-popover");
const WhatsNewPopover = lazy(() => importWhatsNew().then((m) => ({ default: m.WhatsNewPopover })));
import { LockScreen, useVaultLock } from "./lock-screen";
import { OpenWithPromptHost } from "./settings/open-with-prompt";
import { OsHandoffPromptHost } from "./settings/os-handoff-prompt";
import { SettingsSection } from "./settings/sections";
import { consumeMigrationImport } from "./welcome/migration-intent";
const importSettings = () => import("./settings/settings");
const Settings = lazy(() => importSettings().then((m) => ({ default: m.Settings })));

/** Warm every code-split overlay chunk while the renderer is idle, so the first
 *  open of any overlay is instant. Each thunk is the same specifier `lazy()` uses,
 *  so this just primes Vite's module cache — opening later resolves synchronously. */
function warmOverlayChunks(): void {
	for (const load of [
		importBin,
		importCheatsheet,
		importHelp,
		importMarketplace,
		importWhatsNew,
		importSettings,
	]) {
		void load().catch(() => {});
	}
}
import { track } from "@brainstorm/sdk/analytics";
import { launchApp, trackAppLaunch } from "./analytics/track-app-launch";
import { ConfirmVariant, confirm } from "./ui/confirm";
import { Icon, IconName } from "./ui/icon";
import { IconButton } from "./ui/icon-button";
import { Spinner } from "./ui/spinner";
import { ToastKind, pushToast } from "./ui/toasts";
import { useVault } from "./vault-context";

export function Dashboard() {
	const { current, allVaults, activate, refresh } = useVault();
	const [session, setSession] = useState<VaultSessionMeta | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection | undefined>(
		undefined,
	);
	const [marketplaceOpen, setMarketplaceOpen] = useState(false);
	const [binOpen, setBinOpen] = useState(false);
	const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const [helpInitialTopic, setHelpInitialTopic] = useState<string | null>(null);
	const [whatsNewSignal, setWhatsNewSignal] = useState(0);
	const [appGridOpen, setAppGridOpen] = useState(false);
	const [vaultInfoOpen, setVaultInfoOpen] = useState(false);
	const [notificationsOpen, setNotificationsOpen] = useState(false);
	const [vaultSwitcherOpen, setVaultSwitcherOpen] = useState(false);
	const [recoveredVaults, setRecoveredVaults] = useState<VaultEntry[]>([]);
	const [launcherOpen, setLauncherOpen] = useState(false);

	useEffect(() => {
		if (settingsOpen) track("Settings Opened", { section: settingsInitialSection ?? "default" });
	}, [settingsOpen, settingsInitialSection]);
	// 9.8.9 — a `ui.openSearch` handoff pre-fills the palette; null = open clean.
	const [launcherQuery, setLauncherQuery] = useState<string | null>(null);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	// Bumped when `shell/switch-window` fires while the switcher is already
	// open — classic Alt+Tab: repeated presses step the selection. A ref
	// mirrors `switcherOpen` so the wire-once shell-action handler sees the
	// live value.
	const [switcherCycle, setSwitcherCycle] = useState(0);
	// Reverse-cycle (Ctrl+Shift+Tab) and release-to-commit (let go of Ctrl)
	// signals — each bump steps backward / commits the highlighted window.
	const [switcherCyclePrev, setSwitcherCyclePrev] = useState(0);
	const [switcherCommit, setSwitcherCommit] = useState(0);
	// True when opened via the reverse chord, so the switcher highlights the
	// most-distant window first instead of the second-MRU one.
	const [switcherReverse, setSwitcherReverse] = useState(false);
	const switcherOpenRef = useRef(false);
	switcherOpenRef.current = switcherOpen;
	const [windows, setWindows] = useState<WindowEntry[]>([]);
	const [monitors, setMonitors] = useState<MonitorSummary[]>([]);
	const [fullscreen, setFullscreen] = useState(false);
	const snapshot = useDashboard();
	const wallpaper = usePersistedWallpaper(snapshot?.wallpaper);
	const locked = useVaultLock();

	// Prefetch the code-split overlay chunks once the dashboard is idle so the
	// first open of Settings/Marketplace/Bin/Help/Cheatsheet is instant rather
	// than waiting on a chunk fetch+parse on the click (Suspense fallback is null).
	useEffect(() => {
		const ric = window.requestIdleCallback;
		if (ric) {
			const id = ric(warmOverlayChunks);
			return () => window.cancelIdleCallback?.(id);
		}
		const id = window.setTimeout(warmOverlayChunks, 1500);
		return () => window.clearTimeout(id);
	}, []);

	// 12.8 — when the vault switcher opens, scan disk for vaults the registry
	// has forgotten so they can be offered as an "Add back" surface. Guarded:
	// the bridge field is absent on a stale preload (dev HMR), per
	// `feedback_preload_bridge_stale_in_dev`.
	useEffect(() => {
		if (!vaultSwitcherOpen) {
			setRecoveredVaults([]);
			return;
		}
		const scan = window.brainstorm.vaults.scanRecovered;
		if (typeof scan !== "function") return;
		let cancelled = false;
		void scan()
			.then((found) => {
				if (!cancelled) setRecoveredVaults(found);
			})
			.catch((error) => {
				console.error("[brainstorm] scan-recovered failed:", error);
			});
		return () => {
			cancelled = true;
		};
	}, [vaultSwitcherOpen]);

	// KBN-S-dashboard: F6 / Shift+F6 cycle focus between the dashboard's regions
	// (the icon grid and the bottom window-strip / tray) so a keyboard user can
	// jump between them without tabbing through every tile — mirrors the Settings
	// overlay's region nav (first dashboard adopter).
	const gridRegionRef = useRef<HTMLElement | null>(null);
	const trayRegionRef = useRef<HTMLElement | null>(null);
	const [activeRegion, setActiveRegion] = useState<string>(RegionId.DashboardGrid);
	const dashboardRegions = useMemo(
		() => [
			{ id: RegionId.DashboardGrid, label: t("shell.dashboard.iconGrid"), ref: gridRegionRef },
			{ id: RegionId.SystemTray, label: t("shell.dashboard.region.tray"), ref: trayRegionRef },
		],
		[],
	);
	useRegionNavigation({
		regions: dashboardRegions,
		activeRegionId: activeRegion,
		onActiveRegionIdChange: setActiveRegion,
	});

	// KBN-2 — one document-level Escape handler drains the renderer-wide
	// LIFO of overlay closers. Per OQ-KBN-3 resolution: renderer-only, per-
	// window scope, no main-process round-trip. Empty-stack Escape falls
	// through to the chord registry's existing `Escape` bindings (the
	// chord-registry path is how an app receives `app/escape` once an app
	// renderer is focused).
	useEffect(() => installEscapeHandler(getEscapeStack()), []);

	useEffect(() => {
		let cancelled = false;
		void window.brainstorm.windowState.isFullscreen().then((value) => {
			if (!cancelled) setFullscreen(value);
		});
		const off = window.brainstorm.windowState.onFullscreenChanged((value) => {
			setFullscreen(value);
		});
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	useEffect(() => {
		if (!current) {
			setSession(null);
			return;
		}
		let cancelled = false;
		void window.brainstorm.vaults.session().then((meta) => {
			if (!cancelled) setSession(meta);
		});
		return () => {
			cancelled = true;
		};
	}, [current]);

	const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());

	useEffect(() => onSystemPreferenceChange(setPrefersDark), []);

	const toggleAppearance = useCallback(() => {
		const mode = snapshot?.appearance?.mode;
		if (!mode) {
			console.warn(
				"[brainstorm] appearance.toggle: dashboard snapshot has no appearance yet — restart the shell?",
			);
			return;
		}
		const setter = window.brainstorm?.dashboard?.setAppearanceMode;
		if (typeof setter !== "function") {
			console.error(
				"[brainstorm] appearance.toggle: window.brainstorm.dashboard.setAppearanceMode is not exposed — the preload is stale; a full shell restart (not HMR) is required.",
			);
			return;
		}
		const next = nextModeForToggle(mode, systemPrefersDark());
		void setter(next);
	}, [snapshot]);

	// Help-2 — refs mirror the focused-surface state so the shellActions
	// listener's stable closure can read the *current* values without
	// re-registering on every state change. Pure rendering state stays
	// in `useState`; these are read-only mirrors for the deriver.
	const helpRouteStateRef = useRef({
		settingsOpen: false,
		settingsSection: undefined as SettingsSection | undefined,
		windows: [] as WindowEntry[],
	});
	useEffect(() => {
		helpRouteStateRef.current = { settingsOpen, settingsSection: settingsInitialSection, windows };
	}, [settingsOpen, settingsInitialSection, windows]);

	// IE-3: a first-launch "Migrating from…" create hands us a one-shot to open
	// Settings → Backup & Migration the moment this dashboard mounts.
	useEffect(() => {
		if (consumeMigrationImport()) {
			setSettingsInitialSection(SettingsSection.BackupMigration);
			setSettingsOpen(true);
		}
	}, []);

	useEffect(() => {
		return window.brainstorm.shellActions.on(({ action, topicId, query }) => {
			handleShellAction(action, query, {
				openSettings: () => setSettingsOpen(true),
				openMarketplace: () => setMarketplaceOpen(true),
				openBin: () => setBinOpen(true),
				openCheatsheet: () => setCheatsheetOpen(true),
				openHelp: (id?: string | null) => {
					const explicit = id ?? topicId ?? null;
					if (explicit) {
						setHelpInitialTopic(explicit);
						setHelpOpen(true);
						return;
					}
					// Help-2 — contextual deep-link. No explicit topic ⇒
					// derive the route from the current focused surface
					// and ask main to resolve it to a topic id. Open the
					// overlay either way; null falls back to home.
					const route = deriveHelpRoute(helpRouteStateRef.current);
					const bridge = window.brainstorm.help;
					if (!bridge?.resolveTopic) {
						setHelpInitialTopic(null);
						setHelpOpen(true);
						return;
					}
					void bridge.resolveTopic(route).then(
						(resolved) => {
							setHelpInitialTopic(resolved);
							setHelpOpen(true);
						},
						() => {
							setHelpInitialTopic(null);
							setHelpOpen(true);
						},
					);
				},
				openLauncher: (initialQuery?: string) => {
					setLauncherQuery(initialQuery ?? null);
					setLauncherOpen(true);
				},
				openAppGrid: () => setAppGridOpen(true),
				openSwitcher: () => {
					if (switcherOpenRef.current) setSwitcherCycle((c) => c + 1);
					else {
						setSwitcherReverse(false);
						setSwitcherOpen(true);
					}
				},
				openSwitcherPrev: () => {
					if (switcherOpenRef.current) setSwitcherCyclePrev((c) => c + 1);
					else {
						setSwitcherReverse(true);
						setSwitcherOpen(true);
					}
				},
				commitSwitcher: () => {
					if (switcherOpenRef.current) setSwitcherCommit((c) => c + 1);
				},
				openVaultSwitcher: () => setVaultSwitcherOpen(true),
				refreshVault: refresh,
				toggleAppearance,
			});
		});
	}, [refresh, toggleAppearance]);

	useEffect(() => {
		let cancelled = false;
		void window.brainstorm.windows.list().then((list) => {
			if (!cancelled) setWindows(list);
		});
		void window.brainstorm.windows.listMonitors().then((list) => {
			if (!cancelled) setMonitors(list);
		});
		const off = window.brainstorm.windows.onChanged((list) => {
			setWindows(list);
		});
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	const focusWindow = useCallback((id: string) => {
		void window.brainstorm.windows.focus(id);
	}, []);
	const closeWindow = useCallback((id: string) => {
		void window.brainstorm.windows.close(id);
	}, []);
	const minimizeWindow = useCallback((id: string) => {
		void window.brainstorm.windows.minimize(id);
	}, []);
	const tileWindow = useCallback((id: string, preset: TilePreset, monitorId?: string) => {
		void window.brainstorm.windows.tile(id, preset, monitorId);
	}, []);
	const moveWindowToMonitor = useCallback((id: string, monitorId: string) => {
		void window.brainstorm.windows.moveToMonitor(id, monitorId);
	}, []);
	const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);

	const closeSettings = useCallback(() => {
		setSettingsOpen(false);
		setSettingsInitialSection(undefined);
	}, []);
	const closeMarketplace = useCallback(() => setMarketplaceOpen(false), []);
	const closeBin = useCallback(() => setBinOpen(false), []);
	const closeCheatsheet = useCallback(() => setCheatsheetOpen(false), []);
	const closeHelp = useCallback(() => {
		setHelpOpen(false);
		setHelpInitialTopic(null);
	}, []);
	const openHelpAt = useCallback((topicId?: string | null) => {
		setHelpInitialTopic(topicId ?? null);
		setHelpOpen(true);
	}, []);

	const moveIcon = useCallback((id: string, x: number, y: number) => {
		void window.brainstorm.dashboard.moveIcon(id, x, y);
	}, []);

	const markIconGridMigrated = useCallback(() => {
		// An older preload (renderer HMR'd ahead of a preload reload in dev) may
		// not expose this method yet — degrade to no-op rather than crash the
		// dashboard; a full shell restart brings the preload up to date.
		void window.brainstorm.dashboard.markIconGridMigrated?.();
	}, []);

	const activateAppIcon = useCallback((icon: DashboardIcon) => {
		void (async () => {
			try {
				trackAppLaunch(icon.target, "dashboard-icon");
				await window.brainstorm.apps.launch(icon.target);
			} catch (error) {
				const message = (error as Error).message ?? String(error);
				// LaunchOrchestrator wraps an ENOENT manifest read as
				// `BundleMissing` with this stable phrase in the message — see
				// main/apps/launch-orchestrator.ts. Offer the user a one-click
				// path to clean up the orphan.
				if (message.includes("bundle is gone from disk")) {
					const accepted = await confirm({
						title: t("shell.dashboard.orphanApp.title", { name: icon.label }),
						body: t("shell.dashboard.orphanApp.body", { name: icon.label }),
						confirmLabel: t("shell.dashboard.iconMenu.uninstall"),
						confirmVariant: ConfirmVariant.Destructive,
					});
					if (!accepted) return;
					const result = await window.brainstorm.apps.uninstall(icon.target);
					if (result.ok) {
						pushToast({
							kind: ToastKind.Success,
							title: t("shell.dashboard.iconMenu.uninstallToast.title"),
							body: t("shell.dashboard.iconMenu.uninstallToast.body", { name: icon.label }),
						});
					} else {
						pushToast({
							kind: ToastKind.Error,
							title: t("shell.dashboard.iconMenu.uninstallToast.failTitle"),
							body: result.reason ?? "Unknown error",
						});
					}
					return;
				}
				pushToast({
					kind: ToastKind.Error,
					title: t("shell.dashboard.launchFailed.title", { name: icon.label }),
					body: message,
				});
			}
		})();
	}, []);

	const activateIcon = useCallback(
		(id: string, icon: DashboardIcon) => {
			if (icon.kind === "app") {
				activateAppIcon(icon);
				return;
			}
			if (icon.kind === "shell-surface") {
				// 9.19.2 — a pinned shell surface opens its overlay (the Bin
				// today). Not vault data, so no intent.open / resolver path.
				if (icon.target === ShellSurfaceId.Bin) setBinOpen(true);
				return;
			}
			// 7.13 — entity / view pin. Same one open path the launcher row
			// uses: dispatch `intent.open` (the IntentsBus focuses an
			// existing window for the opener rather than spawning a
			// duplicate — OQ-DASH-1). A dangling target is a tombstone
			// (no-op activation; "Remove pin" via the context menu); fall
			// back to launching the resolved opener app fresh only when no
			// handler took the intent.
			const resolution = snapshot?.pins?.[id];
			if (resolution?.missing) return;
			void window.brainstorm.intents
				.dispatch({ verb: "open", payload: { entityId: icon.target } })
				.then((result) => {
					pushExplainerToast(result);
					if (result.handled) return;
					if (result.rung !== undefined) {
						// Explainer already surfaced the *why*; don't double-toast.
						return;
					}
					const appId = resolution?.appId;
					if (appId) {
						launchApp(appId, "dashboard-pin");
						return;
					}
					pushToast({
						kind: ToastKind.Error,
						title: t("shell.dashboard.openPin.failTitle", { name: icon.label }),
						body: t("shell.dashboard.openPin.noHandler"),
					});
				})
				.catch((error: unknown) => {
					console.warn("[brainstorm] dashboard: pin intent.open failed:", error);
					const appId = resolution?.appId;
					if (appId) launchApp(appId, "dashboard-pin-fallback");
				});
		},
		[snapshot, activateAppIcon],
	);

	const onPinApp = useCallback(
		(app: InstalledApp) => {
			const id = `icon_${app.id}_${Date.now()}`;
			const occupied = Object.values(snapshot?.icons ?? {}).map(({ x, y }) => ({
				col: Math.max(0, Math.floor(x)),
				row: Math.max(0, Math.floor(y)),
			}));
			const cell = firstFreeCell(occupied);
			void window.brainstorm.dashboard.upsertIcon(id, {
				x: cell.col,
				y: cell.row,
				kind: "app",
				target: app.id,
				label: app.name,
			});
		},
		[snapshot],
	);

	const onUnpinApp = useCallback(
		(appId: string) => {
			const entry = Object.entries(snapshot?.icons ?? {}).find(
				([, icon]) => icon.kind === "app" && icon.target === appId,
			);
			if (entry) void window.brainstorm.dashboard.removeIcon(entry[0]);
		},
		[snapshot],
	);

	// Lock state not yet known (first `lockStatus()` round-trip in flight): show a
	// small loader rather than flash the dashboard icons or vault picker. A vault
	// that boots locked (a PIN is set) must never paint its content for a frame
	// first. The wallpaper still paints behind the spinner — it reads from the
	// synchronous localStorage cache (`usePersistedWallpaper`), so there's no
	// blank frame and it carries seamlessly into the dashboard once lock state
	// resolves (same `WallpaperLayer`, no re-fade).
	if (locked === undefined)
		return (
			<div className="dashboard__boot">
				<WallpaperLayer wallpaper={wallpaper} />
				<div className="dashboard__boot-loader">
					<Spinner size={32} />
				</div>
			</div>
		);

	// A locked vault renders ONLY the lock screen — no dashboard content tree, so
	// there is nothing behind it to reveal by deleting a node in the inspector.
	// (Checked before `current` because a keyring hard-lock disposes the session,
	// which would otherwise fall through to the vault picker.)
	if (locked) return <LockScreen />;

	if (!current)
		return (
			<>
				<CapabilityPromptHost />
				<OsHandoffPromptHost />
				<OpenWithPromptHost />
			</>
		);

	const icons = snapshot?.icons ?? {};
	const widgets = snapshot?.widgets ?? {};
	const pins = snapshot?.pins ?? {};
	const pinnedAppIds = new Set(
		Object.values(icons)
			.filter((icon) => icon.kind === "app")
			.map((icon) => icon.target),
	);
	const hasIcons = Object.keys(icons).length > 0;
	const iconGridMigrated = snapshot?.iconGridMigrated ?? false;

	// Track D — header chrome. Default visible (snapshot may be null on first
	// paint). The clock additionally honours its own show toggle.
	const chrome = snapshot?.chrome ?? DEFAULT_CHROME;
	const showControl = (id: HeaderControlId) => isHeaderControlVisible(chrome, id);
	const regionalHourCycle = snapshot?.regional.hourCycle ?? HourCyclePref.Auto;
	const uiLanguage = snapshot?.locale.language ?? DEFAULT_LANGUAGE;
	const unreadNotifications = (snapshot?.notificationHistory ?? []).filter((n) => !n.read).length;

	return (
		<main
			className="dashboard"
			data-bs-region="dashboard"
			data-platform={window.brainstorm.platform}
			data-fullscreen={fullscreen ? "true" : "false"}
		>
			<WallpaperLayer wallpaper={wallpaper} />

			<header className="dashboard__header glass" data-bs-region="dashboard-header">
				<div className="dashboard__header-left" data-bs-region="dashboard-header-left" />
				<div className="dashboard__header-right" data-bs-region="dashboard-header-right">
					{showControl(HeaderControlId.Clock) && chrome.clock.show && (
						<ClockReadout
							prefs={chrome.clock}
							regionalHourCycle={regionalHourCycle}
							locale={uiLanguage}
						/>
					)}

					<ActivityChip />

					{showControl(HeaderControlId.SyncStatus) && <SyncStatusChip />}

					{window.brainstorm?.dev?.isDev && (
						<>
							<button
								type="button"
								className="dashboard__dev-seed"
								onClick={() => {
									const devApi = window.brainstorm.dev;
									if (!devApi) return;
									void devApi.seedDemoApps().then((result) => {
										pushToast({
											kind: result.errors.length > 0 ? ToastKind.Warning : ToastKind.Success,
											title: t("shell.dashboard.dev.seedToast.title"),
											body: t("shell.dashboard.dev.seedToast.body", {
												installed: result.installed,
												skipped: result.skipped,
												pinned: result.pinned,
											}),
										});
									});
								}}
							>
								{t("shell.dashboard.dev.seedDemoApps")}
							</button>
							<button
								type="button"
								className="dashboard__dev-seed"
								onClick={() => {
									const devApi = window.brainstorm.dev;
									if (!devApi) return;
									void devApi.reseedVault().then((result) => {
										if (!result.ok) {
											pushToast({
												kind: ToastKind.Warning,
												title: t("shell.dashboard.dev.reseedToast.title"),
												body: t("shell.dashboard.dev.reseedToast.errorBody", {
													reason: result.reason,
												}),
											});
											return;
										}
										pushToast({
											kind: ToastKind.Success,
											title: t("shell.dashboard.dev.reseedToast.title"),
											body: t("shell.dashboard.dev.reseedToast.body", {
												created: result.backfill.entitiesCreated,
												healed: result.backfill.entitiesHealed,
												resynced: result.backfill.entitiesResynced,
												removed: result.backfill.entitiesRemoved,
												links: result.backfill.linksWritten,
											}),
										});
									});
								}}
							>
								{t("shell.dashboard.dev.reseedVault")}
							</button>
						</>
					)}
					{showControl(HeaderControlId.Notifications) && (
						<NotificationBell
							unread={unreadNotifications}
							open={notificationsOpen}
							onToggle={() => setNotificationsOpen((v) => !v)}
							onClose={() => setNotificationsOpen(false)}
							history={snapshot?.notificationHistory ?? []}
							locale={uiLanguage}
						/>
					)}
					{showControl(HeaderControlId.Appearance) && (
						<AppearanceToggleButton
							mode={snapshot?.appearance?.mode ?? AppearanceMode.Auto}
							prefersDark={prefersDark}
							onToggle={toggleAppearance}
						/>
					)}
					{showControl(HeaderControlId.AddWidget) && (
						<IconButton
							icon={IconName.Plus}
							label={t("shell.widgets.add.label")}
							onClick={(e) => void openAddWidgetMenu(e.currentTarget, snapshot?.widgets ?? {})}
						/>
					)}
					{showControl(HeaderControlId.Search) && (
						<IconButton
							icon={IconName.Search}
							label={t("shell.launcher.openLabel")}
							shortcutId="shell/launcher"
							onClick={() => setLauncherOpen(true)}
						/>
					)}
					{showControl(HeaderControlId.Marketplace) && (
						<IconButton
							icon={IconName.Storefront}
							label={t("shell.marketplace.openLabel")}
							shortcutId="shell/marketplace"
							onClick={() => setMarketplaceOpen(true)}
						/>
					)}
					{showControl(HeaderControlId.Bin) && (
						<IconButton
							icon={IconName.Trash}
							label={t("shell.bin.openLabel")}
							shortcutId="shell/bin"
							onClick={() => setBinOpen(true)}
						/>
					)}
					{showControl(HeaderControlId.Cheatsheet) && (
						<IconButton
							icon={IconName.Keyboard}
							label={t("shell.cheatsheet.openLabel")}
							shortcutId="shell/cheatsheet"
							onClick={() => setCheatsheetOpen(true)}
						/>
					)}
					{showControl(HeaderControlId.Help) && (
						<IconButton
							icon={IconName.Question}
							label={t("shell.help.openLabel")}
							shortcutId="shell/help"
							onClick={() => openHelpAt(null)}
						/>
					)}
					{showControl(HeaderControlId.VaultInfo) && (
						<IconButton
							icon={IconName.Info}
							label={t("shell.dashboard.vaultInfo.label")}
							onClick={() => setVaultInfoOpen(true)}
						/>
					)}
					{showControl(HeaderControlId.Settings) && (
						<IconButton
							icon={IconName.Settings}
							label={t("shell.settings.title")}
							shortcutId="shell/settings"
							onClick={() => setSettingsOpen(true)}
						/>
					)}
				</div>
			</header>

			<section
				className="dashboard__body"
				data-bs-region="dashboard-body"
				aria-label={t("shell.dashboard.body")}
				ref={gridRegionRef}
				tabIndex={-1}
			>
				{hasIcons && (
					<DashboardIconsLayer
						icons={icons}
						pins={pins}
						onMoveIcon={moveIcon}
						onActivate={activateIcon}
						gridMigrated={iconGridMigrated}
						onGridMigrated={markIconGridMigrated}
					/>
				)}
				<DashboardWidgetsLayer widgets={widgets} />
			</section>

			<footer
				className="dashboard__footer glass--subtle"
				data-bs-region="dashboard-tray"
				ref={trayRegionRef}
				tabIndex={-1}
			>
				<button
					type="button"
					className="dashboard__start"
					onClick={() => setAppGridOpen(true)}
					aria-label={t("shell.appGrid.openAria")}
					data-bs-tooltip={t("shell.appGrid.openAria")}
				>
					<Icon name={IconName.App} />
					<span className="dashboard__start-label">{t("shell.appGrid.openLabel")}</span>
				</button>
				<div className="dashboard__start-divider" aria-hidden="true" />
				<WindowStrip
					entries={windows}
					monitors={monitors}
					onFocus={focusWindow}
					onClose={closeWindow}
					onMinimize={minimizeWindow}
					onTile={tileWindow}
					onMoveToMonitor={moveWindowToMonitor}
				/>
			</footer>

			<AnimatePresence>
				{settingsOpen && (
					<Suspense key="settings" fallback={null}>
						<Settings
							onClose={closeSettings}
							{...(settingsInitialSection !== undefined && {
								initialSection: settingsInitialSection,
							})}
							onOpenBin={() => {
								// One overlay at a time: the Bin replaces Settings
								// rather than stacking over it (9.8.8).
								closeSettings();
								setBinOpen(true);
							}}
						/>
					</Suspense>
				)}
			</AnimatePresence>
			<AnimatePresence>
				{marketplaceOpen && (
					<Suspense key="marketplace" fallback={null}>
						<Marketplace onClose={closeMarketplace} />
					</Suspense>
				)}
			</AnimatePresence>
			<AnimatePresence>
				{binOpen && (
					<Suspense key="bin" fallback={null}>
						<Bin onClose={closeBin} />
					</Suspense>
				)}
			</AnimatePresence>
			<AnimatePresence>
				{cheatsheetOpen && (
					<Suspense key="cheatsheet" fallback={null}>
						<Cheatsheet onClose={closeCheatsheet} />
					</Suspense>
				)}
			</AnimatePresence>
			<AnimatePresence>
				{helpOpen && (
					<Suspense key="help" fallback={null}>
						<Help
							onClose={closeHelp}
							initialTopicId={helpInitialTopic}
							onOpenWhatsNew={() => setWhatsNewSignal((n) => n + 1)}
						/>
					</Suspense>
				)}
			</AnimatePresence>
			<AnimatePresence>
				<AppGrid
					open={appGridOpen}
					onClose={() => setAppGridOpen(false)}
					onLaunch={(appId) => launchApp(appId, "app-grid")}
					onPin={onPinApp}
					onUnpin={onUnpinApp}
					pinnedAppIds={pinnedAppIds}
				/>
			</AnimatePresence>
			<AnimatePresence>
				{vaultInfoOpen && (
					<VaultInfoPopover
						key="vault-info"
						vault={current}
						session={session}
						version={window.brainstorm.version}
						onClose={() => setVaultInfoOpen(false)}
					/>
				)}
			</AnimatePresence>
			<AnimatePresence>
				{vaultSwitcherOpen && (
					<VaultSwitcherPopover
						key="vault-switcher"
						current={current}
						vaults={allVaults}
						recovered={recoveredVaults}
						onActivate={(id) => {
							void activate(id);
						}}
						onAddBack={(path) => {
							void (async () => {
								try {
									await window.brainstorm.vaults.openByPath(path);
									await refresh();
								} catch (error) {
									console.error("[brainstorm] add-back vault failed:", error);
								}
							})();
							setVaultSwitcherOpen(false);
						}}
						onOpenAnother={() => {
							void (async () => {
								const chosen = await window.brainstorm.vaults.pickFolder("open");
								if (!chosen) return;
								try {
									await window.brainstorm.vaults.openByPath(chosen);
									await refresh();
								} catch (error) {
									console.error("[brainstorm] open-vault failed:", error);
								}
							})();
						}}
						onClose={() => setVaultSwitcherOpen(false)}
					/>
				)}
			</AnimatePresence>
			<Launcher
				open={launcherOpen}
				initialQuery={launcherQuery}
				onClose={() => {
					setLauncherOpen(false);
					setLauncherQuery(null);
				}}
			/>
			<WindowSwitcher
				open={switcherOpen}
				entries={windows}
				cycle={switcherCycle}
				cyclePrev={switcherCyclePrev}
				commitSignal={switcherCommit}
				reverse={switcherReverse}
				onFocus={focusWindow}
				onClose={closeSwitcher}
			/>
			<CapabilityPromptHost />
			<VaultRecoveryPromptHost />
			<OsHandoffPromptHost />
			<Suspense fallback={null}>
				<WhatsNewPopover
					lastSeenChangelogVersion={snapshot?.lastSeenChangelogVersion ?? null}
					snapshotReady={snapshot !== null}
					manualOpenSignal={whatsNewSignal}
				/>
			</Suspense>
			<LiveRegion />
		</main>
	);
}

function formatClock(
	date: Date,
	prefs: ClockPrefs,
	regionalHourCycle: HourCyclePref,
	locale: string,
): string {
	const hour12 = hourCycleToHour12(effectiveHourCycle(prefs.hourCycle, regionalHourCycle));
	const options: Intl.DateTimeFormatOptions = {
		hour: "numeric",
		minute: "2-digit",
		...(prefs.showSeconds ? { second: "2-digit" } : {}),
		...(hour12 !== undefined ? { hour12 } : {}),
	};
	try {
		return date.toLocaleTimeString(locale || undefined, options);
	} catch {
		return date.toLocaleTimeString(undefined, options);
	}
}

/** OpenRes-1c — surface the "why did this open here?" explainer for any
 *  `intent.open` result that carries a stamped rung/refusal. Silent for
 *  results without a rung (entity flow before slice 5 / non-open verbs).
 *  Shared by the dashboard pin-open path; the launcher row has its own
 *  copy (different file). */
function pushExplainerToast(
	result: Awaited<ReturnType<typeof window.brainstorm.intents.dispatch>>,
): void {
	const spec = formatOpenExplainer(result);
	if (!spec) return;
	pushToast({
		kind: spec.kind,
		title: t(spec.titleKey, spec.params),
		...(spec.bodyKey ? { body: t(spec.bodyKey, spec.params) } : {}),
	});
}

/* The header clock previously lived in Dashboard's state — its 30s tick
 * forced a full Dashboard re-render twice/minute, reconciling
 * DashboardIconsLayer + WindowStrip even when nothing they care about
 * changed. Owning the timer locally keeps the tick scoped to this <span>. */
function ClockReadout({
	prefs,
	regionalHourCycle,
	locale,
}: {
	prefs: ClockPrefs;
	regionalHourCycle: HourCyclePref;
	locale: string;
}) {
	const [clock, setClock] = useState(() =>
		formatClock(new Date(), prefs, regionalHourCycle, locale),
	);
	// Tick every second when seconds are shown, else every 30s (the old cadence).
	useEffect(() => {
		const interval = prefs.showSeconds ? 1_000 : 30_000;
		const id = setInterval(
			() => setClock(formatClock(new Date(), prefs, regionalHourCycle, locale)),
			interval,
		);
		setClock(formatClock(new Date(), prefs, regionalHourCycle, locale));
		return () => clearInterval(id);
	}, [prefs, regionalHourCycle, locale]);
	return (
		<span className="dashboard__clock" aria-live="polite">
			{clock}
		</span>
	);
}

const AppearanceToggleButton = memo(function AppearanceToggleButton({
	mode,
	prefersDark,
	onToggle,
}: {
	mode: AppearanceMode;
	prefersDark: boolean;
	onToggle: () => void;
}) {
	const effectiveSlot = effectiveSlotFor(mode, prefersDark);
	// Button shows the destination glyph (where clicking *takes you*). If
	// effective is Light, show Moon (switch to dark); if Dark, show Sun.
	// Auto mode keeps the destination glyph too — the toggle leaves Auto.
	const icon = effectiveSlot === AppearanceSlot.Dark ? IconName.Sun : IconName.Moon;
	const labelKey =
		effectiveSlot === AppearanceSlot.Dark
			? "shell.dashboard.appearance.toggleToLight"
			: "shell.dashboard.appearance.toggleToDark";
	return <IconButton icon={icon} label={t(labelKey)} onClick={onToggle} />;
});

function handleShellAction(
	action: string,
	query: string | undefined,
	{
		openSettings,
		openMarketplace,
		openBin,
		openCheatsheet,
		openHelp,
		openLauncher,
		openAppGrid,
		openSwitcher,
		openSwitcherPrev,
		commitSwitcher,
		openVaultSwitcher,
		refreshVault,
		toggleAppearance,
	}: {
		openSettings: () => void;
		openMarketplace: () => void;
		openBin: () => void;
		openCheatsheet: () => void;
		openHelp: (topicId?: string | null) => void;
		openLauncher: (initialQuery?: string) => void;
		openAppGrid: () => void;
		openSwitcher: () => void;
		openSwitcherPrev: () => void;
		commitSwitcher: () => void;
		openVaultSwitcher: () => void;
		refreshVault: () => Promise<void>;
		toggleAppearance: () => void;
	},
): void {
	switch (action) {
		case "settings":
			openSettings();
			return;
		case "marketplace":
			openMarketplace();
			return;
		case "bin":
			openBin();
			return;
		case "cheatsheet":
			openCheatsheet();
			return;
		case "launcher":
			openLauncher();
			return;
		// `shell/search` — same palette as the launcher; the second chord
		// (Cmd+Space) is an alternate for Windows/Linux. macOS reserves
		// Cmd+Space for Spotlight / input-source switching. A
		// `ui.openSearch` handoff (9.8.9) arrives here too, with the
		// app-supplied query pre-filling the palette.
		case "search":
			openLauncher(query);
			return;
		case "app-grid":
			openAppGrid();
			return;
		case "switch-window":
			openSwitcher();
			return;
		case "switch-window-prev":
			openSwitcherPrev();
			return;
		case "switch-window-commit":
			commitSwitcher();
			return;
		case "vault-switcher":
			openVaultSwitcher();
			return;
		case "new-vault":
			void refreshVault();
			return;
		case "appearance.toggle":
			toggleAppearance();
			return;
		case "open-vault":
			void (async () => {
				const chosen = await window.brainstorm.vaults.pickFolder("open");
				if (!chosen) return;
				try {
					await window.brainstorm.vaults.openByPath(chosen);
					await refreshVault();
				} catch (error) {
					console.error("[brainstorm] open-vault failed:", error);
				}
			})();
			return;
		case "help":
			openHelp();
			return;
		case "open-recent":
			console.warn(`[brainstorm] shell action '${action}' is not wired yet`);
			return;
		default:
			console.warn(`[brainstorm] unknown shell action '${action}'`);
	}
}
