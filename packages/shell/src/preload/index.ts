import {
	type Dictionary,
	type OpenRefusal,
	type OpenRung,
	type OpenWithCandidate,
	type OpenWithDecision,
	OpenWithDecisionKind,
	OsHandoffPromptDecision,
	type PinResolution,
	type PropertyDef,
} from "@brainstorm/sdk-types";
import type { ThemeName } from "@brainstorm/tokens";
import { contextBridge, ipcRenderer } from "electron";
import type {
	AppearanceMode,
	AppearancePair,
	AppearanceSlot,
	AppearanceState,
} from "../shared/appearance";
import type {
	ChromeState,
	ClockPrefs,
	DndPrefs,
	LocaleState,
	NotificationRecord,
	NotificationsState,
	RegionalState,
} from "../shared/shell-prefs";
import {
	type AutoUpdateState,
	type ReleaseInfo,
	UPDATE_STATE_EVENT,
	UpdateAvailability,
	UpdateChannel,
	type UpdateCheckResult,
	type UpdatePrefs,
} from "../shared/update-wire-types";

export type { AppearanceMode, AppearancePair, AppearanceSlot, AppearanceState };
export type { ReleaseInfo, UpdateCheckResult, UpdatePrefs };
export { UpdateAvailability, UpdateChannel };
export type {
	ChromeState,
	ClockPrefs,
	DndPrefs,
	LocaleState,
	NotificationRecord,
	NotificationsState,
	RegionalState,
};

export type VaultEntry = {
	id: string;
	name: string;
	color: string;
	icon?: string;
	path: string;
	lastOpenedAt: number;
	format: string;
};

export type CreateVaultOptions = {
	name: string;
	path: string;
	color?: string;
	/** Welcome-1b: when `false`, decline first-launch starter content (the
	 *  create form's opt-out checkbox). Omitted / `true` seeds. */
	seedStarterContent?: boolean;
};

export type CloudService = "dropbox" | "icloud" | "onedrive" | "googledrive";

export type CloudSyncWarning = {
	service: CloudService;
	displayName: string;
	hint: string;
};

export type KeystoreBackendName =
	| "keychain-macos"
	| "credential-manager-windows"
	| "secret-service-linux"
	| "passphrase"
	| "insecure-dev";

export type VaultSessionMeta = {
	vaultId: string;
	vaultPath: string;
	backend: KeystoreBackendName;
	backendDescription: string;
	backendIsInsecure: boolean;
	identity: { publicKeyBase64: string; fingerprint: string };
};

export type CredentialMetadata = {
	app: string;
	key: string;
	createdAt: number;
	updatedAt: number;
};

/**
 * Subscribe to a main→renderer push channel, dropping the Electron
 * `IpcRendererEvent` so the consumer only sees the payload. Returns an
 * unsubscribe that detaches the exact wrapper installed here. Every `on*`
 * push surface below routes through this — the channel string and payload
 * type stay per-call-site, only the boilerplate collapses.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
	const wrapped = (_event: unknown, payload: T) => listener(payload);
	ipcRenderer.on(channel, wrapped);
	return () => {
		ipcRenderer.off(channel, wrapped);
	};
}

const vaults = {
	list: (): Promise<VaultEntry[]> => ipcRenderer.invoke("vaults:list"),
	current: (): Promise<VaultEntry | null> => ipcRenderer.invoke("vaults:current"),
	create: (options: CreateVaultOptions): Promise<VaultEntry> =>
		ipcRenderer.invoke("vaults:create", options),
	openByPath: (path: string): Promise<VaultEntry> => ipcRenderer.invoke("vaults:open-by-path", path),
	/** Vaults the registry has forgotten but that still exist on disk (12.8
	 *  recovery). Scanned read-only; re-register via `openByPath`. */
	scanRecovered: (): Promise<VaultEntry[]> => ipcRenderer.invoke("vaults:scan-recovered"),
	activate: (id: string): Promise<VaultActivateResult> => ipcRenderer.invoke("vaults:activate", id),
	/** 12.8 — after the user confirms, archive the corrupt domain DB aside and
	 *  re-activate (entities rebuild from sources; ledger/registry re-init). */
	recover: (id: string, kind: VaultDbKind): Promise<VaultActivateResult> =>
		ipcRenderer.invoke("vaults:recover", id, kind),
	pickFolder: (mode: "create" | "open"): Promise<string | null> =>
		ipcRenderer.invoke("vaults:pick-folder", mode),
	defaultPath: (name: string): Promise<string> => ipcRenderer.invoke("vaults:default-path", name),
	checkPath: (path: string): Promise<CloudSyncWarning | null> =>
		ipcRenderer.invoke("vaults:check-path", path),
	session: (): Promise<VaultSessionMeta | null> => ipcRenderer.invoke("vaults:session"),
	close: (): Promise<void> => ipcRenderer.invoke("vaults:close"),
	// App-lock (Stage 13.8). Privileged, dashboard-only.
	lock: (): Promise<{ locked: boolean }> => ipcRenderer.invoke("vault:lock"),
	unlock: (pin: string): Promise<UnlockResult> => ipcRenderer.invoke("vault:unlock", pin),
	lockStatus: (): Promise<{ locked: boolean }> => ipcRenderer.invoke("vault:lock-status"),
	/** Set / replace the app-lock PIN (set/change). Resolves false if rejected
	 *  (no session / floor-invalid). */
	setPin: (pin: string): Promise<boolean> => ipcRenderer.invoke("vault:set-pin", pin),
	/** Remove the app-lock PIN; resolves whether one existed. */
	clearPin: (): Promise<boolean> => ipcRenderer.invoke("vault:clear-pin"),
	/** Whether the active vault has an app-lock PIN set. */
	hasPin: (): Promise<boolean> => ipcRenderer.invoke("vault:has-pin"),
	/** Auto-lock idle timeout in minutes (`0` = off). */
	getAutoLock: (): Promise<number> => ipcRenderer.invoke("vault:get-autolock"),
	/** Persist the auto-lock idle timeout (minutes; `0` = off). */
	setAutoLock: (minutes: number): Promise<boolean> =>
		ipcRenderer.invoke("vault:set-autolock", minutes),
	/** Subscribe to `app:lock-changed`; returns an unsubscribe. */
	onLockChanged: (listener: (payload: LockChangedPayload) => void): (() => void) =>
		subscribe<LockChangedPayload>("app:lock-changed", listener),
	/** Subscribe to `vaults:active-changed` — the main process pushes this on
	 *  every active-vault open/switch (alongside the dashboard rebind), so the
	 *  renderer can re-read the live session even when it didn't initiate the
	 *  switch. Returns an unsubscribe. */
	onActiveChanged: (listener: () => void): (() => void) =>
		subscribe<void>("vaults:active-changed", listener),
};

const credentials = {
	list: (app: string): Promise<CredentialMetadata[]> => ipcRenderer.invoke("credentials:list", app),
	get: async (app: string, key: string): Promise<Uint8Array | null> => {
		const b64 = (await ipcRenderer.invoke("credentials:get", app, key)) as string | null;
		return b64 ? new Uint8Array(Buffer.from(b64, "base64")) : null;
	},
	set: (app: string, key: string, value: Uint8Array): Promise<void> => {
		const b64 = Buffer.from(value).toString("base64");
		return ipcRenderer.invoke("credentials:set", app, key, b64);
	},
	delete: (app: string, key: string): Promise<boolean> =>
		ipcRenderer.invoke("credentials:delete", app, key),
};

/**
 * Capability ledger surface (shell-only). Apps go through the broker
 * (`broker:dispatch`); the dashboard renderer talks to ipcMain directly
 * here because it's the privileged surface that runs the Settings panel.
 */
export type ShellCapabilityGrant = {
	id: string;
	appId: string;
	capability: string;
	scope: string | null;
	grantedAt: number;
	grantedVia: "install" | "runtime";
};

const ledger = {
	listGrantsByApp: (): Promise<Record<string, ShellCapabilityGrant[]>> =>
		ipcRenderer.invoke("ledger:list-grants-by-app"),
	revoke: (appId: string, capability: string, scope: string | null): Promise<boolean> =>
		ipcRenderer.invoke("ledger:revoke", appId, capability, scope),
	/** 11b.8b — request a per-origin `network.egress:<origin>` grant for an app
	 *  (the Automations HTTP-step allowlist). Routes through the fail-safe
	 *  capability prompt in main; resolves the normalized origin + whether it was
	 *  granted. A wildcard / bad origin resolves `{ granted:false, origin:null }`. */
	requestEgressGrant: (
		appId: string,
		origin: string,
	): Promise<{ granted: boolean; origin: string | null }> =>
		ipcRenderer.invoke("ledger:request-egress-grant", appId, origin),
};

/** Shell-action channel (main → dashboard). Used by the application menu. */
const SHELL_ACTION_CHANNEL = "shell:action";
type ShellAction = { action: string; topicId?: string; query?: string };
type ShellActionListener = (event: ShellAction) => void;

const onShellAction = (listener: ShellActionListener): (() => void) =>
	subscribe<ShellAction>(SHELL_ACTION_CHANNEL, listener);

/** Capability-prompt channel (main → dashboard). Resolved with accept/deny. */
const CAPABILITY_PROMPT_CHANNEL = "capabilities:prompt";
const CAPABILITY_PROMPT_REPLY_CHANNEL = "capabilities:prompt-reply";

export type CapabilityPromptRequest = {
	requestId: string;
	appId: string;
	capability: string;
	reason: string;
};

type CapabilityPromptListener = (request: CapabilityPromptRequest) => void;

const onCapabilityPrompt = (listener: CapabilityPromptListener): (() => void) =>
	subscribe<CapabilityPromptRequest>(CAPABILITY_PROMPT_CHANNEL, listener);

const respondCapabilityPrompt = (requestId: string, accept: boolean): void => {
	ipcRenderer.send(CAPABILITY_PROMPT_REPLY_CHANNEL, { requestId, accept });
};

/** OS-handoff first-use consent prompt (OpenRes-1c). Main posts the
 *  prompt on `os-handoff:prompt`; dashboard replies with the user's
 *  decision on `os-handoff:prompt-reply`. Allow / Deny are sticky (the
 *  bus persists via `setOsHandoffConsent`); Cancel leaves consent
 *  unset so the next attempt re-prompts. */
const OS_HANDOFF_PROMPT_CHANNEL = "os-handoff:prompt";
const OS_HANDOFF_PROMPT_REPLY_CHANNEL = "os-handoff:prompt-reply";

/** "Open with…" multi-candidate picker (OpenRes-1c slice 6). Same dual-
 *  channel shape as the OS-handoff prompt; the dashboard renders a
 *  picker modal listing one row per candidate app + an optional
 *  "Remember my choice" toggle. */
const OPEN_WITH_PROMPT_CHANNEL = "open-with:prompt";
const OPEN_WITH_PROMPT_REPLY_CHANNEL = "open-with:prompt-reply";

export type OsHandoffPromptRequest = {
	requestId: string;
	signature: string;
	uri: string;
};

export { OsHandoffPromptDecision };

type OsHandoffPromptListener = (request: OsHandoffPromptRequest) => void;

const onOsHandoffPrompt = (listener: OsHandoffPromptListener): (() => void) =>
	subscribe<OsHandoffPromptRequest>(OS_HANDOFF_PROMPT_CHANNEL, listener);

const respondOsHandoffPrompt = (requestId: string, decision: OsHandoffPromptDecision): void => {
	ipcRenderer.send(OS_HANDOFF_PROMPT_REPLY_CHANNEL, { requestId, decision });
};

export type OpenWithPromptRequest = {
	requestId: string;
	signature: string;
	uri: string;
	candidates: readonly OpenWithCandidate[];
};

export { OpenWithDecisionKind };
export type { OpenWithCandidate, OpenWithDecision };

type OpenWithPromptListener = (request: OpenWithPromptRequest) => void;

const onOpenWithPrompt = (listener: OpenWithPromptListener): (() => void) =>
	subscribe<OpenWithPromptRequest>(OPEN_WITH_PROMPT_CHANNEL, listener);

const respondOpenWithPrompt = (requestId: string, decision: OpenWithDecision): void => {
	ipcRenderer.send(OPEN_WITH_PROMPT_REPLY_CHANNEL, { requestId, decision });
};

/** Dashboard surface (icons + widgets + wallpaper). */
const DASHBOARD_SNAPSHOT_CHANNEL = "dashboard:snapshot";

export type DashboardWallpaperKind = "image" | "gradient" | "solid";
export type DashboardWallpaper = { kind: DashboardWallpaperKind; value: string };
export type DashboardIconKind = "app" | "entity" | "view" | "shell-surface";
export type DashboardIcon = {
	x: number;
	y: number;
	kind: DashboardIconKind;
	target: string;
	label: string;
	icon?: string;
};
export type DashboardWidget = {
	appId: string;
	kind: string;
	x: number;
	y: number;
	w: number;
	h: number;
	paused: boolean;
	collapsed: boolean;
};
/** Renderer-reported geometry for one placed widget's slot, in dashboard
 *  window-content pixels — the host parks the native overlay on this rect
 *  (Stage 7.3). `visible` is false when the slot is scrolled off-screen. */
export type DashboardWidgetLayout = {
	id: string;
	rect: { x: number; y: number; width: number; height: number };
	visible: boolean;
};
/** One entry in the add-widget picker — a widget an installed app offers
 *  (mirrors the main-process `RegisteredWidget`; redeclared so the renderer
 *  never imports a main module). */
export type RegisteredWidget = {
	appId: string;
	appName: string;
	widgetId: string;
	name: string;
	size: "small" | "medium" | "large";
};
export type { PinResolution };
export type DashboardSnapshot = {
	/** Active pair's wallpaper, decided by `appearance.mode` + the OS
	 *  prefers-color-scheme (resolved main-side via `nativeTheme`). */
	wallpaper: DashboardWallpaper;
	/** Active pair's theme. Same resolution as `wallpaper`. */
	theme: ThemeName;
	/** Raw appearance state — mode + both pair slots. The Settings UI
	 *  reads/writes here; non-Appearance code keeps reading `theme` /
	 *  `wallpaper` above. */
	appearance: AppearanceState;
	icons: Record<string, DashboardIcon>;
	widgets: Record<string, DashboardWidget>;
	defaultHandlers: Record<string, string>;
	/** Stage 7.13 — live-resolved presentation for every `kind: "entity"`
	 *  icon, keyed by icon id. Recomputed shell-side on every snapshot
	 *  (label/icon/opener-badge never persist). App/view icons have no
	 *  entry. */
	pins: Record<string, PinResolution>;
	/** Feedback-3 — the last changelog version this vault has seen.
	 *  `null` when the user has never opened the changelog view. */
	lastSeenChangelogVersion?: string | null;
	/** Whether the one-shot 8px icon-grid re-pack has run for this vault. The
	 *  icons layer gates its migration on this so a top-left-clustered layout
	 *  isn't re-packed (reset) on every launch. */
	iconGridMigrated?: boolean;
	/** Active UI language (BCP-47). Drives runtime language switching. */
	locale: LocaleState;
	/** Regional formatting overrides (date/time/first-day/number/timezone). */
	regional: RegionalState;
	/** Shell-interface settings: header-control visibility + clock options. */
	chrome: ChromeState;
	/** Notification preferences: OS-native toggle, DND, per-app mutes. */
	notifications: NotificationsState;
	/** Notification center history (newest last), capped. */
	notificationHistory: NotificationRecord[];
	/** The action surface (doc 63 / AS-4): app ids whose contributed actions
	 *  the user has disabled wholesale. The Settings → Apps & contributions
	 *  toggle reads/writes this; the intents bus drops their contributions. */
	disabledContributors?: string[];
};

/** Settings → Defaults catalog (mirrors `main/intents/defaults-catalog`
 *  — redeclared here so the renderer never imports a main module).
 *  Three sections: entity types (verb-scoped), schemes (`https`, `mailto`,
 *  …) and extensions (`pdf`, `csv`, …). Scheme + extension rows include
 *  the OS-handoff sentinel app id `__os__` so the user can pin "open
 *  with the operating system" alongside the in-vault picks. */
export type DefaultsCatalogApp = { appId: string; label: string };
export type DefaultsCatalogEntry = {
	entityType: string;
	apps: DefaultsCatalogApp[];
	defaultAppId: string | null;
};
export type DefaultsSchemeEntry = {
	scheme: string;
	apps: DefaultsCatalogApp[];
	defaultAppId: string | null;
};
export type DefaultsExtensionEntry = {
	extension: string;
	apps: DefaultsCatalogApp[];
	defaultAppId: string | null;
};
export type DefaultsCatalog = {
	verb: string;
	entries: DefaultsCatalogEntry[];
	schemes: DefaultsSchemeEntry[];
	extensions: DefaultsExtensionEntry[];
};

/** Sentinel app id for "Open with the operating system" — the user's
 *  explicit choice (distinct from `null` "automatic"). The IntentsBus
 *  recognises this value when reading `defaultHandlers` and short-
 *  circuits to the OS-handoff rung. Re-exported from the preload so
 *  the renderer doesn't need to import a main module to compare. */
export const OS_HANDOFF_APP_ID = "__os__";
type DashboardSnapshotListener = (snap: DashboardSnapshot) => void;

const onDashboardSnapshot = (listener: DashboardSnapshotListener): (() => void) =>
	subscribe<DashboardSnapshot>(DASHBOARD_SNAPSHOT_CHANNEL, listener);

export type InstalledApp = {
	id: string;
	name: string;
	version: string;
	sdk: string;
	hasIcon: boolean;
	description?: string;
	/** Advisory manifest-signature status from install (13.2). String mirror of
	 *  the main-process `AppSignatureStatus` enum (preload stays import-light). */
	signatureStatus?: "unsigned" | "verified" | "untrusted" | "invalid";
};

const APPS_RUNNING_CHANGED_CHANNEL = "apps:running-changed";
const onAppsRunningChanged = (listener: (running: string[]) => void): (() => void) =>
	subscribe<string[]>(APPS_RUNNING_CHANGED_CHANNEL, listener);

export type UninstallSummary = {
	ok: boolean;
	reason?: string;
	revokedCapabilities?: number;
	orphanedTypes?: number;
};

export type IconUploadResult = { url: string; thumbUrl: string };
export type IconEntry = { url: string; thumbUrl: string; hash: string; uploadedAt: number };
export type CoverUploadResult = { url: string; thumbUrl: string };
export type CoverImageEntry = { url: string; thumbUrl: string; hash: string; uploadedAt: number };
export type {
	ImportSourcePreview,
	ImportMappingPreview,
	ImportMappingEdit,
	ObsidianSourcePreview,
	NotionSourcePreview,
	ImportPlan,
	ImportRunReport,
};

const icons = {
	uploadFromDialog: (): Promise<IconUploadResult | null> =>
		ipcRenderer.invoke("icons:upload-from-dialog"),
	uploadBytes: (name: string, bytes: Uint8Array): Promise<IconUploadResult> => {
		const bytesBase64 = Buffer.from(bytes).toString("base64");
		return ipcRenderer.invoke("icons:upload-bytes", { name, bytesBase64 });
	},
	list: (): Promise<IconEntry[]> => ipcRenderer.invoke("icons:list"),
	delete: (url: string): Promise<boolean> => ipcRenderer.invoke("icons:delete", url),
};

const covers = {
	uploadFromDialog: (): Promise<CoverUploadResult | null> =>
		ipcRenderer.invoke("covers:upload-from-dialog"),
	uploadBytes: (name: string, bytes: Uint8Array): Promise<CoverUploadResult> => {
		const bytesBase64 = Buffer.from(bytes).toString("base64");
		return ipcRenderer.invoke("covers:upload-bytes", { name, bytesBase64 });
	},
	list: (): Promise<CoverImageEntry[]> => ipcRenderer.invoke("covers:list"),
	delete: (url: string): Promise<boolean> => ipcRenderer.invoke("covers:delete", url),
};

/** IE-3 — Settings → Backup & Migration (privileged dashboard surface over the
 *  IE-1 bundle codec + IE-2 import engine). Apps never see this. */
const importExport = {
	pickSource: (): Promise<ImportSourcePreview | null> =>
		ipcRenderer.invoke("import-export:pick-source"),
	previewMapping: (targetType: string): Promise<ImportMappingPreview[]> =>
		ipcRenderer.invoke("import-export:preview-mapping", targetType),
	plan: (targetType: string, edits?: readonly ImportMappingEdit[]): Promise<ImportPlan> =>
		ipcRenderer.invoke("import-export:plan", targetType, edits ?? null),
	run: (targetType: string, edits?: readonly ImportMappingEdit[]): Promise<ImportRunReport> =>
		ipcRenderer.invoke("import-export:run", targetType, edits ?? null),
	pickObsidian: (): Promise<ObsidianSourcePreview | null> =>
		ipcRenderer.invoke("import-export:pick-obsidian"),
	runObsidian: (targetType: string): Promise<ImportRunReport> =>
		ipcRenderer.invoke("import-export:run-obsidian", targetType),
	pickNotion: (): Promise<NotionSourcePreview | null> =>
		ipcRenderer.invoke("import-export:pick-notion"),
	runNotion: (targetType: string): Promise<ImportRunReport> =>
		ipcRenderer.invoke("import-export:run-notion", targetType),
	cancel: (): Promise<void> => ipcRenderer.invoke("import-export:cancel"),
	onProgress: (handler: (progress: { done: number; total: number }) => void): (() => void) =>
		subscribe<{ done: number; total: number }>("import-export:progress", handler),
	exportVault: (): Promise<{ path: string } | null> =>
		ipcRenderer.invoke("import-export:export-vault"),
};

/** B11.17b — Settings → spellcheck custom-dictionary manager (privileged). */
const spellcheck = {
	listWords: (): Promise<string[]> => ipcRenderer.invoke("spellcheck:list-words"),
	removeWord: (word: string): Promise<string[]> =>
		ipcRenderer.invoke("spellcheck:remove-word", word),
	languages: (): Promise<{ active: string[]; available: string[] }> =>
		ipcRenderer.invoke("spellcheck:languages"),
};

/** 11.9 — Settings → AI panel (privileged). Manages BYO cloud provider API
 *  keys; the key is write-only across this boundary (set), readable only as a
 *  configured/not boolean (has), and removable (clear). The raw key never
 *  comes back to the renderer. */
const aiSettings = {
	hasProviderKey: (providerId: string): Promise<boolean> =>
		ipcRenderer.invoke("ai-settings:has-provider-key", providerId),
	setProviderKey: (providerId: string, key: string): Promise<boolean> =>
		ipcRenderer.invoke("ai-settings:set-provider-key", providerId, key),
	clearProviderKey: (providerId: string): Promise<boolean> =>
		ipcRenderer.invoke("ai-settings:clear-provider-key", providerId),
	/** Per-app AI usage summary (11.8 provenance, aggregated). The raw
	 *  per-call log never crosses IPC — only this aggregate does. */
	usage: (): Promise<
		ReadonlyArray<{
			appId: string;
			calls: number;
			errors: number;
			totalTokens: number;
			lastSeenMs: number;
		}>
	> => ipcRenderer.invoke("ai-settings:usage"),
	/** 11.9 — routing default + per-app token budgets (non-secret per-vault
	 *  config; keys stay in the credential store). */
	getSettings: (): Promise<AiSettingsView> => ipcRenderer.invoke("ai-settings:get-settings"),
	setDefaultProvider: (providerId: string | null): Promise<AiSettingsView | null> =>
		ipcRenderer.invoke("ai-settings:set-default-provider", providerId),
	setAppBudget: (appId: string, maxTokens: number): Promise<AiSettingsView | null> =>
		ipcRenderer.invoke("ai-settings:set-app-budget", appId, maxTokens),
};

/** Mirrors the main-side `AiSettings` shape (11.9). */
export type AiSettingsView = {
	defaultProvider: string | null;
	appBudgets: Record<string, { maxTokens: number }>;
};

/** A configured MCP server + its per-device enablement (MCP-3). Mirrors the
 *  main-side `McpServerView`. */
export type McpServerSettingsView = {
	id: string;
	name: string;
	transport: string;
	url?: string;
	/** stdio transport (MCP-2): the local command + argv. */
	command?: string;
	args?: readonly string[];
	requiresAuth: boolean;
	createdAt: number;
	updatedAt: number;
	enabledHere: boolean;
};

/** One inspected tool — UNTRUSTED description/annotations verbatim + rug-pull
 *  status against the device-local approval baseline. */
export type McpInspectedToolView = {
	name: string;
	description: string;
	readOnlyHint: boolean;
	destructiveHint: boolean;
	rugPull: "changed" | "new" | null;
};

export type McpInspectResultView = {
	ok: boolean;
	tools: ReadonlyArray<McpInspectedToolView>;
	reason?: string;
};

/** MCP-3 — Settings → AI → MCP servers (privileged dashboard surface). Manages
 *  the per-vault server config record + per-device enablement; the auth secret
 *  is write-only across this boundary (set), readable only as a configured/not
 *  boolean (hasAuth). The tools inspector shows UNTRUSTED tool descriptions
 *  verbatim with a rug-pull flag; `approve` re-baselines them. */
const mcpSettings = {
	list: (): Promise<ReadonlyArray<McpServerSettingsView>> => ipcRenderer.invoke("mcp-settings:list"),
	upsert: (input: {
		id: string;
		name: string;
		transport: string;
		url?: string;
		command?: string;
		args?: readonly string[];
		requiresAuth: boolean;
	}): Promise<McpServerSettingsView | null> => ipcRenderer.invoke("mcp-settings:upsert", input),
	remove: (serverId: string): Promise<boolean> =>
		ipcRenderer.invoke("mcp-settings:remove", serverId),
	setEnabled: (serverId: string, enabled: boolean): Promise<boolean> =>
		ipcRenderer.invoke("mcp-settings:set-enabled", serverId, enabled),
	hasAuth: (serverId: string): Promise<boolean> =>
		ipcRenderer.invoke("mcp-settings:has-auth", serverId),
	setAuth: (serverId: string, secret: string): Promise<boolean> =>
		ipcRenderer.invoke("mcp-settings:set-auth", serverId, secret),
	clearAuth: (serverId: string): Promise<boolean> =>
		ipcRenderer.invoke("mcp-settings:clear-auth", serverId),
	inspect: (serverId: string): Promise<McpInspectResultView> =>
		ipcRenderer.invoke("mcp-settings:inspect", serverId),
	approve: (serverId: string): Promise<boolean> =>
		ipcRenderer.invoke("mcp-settings:approve", serverId),
};

/** Live `FileHandle` tokens (9.10) for the Settings → Security "Open files"
 *  panel. Shell-only privileged surface — apps go through the broker. */
export type ShellFileHandle = {
	handleId: string;
	appId: string;
	path: string;
	displayName: string;
	mode: "read" | "read-write";
	createdAt: number;
};

const FILES_HANDLES_CHANGED_CHANNEL = "app:files-handles-changed";
type FilesHandlesListener = () => void;
const onFilesHandlesChanged = (listener: FilesHandlesListener): (() => void) =>
	subscribe<void>(FILES_HANDLES_CHANGED_CHANNEL, () => listener());

const filesHandles = {
	list: (): Promise<ShellFileHandle[]> => ipcRenderer.invoke("files-handles:list"),
	revoke: (handleId: string): Promise<boolean> =>
		ipcRenderer.invoke("files-handles:revoke", handleId),
	on: onFilesHandlesChanged,
};

/** Device-pairing privileged surface (Stage 10.5b — pairing UX). The
 *  dashboard renderer (Settings → Devices + first-launch join entry)
 *  calls these directly; apps never touch this bridge. The broker-side
 *  wiring lands at 10.5c — these handlers consume the `PairingService`
 *  built on the active vault session. */
export type PairingMode = "qr" | "sas";

export type PairingState =
	| "idle"
	| "waiting-for-join"
	| "handshake-in-flight"
	| "paired"
	| "cancelled"
	| "expired"
	| "error";

export type SignedAddDeviceRecord = {
	deviceEd25519Pub: string;
	deviceX25519Pub: string;
	deviceLabel: string;
	addedAt: number;
	addedBy: string;
	revokedAt?: number;
	sig: string;
};

export type PairingStartAddDeviceResult = {
	requestId: string;
	payload: string;
	sas: string;
	expiresAt: number;
	channelId: string;
	mode: PairingMode;
};

export type PairingScanPayloadResult = {
	requestId: string;
	sas: string;
	channelId: string;
	expiresAt: number;
	mode: PairingMode;
};

export type PairingConfirmSasResult = {
	requestId: string;
	addedRecord: SignedAddDeviceRecord;
};

export type PairingErrorReason = "invalid" | "expired" | "unavailable" | "unknown";

export type PairingError = {
	reason: PairingErrorReason;
	message: string;
};

const PAIRING_DEVICES_CHANGED_CHANNEL = "app:pairing-devices-changed";
type PairingListener = () => void;
const onPairingDevicesChanged = (listener: PairingListener): (() => void) =>
	subscribe<void>(PAIRING_DEVICES_CHANGED_CHANNEL, () => listener());

import type { AccessRole } from "../main/collab/access-record";
import type { CollabAccessView, CollabIdentity } from "../main/collab/collab-dev-bridge";
import type { ShareInvite } from "../main/collab/share-invite";
import type { ImportPlan, ImportRunReport } from "../main/import/import-types";
import type {
	ImportMappingEdit,
	ImportMappingPreview,
	ImportSourcePreview,
	NotionSourcePreview,
	ObsidianSourcePreview,
} from "../main/ipc/import-export-handlers";
// Type-only — erased at build, so the sandboxed preload stays import-light
// (these never appear in a runtime position; the Collab-C4-live dev surface
// is only wired when BRAINSTORM_COLLAB_DEBUG=1 in a dev build).
import type {
	WelcomeImportTemplateResult,
	WelcomeTemplateSummary,
} from "../main/ipc/welcome-handlers";
export type { WelcomeTemplateSummary };
/** Sync-status surface (Stage 10.7 — sync-status panel). Privileged
 *  shell channel — apps don't see this (OQ-206 deferred app-side
 *  `sync.status:read` to v2). The dashboard chip + Settings → Sync
 *  section consume it. Enums + snapshot shape live in
 *  `sync-status-types.ts` so renderer value-imports don't drag preload
 *  (and therefore `electron`) into the renderer bundle. */
import type { LockChangedPayload, UnlockResult } from "../shared/app-lock-wire-types";
import type { SelectiveSyncPolicy } from "../shared/selective-sync-types";
import type { VaultActivateResult, VaultDbKind } from "../shared/vault-recovery-wire-types";
import { SyncState, type SyncStatusSnapshot, SyncTransportState } from "../sync-status-types";

export { SyncState, SyncTransportState };
export type { SyncStatusSnapshot };

const SYNC_STATUS_SNAPSHOT_CHANNEL = "sync-status:snapshot";
const SYNC_POLICY_GET_CHANNEL = "sync-status:get-policy";
const SYNC_POLICY_SET_CHANNEL = "sync-status:set-policy";
const SYNC_RESTORE_AVAILABLE_CHANNEL = "sync-status:restore-available";
const SYNC_RESTORE_CHANNEL = "sync-status:restore";

type SyncStatusListener = (snap: SyncStatusSnapshot | null) => void;

/** Stage 10.14 — the result of a cold restore-from-zero pass. */
export type RestoreSummary = {
	requested: number;
	restored: number;
	entityIds: string[];
	complete: boolean;
};

const onSyncStatusSnapshot = (listener: SyncStatusListener): (() => void) =>
	subscribe<SyncStatusSnapshot | null>(SYNC_STATUS_SNAPSHOT_CHANNEL, listener);

const syncStatus = {
	snapshot: (): Promise<SyncStatusSnapshot | null> =>
		ipcRenderer.invoke(SYNC_STATUS_SNAPSHOT_CHANNEL),
	on: onSyncStatusSnapshot,
	// Stage 10.13 — per-device selective-sync policy (dashboard-only). Null when
	// no vault session is active yet (the surface is registered but inert).
	getPolicy: (): Promise<SelectiveSyncPolicy | null> => ipcRenderer.invoke(SYNC_POLICY_GET_CHANNEL),
	setPolicy: (policy: SelectiveSyncPolicy): Promise<SelectiveSyncPolicy | null> =>
		ipcRenderer.invoke(SYNC_POLICY_SET_CHANNEL, policy),
	// Stage 10.14 — cold restore-from-zero (keystore-intact device). `available`
	// gates the offer; `restore` drives the catalog→backfill→reindex pass.
	restoreAvailable: (): Promise<boolean> => ipcRenderer.invoke(SYNC_RESTORE_AVAILABLE_CHANNEL),
	restore: (): Promise<RestoreSummary> => ipcRenderer.invoke(SYNC_RESTORE_CHANNEL),
};

const pairing = {
	startAddDevice: (args?: {
		mode?: PairingMode;
		deviceLabel?: string;
	}): Promise<PairingStartAddDeviceResult> =>
		ipcRenderer.invoke("pairing:start-add-device", args ?? {}),
	scanPayload: (args: { payload: string }): Promise<PairingScanPayloadResult> =>
		ipcRenderer.invoke("pairing:scan-payload", args),
	confirmSas: (args: { requestId: string }): Promise<PairingConfirmSasResult> =>
		ipcRenderer.invoke("pairing:confirm-sas", args),
	cancelPairing: (args: { requestId: string }): Promise<{
		requestId: string;
		state: PairingState;
	}> => ipcRenderer.invoke("pairing:cancel", args),
	listDevices: (): Promise<{ records: SignedAddDeviceRecord[] }> =>
		ipcRenderer.invoke("pairing:list-devices"),
	revokeDevice: (args: { deviceEd25519Pub: string }): Promise<{ revoked: boolean }> =>
		ipcRenderer.invoke("pairing:revoke-device", args),
	thisDeviceFingerprint: (): Promise<string | null> => ipcRenderer.invoke("pairing:this-device"),
	hasRelay: (): Promise<boolean> => ipcRenderer.invoke("pairing:has-relay"),
	on: onPairingDevicesChanged,
};

/** Collab-C6 — privileged Settings → Identity surface: read + edit the local
 *  user's self-asserted display profile (`Profile/v1`). Signing happens in main;
 *  this just ferries the display fields. */
type ProfileView = {
	pubkey: string;
	fingerprint: string;
	displayName: string;
	avatarRef: string | null;
};
const profile = {
	get: (): Promise<ProfileView> => ipcRenderer.invoke("profile:get"),
	set: (args: { displayName: string; avatarRef?: string | null }): Promise<ProfileView> =>
		ipcRenderer.invoke("profile:set", args),
};

/** Net-1f — privileged-only network egress surface for Settings →
 *  Privacy → Network. Six read-only channels + one clear; the dashboard
 *  renderer talks to `ipcMain` directly here because broker-exposing
 *  these would surface another vault's audit log to apps. Wire-shape
 *  enums + types live in `../network-wire-types.ts` so the renderer
 *  can value-import them without dragging this file's `electron` import
 *  into the renderer bundle (sync-status-types.ts precedent). */

export {
	EffectiveProxyKind,
	NetworkAuditOutcome,
	NetworkPrivacyMode,
	NetworkProxyMode,
} from "../network-wire-types";
export type {
	NetworkAuditRecord,
	NetworkAuditRequest,
	NetworkBrokerState,
	NetworkCacheStats,
	NetworkPerAppHostSummary,
	NetworkPerAppSummary,
	NetworkPrivacyConfig,
	NetworkProxyConfig,
	NetworkProxyEndpoint,
	VaultNetworkSettings,
} from "../network-wire-types";
import type {
	NetworkAuditRecord,
	NetworkAuditRequest,
	NetworkBrokerState,
	NetworkCacheStats,
	NetworkPerAppSummary,
	VaultNetworkSettings,
} from "../network-wire-types";
import {
	WEB_EGRESS_SUMMARY_CHANNEL,
	WEB_SITE_PERMISSIONS_LIST_CHANNEL,
	WEB_SITE_PERMISSIONS_REVOKE_CHANNEL,
} from "../web-privacy-wire-types";
import type { SitePermissionGrant, WebEgressHostSummary } from "../web-privacy-wire-types";
export type { SitePermissionGrant, WebEgressHostSummary } from "../web-privacy-wire-types";

/** Push channel that fires on every privacy / proxy override change. */
const VAULT_NETWORK_SETTINGS_CHANGED_CHANNEL = "vault:network-settings:changed";
type VaultNetworkSettingsListener = (settings: VaultNetworkSettings) => void;
const onVaultNetworkSettingsChanged = (listener: VaultNetworkSettingsListener): (() => void) =>
	subscribe<VaultNetworkSettings>(VAULT_NETWORK_SETTINGS_CHANGED_CHANNEL, listener);

/** Feedback-1 + Feedback-2 — privileged bridge for the bug-report client
 *  and opt-in crash reporter. App renderers see nothing; the renderer-side
 *  `feedback-dialog.tsx` + `network-egress-panel.tsx` consume this. Wire
 *  enums + types live in `../feedback-wire-types.ts` so renderers can
 *  value-import without pulling this file's `electron` into the renderer
 *  bundle. */

export {
	CrashKind,
	FeedbackKind,
	FeedbackSensitivity,
	RendererReason,
} from "../feedback-wire-types";
export type {
	CrashPayload,
	CrashPendingSummary,
	CrashSubmissionResult,
	FeedbackPayload,
	FeedbackSettings,
	FeedbackSettingsPatch,
	FeedbackSubmitResult,
} from "../feedback-wire-types";
import type {
	CrashPayload,
	CrashPendingSummary,
	CrashSubmissionResult,
	FeedbackPayload,
	FeedbackSettings,
	FeedbackSettingsPatch,
	FeedbackSubmitResult,
} from "../feedback-wire-types";

const feedback = {
	settings: {
		get: (): Promise<FeedbackSettings> => ipcRenderer.invoke("feedback:settings:get"),
		set: (patch: FeedbackSettingsPatch): Promise<FeedbackSettings> =>
			ipcRenderer.invoke("feedback:settings:set", patch),
	},
	submit: (payload: FeedbackPayload): Promise<FeedbackSubmitResult> =>
		ipcRenderer.invoke("feedback:submit", payload),
	recentLog: (): Promise<string> => ipcRenderer.invoke("feedback:recent-log"),
	crash: {
		pendingCount: (): Promise<CrashPendingSummary> =>
			ipcRenderer.invoke("feedback:crash:pending-count"),
		list: (): Promise<readonly CrashPayload[]> => ipcRenderer.invoke("feedback:crash:list"),
		submitNow: (): Promise<CrashSubmissionResult> => ipcRenderer.invoke("feedback:crash:submit-now"),
		clear: (): Promise<number> => ipcRenderer.invoke("feedback:crash:clear"),
	},
};

const network = {
	settings: {
		get: (): Promise<VaultNetworkSettings | null> => ipcRenderer.invoke("vault:network-settings:get"),
		set: (next: VaultNetworkSettings): Promise<void> =>
			ipcRenderer.invoke("vault:network-settings:set", next),
		on: onVaultNetworkSettingsChanged,
	},
	brokerState: (): Promise<NetworkBrokerState> => ipcRenderer.invoke("network-broker:state"),
	audit: {
		recent: (req: NetworkAuditRequest = {}): Promise<readonly NetworkAuditRecord[]> =>
			ipcRenderer.invoke("network-audit:recent", req),
		blocked: (req: NetworkAuditRequest = {}): Promise<readonly NetworkAuditRecord[]> =>
			ipcRenderer.invoke("network-audit:blocked", req),
		perAppSummary: (): Promise<readonly NetworkPerAppSummary[]> =>
			ipcRenderer.invoke("network-audit:per-app-summary"),
	},
	cache: {
		stats: (): Promise<NetworkCacheStats> => ipcRenderer.invoke("network-cache:stats"),
		clear: (): Promise<void> => ipcRenderer.invoke("network-cache:clear"),
	},
};

/** Browser-7 — Settings → Privacy surface over the web-privacy runtime
 *  (browser site-permission grants + per-host page egress). Privileged-only;
 *  apps never see these channels. */
const webPrivacy = {
	sitePermissions: {
		list: (): Promise<readonly SitePermissionGrant[]> =>
			ipcRenderer.invoke(WEB_SITE_PERMISSIONS_LIST_CHANNEL),
		revoke: (origin: string): Promise<boolean> =>
			ipcRenderer.invoke(WEB_SITE_PERMISSIONS_REVOKE_CHANNEL, origin),
	},
	egress: {
		summary: (limit?: number): Promise<readonly WebEgressHostSummary[]> =>
			ipcRenderer.invoke(WEB_EGRESS_SUMMARY_CHANNEL, limit),
	},
};

const apps = {
	listInstalled: (): Promise<InstalledApp[]> => ipcRenderer.invoke("apps:list-installed"),
	listRunning: (): Promise<string[]> => ipcRenderer.invoke("apps:list-running"),
	/** The action surface (doc 63 / AS-4): app ids that contribute cross-app
	 *  actions, for the Settings → Apps & contributions toggle. */
	listContributingApps: (): Promise<string[]> => ipcRenderer.invoke("apps:list-contributing"),
	onRunningChanged: onAppsRunningChanged,
	iconUrl: (appId: string, version?: string): string => {
		const base = `brainstorm://app-icon/${encodeURIComponent(appId)}`;
		return version ? `${base}?v=${encodeURIComponent(version)}` : base;
	},
	launch: (appId: string): Promise<void> => ipcRenderer.invoke("apps:launch", appId),
	uninstall: (appId: string): Promise<UninstallSummary> =>
		ipcRenderer.invoke("apps:uninstall", appId),
};

/** Vault-level properties + dictionaries surface (VP-4). Dashboard
 *  renderer (Settings → Data) reads + mutates the catalog directly via
 *  this surface; app renderers use the SDK broker proxy from VP-3
 *  instead. Both paths land at the same `PropertiesStore`. */
const PROPERTIES_SNAPSHOT_CHANNEL = "properties:snapshot";

export type PropertiesUsageCounts = {
	/** propertyKey → number of entities with a non-empty value at that key. */
	propertyUsage: Record<string, number>;
	/** dictionaryId → number of entities referencing an item from it. */
	dictionaryUsage: Record<string, number>;
};

export type PropertiesSnapshot = {
	properties: Record<string, PropertyDef>;
	dictionaries: Record<string, Dictionary>;
	/** B5.10 — lazy usage index. Empty maps until the first entities scan
	 *  completes; missing keys mean zero, not unknown. */
	usage: PropertiesUsageCounts;
};

type PropertiesSnapshotListener = (snap: PropertiesSnapshot) => void;

const onPropertiesSnapshot = (listener: PropertiesSnapshotListener): (() => void) =>
	subscribe<PropertiesSnapshot>(PROPERTIES_SNAPSHOT_CHANNEL, listener);

const properties = {
	snapshot: (): Promise<PropertiesSnapshot | null> => ipcRenderer.invoke("properties:snapshot"),
	on: onPropertiesSnapshot,
	setProperty: (def: PropertyDef): Promise<void> =>
		ipcRenderer.invoke("properties:set-property", def),
	removeProperty: (key: string): Promise<void> =>
		ipcRenderer.invoke("properties:remove-property", key),
	setDictionary: (dict: Dictionary): Promise<void> =>
		ipcRenderer.invoke("properties:set-dictionary", dict),
	removeDictionary: (id: string): Promise<void> =>
		ipcRenderer.invoke("properties:remove-dictionary", id),
	/** Registered entity type ids — the candidate targets a Relation property's
	 *  `allowedTypes` scopes to, listed in the Settings property editor. */
	entityTypes: (): Promise<string[]> => ipcRenderer.invoke("properties:entity-types"),
};

/** Vault-wide lexical search (Stage 9.22). The dashboard renderer reads
 *  search hits directly over IPC; apps go through the broker
 *  (`services.search.query`, capability `search.read`). Snippet strings
 *  carry `<mark>…</mark>` highlights — see `SearchIndexer.query`. */
export type SearchHit = {
	entityId: string;
	type: string;
	ownerAppId: string;
	title: string;
	snippet: string;
	score: number;
	updatedAt: number;
};

export type SearchQuery = {
	text: string;
	types?: readonly string[];
	limit?: number;
};

/** Index-health snapshot for the Settings → Search panel (Stage 9.22.4).
 *  `available` is how many indexable entities the sources currently hold;
 *  `null` when no vault session / the source scan failed (coverage shows
 *  "—"). `coverage = total / available` is derived in the renderer. */
export type SearchIndexReport = {
	total: number;
	byType: ReadonlyArray<{ type: string; count: number }>;
	lastIndexedAt: number;
	bytes: number;
	available: number | null;
};

const search = {
	query: (q: SearchQuery): Promise<SearchHit[]> => ipcRenderer.invoke("search:query", q),
	stats: (): Promise<SearchIndexReport> => ipcRenderer.invoke("search:stats"),
	reindex: (): Promise<SearchIndexReport> => ipcRenderer.invoke("search:reindex"),
};

/** Privileged intent-dispatch surface — for the launcher palette + future
 *  shell-side surfaces that need to route an `intent.open` to an app.
 *  Apps continue to use the SDK proxy (`services.intents.dispatch`); both
 *  paths converge on the same `IntentsBus`. */
export type IntentEnvelope = {
	verb: string;
	payload: Record<string, unknown>;
};

/** Mirrors `main/intents/intents-bus.ts` `IntentDispatchResult`. Both
 *  variants carry an optional `rung: OpenRung` so the renderer-side
 *  explainer (OpenRes-1c) can answer "which rung resolved this open"
 *  without re-running the resolver. The `handled: false` variant
 *  additionally carries `refusal: OpenRefusal` when the rung is
 *  `Refused`, surfacing *why* the floor or unknown-target rung blocked
 *  the open. Both fields are optional so legacy callers stay valid. */
export type IntentDispatchResult =
	| {
			handled: true;
			handler: { appId: string; windowId?: string };
			value?: unknown;
			rung?: OpenRung;
	  }
	| {
			handled: false;
			reason: "no-handler" | "no-delivery-channel" | "cancelled" | "handler-error";
			message?: string;
			rung?: OpenRung;
			refusal?: OpenRefusal;
	  };

const intents = {
	dispatch: (envelope: IntentEnvelope): Promise<IntentDispatchResult> =>
		ipcRenderer.invoke("intent:dispatch", envelope),
};

/** Marketplace shell surface — unified browse / library / sources view
 *  across content kinds (apps + themes today; plugin / layout-pack /
 *  wallpaper-pack / locale-pack / workflow-pack / shortcut-pack later)
 *  per. The marketplace overlay is a
 *  privileged shell view, so it talks to ipcMain directly.
 *
 *  Type + enum definitions live in `./marketplace-types` (no electron
 *  imports) so the renderer can pull the enums as runtime values
 *  without dragging this file's `import { ... } from "electron"` into
 *  the renderer bundle. We re-export them here so existing call sites
 *  keep working. */
export {
	MarketplaceContentKind,
	MarketplaceInstallState,
	MarketplaceListingSource,
	type MarketplaceInstallResult,
	type MarketplaceListing,
	type MarketplaceSource,
} from "./marketplace-types";
import type { BinItem } from "./bin-types";
import type {
	MarketplaceInstallResult,
	MarketplaceListing,
	MarketplaceSource,
	MarketplaceUpdate,
} from "./marketplace-types";

const marketplace = {
	listings: (): Promise<MarketplaceListing[]> => ipcRenderer.invoke("marketplace:listings"),
	installed: (): Promise<MarketplaceListing[]> => ipcRenderer.invoke("marketplace:installed"),
	sources: (): Promise<MarketplaceSource[]> => ipcRenderer.invoke("marketplace:sources"),
	install: (appId: string): Promise<MarketplaceInstallResult> =>
		ipcRenderer.invoke("marketplace:install", appId),
	checkUpdates: (): Promise<MarketplaceUpdate[]> => ipcRenderer.invoke("marketplace:check-updates"),
	applyUpdate: (appId: string): Promise<MarketplaceInstallResult> =>
		ipcRenderer.invoke("marketplace:apply-update", appId),
	activateTheme: (theme: ThemeName): Promise<boolean> =>
		ipcRenderer.invoke("marketplace:activate-theme", theme),
};

const bin = {
	list: (): Promise<BinItem[]> => ipcRenderer.invoke("bin:list"),
	restore: (id: string): Promise<boolean> => ipcRenderer.invoke("bin:restore", id),
	purge: (id: string): Promise<boolean> => ipcRenderer.invoke("bin:purge", id),
	empty: (): Promise<number> => ipcRenderer.invoke("bin:empty"),
	/** 9.8.8 — Recently-Deleted retention window (days; 0 = forever). */
	getRetention: (): Promise<number> => ipcRenderer.invoke("bin:get-retention"),
	setRetention: (days: number): Promise<number> => ipcRenderer.invoke("bin:set-retention", days),
};

const dashboard = {
	snapshot: (): Promise<DashboardSnapshot | null> => ipcRenderer.invoke("dashboard:snapshot"),
	on: onDashboardSnapshot,
	upsertIcon: (id: string, record: DashboardIcon): Promise<void> =>
		ipcRenderer.invoke("dashboard:upsert-icon", id, record),
	moveIcon: (id: string, x: number, y: number): Promise<void> =>
		ipcRenderer.invoke("dashboard:move-icon", id, x, y),
	removeIcon: (id: string): Promise<void> => ipcRenderer.invoke("dashboard:remove-icon", id),
	/** Record that the one-shot pre-8px → 8px icon-grid re-pack has run, so the
	 *  icons layer never re-packs (resets) the layout again on this vault. */
	markIconGridMigrated: (): Promise<void> => ipcRenderer.invoke("dashboard:mark-icon-grid-migrated"),
	/** Apply a wallpaper. Without `slot`, the wallpaper lands in the
	 *  currently-active slot (Settings → Appearance's primary path). With
	 *  `slot`, the wallpaper lands in the named slot regardless of which
	 *  is active (the pair-card editor in Settings uses this). */
	setWallpaper: (wallpaper: DashboardWallpaper, slot?: AppearanceSlot): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-wallpaper", wallpaper, slot),
	/** Apply a theme. The store routes it to the slot matching the
	 *  theme's declared `ThemeAppearance` — a dark theme can't end up in
	 *  the light slot. Marketplace activation and Settings both go here. */
	setTheme: (theme: ThemeName): Promise<void> => ipcRenderer.invoke("dashboard:set-theme", theme),
	/** Set the user's appearance mode (Light / Dark / Auto). Per-vault in
	 *  v1; per-device override deferred to OQ-156. */
	setAppearanceMode: (mode: AppearanceMode): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-appearance-mode", mode),
	/** Atomically replace a pair slot's theme + wallpaper — used by the
	 *  Settings → Appearance pair-card editor. */
	setAppearancePair: (slot: AppearanceSlot, pair: AppearancePair): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-appearance-pair", slot, pair),
	uploadWallpaper: (): Promise<{ url: string; thumbUrl: string } | null> =>
		ipcRenderer.invoke("dashboard:upload-wallpaper"),
	listWallpapers: (): Promise<{ url: string; thumbUrl: string }[]> =>
		ipcRenderer.invoke("dashboard:list-wallpapers"),
	deleteWallpaper: (url: string): Promise<boolean> =>
		ipcRenderer.invoke("dashboard:delete-wallpaper", url),
	upsertWidget: (id: string, record: DashboardWidget): Promise<void> =>
		ipcRenderer.invoke("dashboard:upsert-widget", id, record),
	removeWidget: (id: string): Promise<void> => ipcRenderer.invoke("dashboard:remove-widget", id),
	/** Report every placed widget's slot geometry + on-screen visibility so the
	 *  main-process host parks each native overlay on its slot (Stage 7.3). */
	layoutWidgets: (layouts: DashboardWidgetLayout[]): Promise<void> =>
		ipcRenderer.invoke("dashboard:layout-widgets", layouts),
	/** The add-widget picker catalog — every widget installed apps offer. */
	registeredWidgets: (): Promise<RegisteredWidget[]> =>
		ipcRenderer.invoke("dashboard:registered-widgets"),
	/** Widget iframe bridge (Stage 7.3b): the dashboard renderer proxies a
	 *  sandboxed widget iframe's calls to the broker, capability-scoped to the
	 *  widget's `appId` (which the dashboard derives from the iframe it created —
	 *  the sandboxed iframe can't forge it). */
	widgetBridge: {
		/** The cache-busted entry URL for a widget iframe's `src` (the renderer
		 *  appends the `?bs-widget=…` launch query). */
		resolveEntry: (appId: string, widgetId: string): Promise<string | null> =>
			ipcRenderer.invoke("widget-bridge:resolve-entry", appId, widgetId),
		/** Proxy `vaultEntities.list()` for the widget's app (capability-checked). */
		listEntities: (appId: string): Promise<unknown> =>
			ipcRenderer.invoke("widget-bridge:list-entities", appId),
		/** Proxy an `open` intent for the widget's app (capability-checked). */
		openIntent: (appId: string, payload: unknown): Promise<{ handled: boolean }> =>
			ipcRenderer.invoke("widget-bridge:open-intent", appId, payload),
		/** Vault-entity staleness → re-list. Fires for every widget iframe. */
		onEntitiesChanged: (listener: () => void): (() => void) =>
			subscribe<void>("app:vault-entities-changed", listener),
	},
	/** Settings → Defaults: pin (or, with `appId: null`, clear) the
	 *  default handler app for a `(verb, signature)` pair. `signature` is
	 *  either an entity type id (`io.brainstorm.notes/Note/v1`), the
	 *  IntentsBus scheme signature (`scheme:https`), or extension
	 *  signature (`ext:pdf`) — all three ride the same dashboard map,
	 *  read by the IntentsBus via `resolveDefaultHandler(verb,
	 *  signature)`. Pass {@link OS_HANDOFF_APP_ID} as `appId` to pin
	 *  "open with OS" explicitly. */
	setDefaultHandler: (verb: string, signature: string, appId: string | null): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-default-handler", verb, signature, appId),
	/** The action surface (doc 63 / AS-4): disable or re-enable an app's
	 *  contributed actions wholesale. A disabled app's contributions vanish from
	 *  every host menu (`intents.suggestActions`) until re-enabled. Per-vault
	 *  (synced); reviewable in Settings → Apps & contributions. */
	setContributorDisabled: (appId: string, disabled: boolean): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-contributor-disabled", appId, disabled),
	/** The Settings → Defaults catalog — known types × capable apps ×
	 *  current pin — built shell-side from the registry + dashboard doc. */
	defaultsCatalog: (): Promise<DefaultsCatalog | null> =>
		ipcRenderer.invoke("dashboard:defaults-catalog"),
	/** Feedback-3 — record the changelog version the user has seen.
	 *  Pass `null` to reset (every release shows as unseen next time). */
	setLastSeenChangelogVersion: (version: string | null): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-last-seen-changelog-version", version),
	/** Set the active UI language (BCP-47). Per-vault (synced). */
	setLanguage: (language: string): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-language", language),
	/** Patch any subset of the regional-format overrides. */
	setRegional: (partial: Partial<RegionalState>): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-regional", partial),
	/** Show/hide a single dashboard-header control. */
	setHeaderControlVisible: (id: string, visible: boolean): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-header-control-visible", id, visible),
	/** Patch the header clock options (show / seconds / hour cycle). */
	setClockPrefs: (partial: Partial<ClockPrefs>): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-clock-prefs", partial),
	/** Reset all interface (chrome) settings to defaults. */
	resetChrome: (): Promise<void> => ipcRenderer.invoke("dashboard:reset-chrome"),
	/** Toggle OS-native notifications. */
	setNotificationsOsNative: (osNative: boolean): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-notifications-os-native", osNative),
	/** Patch the do-not-disturb window. */
	setDnd: (partial: Partial<DndPrefs>): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-dnd", partial),
	/** Mute / unmute notifications from a single app. */
	setAppNotificationMuted: (appId: string, muted: boolean): Promise<void> =>
		ipcRenderer.invoke("dashboard:set-app-notification-muted", appId, muted),
	/** Mark one notification-center entry read. */
	markNotificationRead: (id: string): Promise<void> =>
		ipcRenderer.invoke("dashboard:mark-notification-read", id),
	/** Mark every notification-center entry read. */
	markAllNotificationsRead: (): Promise<void> =>
		ipcRenderer.invoke("dashboard:mark-all-notifications-read"),
	/** Empty the notification center. */
	clearNotificationHistory: (): Promise<void> =>
		ipcRenderer.invoke("dashboard:clear-notification-history"),
	/** Subscribe to transient theme-preview pushes (9.9.6) — a sanitized
	 *  payload to paint over the committed theme, or `null` to revert.
	 *  Returns an unsubscribe. */
	onThemePreview: (
		listener: (payload: { vars?: Record<string, string> } | null) => void,
	): (() => void) =>
		subscribe<{ vars?: Record<string, string> } | null>("app:theme-preview", listener),
};

/** Feedback-3 — bundled curated changelog (build-time JSON). The
 *  Settings → What's new view + the dashboard auto-popup read this.
 *  Re-exported types so the renderer doesn't import a main module.
 *  v2 (2026-05-24): block-based body replaces the flat note list. */
export type ChangelogTextRun = {
	readonly text: string;
	readonly marks?: readonly ("bold" | "highlight")[];
};
export type ChangelogBlock =
	| { readonly kind: "h1"; readonly text: readonly ChangelogTextRun[] }
	| { readonly kind: "h2"; readonly text: readonly ChangelogTextRun[] }
	| { readonly kind: "h3"; readonly text: readonly ChangelogTextRun[] }
	| { readonly kind: "p"; readonly text: readonly ChangelogTextRun[] }
	| { readonly kind: "li"; readonly text: readonly ChangelogTextRun[] }
	| {
			readonly kind: "callout";
			readonly icon: string;
			readonly text: readonly ChangelogTextRun[];
	  };
export type ChangelogRelease = {
	readonly version: string;
	readonly date: string;
	readonly icon: string;
	readonly title: string;
	readonly summary?: string;
	readonly body: readonly ChangelogBlock[];
};
export type Changelog = {
	readonly format: string;
	readonly releases: readonly ChangelogRelease[];
};

/** Help-1 — Help center corpus article. The shape mirrors the main-process
 *  `HelpArticle` type in `main/help/help-corpus.ts`; both sides type-check
 *  independently to keep the renderer free of main imports. */
export type HelpHeading = {
	readonly depth: number;
	readonly text: string;
	readonly anchor: string;
};
export type HelpArticle = {
	readonly topicId: string;
	readonly sectionId: string;
	readonly title: string;
	readonly slug: string;
	readonly markdown: string;
	readonly plaintext: string;
	readonly headings: readonly HelpHeading[];
	readonly relPath: string;
};
export type HelpCorpus = {
	readonly format: string;
	readonly articles: readonly HelpArticle[];
};
export type HelpHit = {
	readonly topicId: string;
	readonly sectionId: string;
	readonly title: string;
	readonly snippet: string;
	readonly score: number;
};

export const help = {
	getChangelog: (): Promise<Changelog> => ipcRenderer.invoke("help:get-changelog"),
	getCorpus: (): Promise<HelpCorpus> => ipcRenderer.invoke("help:get-corpus"),
	getTopic: (topicId: string): Promise<HelpArticle | null> =>
		ipcRenderer.invoke("help:get-topic", { topicId }),
	search: (text: string, limit?: number): Promise<HelpHit[]> =>
		ipcRenderer.invoke("help:search", { text, limit }),
	/** Help-2 — resolve a focused-surface route (`dashboard` /
	 *  `settings/<pane>` / `app/<id>` / `section/<id>` / `guide/<path>`)
	 *  to a concrete corpus topic id. Returns null only when no corpus
	 *  is loaded; falls back to the home topic on a route that doesn't
	 *  match anything specific (`dashboard` always lands on home). */
	resolveTopic: (route: string): Promise<string | null> =>
		ipcRenderer.invoke("help:resolve-topic", { route }),
};

/** Re-exported from `../shortcut-binding-types` so consumers importing
 *  through the preload barrel keep working. **Renderer value-imports** of
 *  `BindingSource` / `SetOverrideErrorReason` etc. MUST go through
 *  `../shortcut-binding-types` directly (NOT through this barrel) —
 *  re-exporting through a module that also imports `electron` still drags
 *  Electron into the renderer bundle (Vite externalizes `path` /
 *  `__dirname` → first-mount crash). The new types module imports nothing
 *  from Electron, so it is the safe value-import entry point. Mirrors the
 *  `sync-status-types` pattern (commit `66db417`). */
export {
	BindingSource,
	ResetOverrideErrorReason,
	type ResetOverrideResult,
	SetOverrideErrorReason,
	type SetOverrideResult,
	type ShortcutBindingRow,
} from "../shortcut-binding-types";
import type {
	ResetOverrideResult,
	SetOverrideResult,
	ShortcutBindingRow,
} from "../shortcut-binding-types";

const SHORTCUTS_BINDINGS_CHANGED_CHANNEL = "shortcuts:bindings-changed";
const onShortcutsBindingsChanged = (listener: () => void): (() => void) =>
	subscribe<void>(SHORTCUTS_BINDINGS_CHANGED_CHANNEL, () => listener());

export const shortcuts = {
	list: (): Promise<ShortcutBindingRow[]> => ipcRenderer.invoke("shortcuts:list"),
	setOverride: (id: string, chord: string | null): Promise<SetOverrideResult> =>
		ipcRenderer.invoke("shortcuts:set-override", id, chord),
	resetOverride: (id: string): Promise<ResetOverrideResult> =>
		ipcRenderer.invoke("shortcuts:reset-override", id),
	onBindingsChanged: onShortcutsBindingsChanged,
};

/** OpenRes-1c — re-export the resolved-rung enums so the renderer's
 *  future "Why did this open here?" explainer + telemetry consumers
 *  can dispatch on the rung without importing main code. The bus
 *  stamps `rung` (and `refusal` on Refused) on every
 *  `IntentDispatchResult` (`OpenRes-1c data layer`, 2026-05-23).
 *  Re-exported as values so the renderer can `switch (result.rung)`. */
export { OpenRefusal, OpenRung } from "@brainstorm/sdk-types";

/** Window-index surface (privileged — only the dashboard renderer reads).
 *  Types + enums live in `../shared/window-types` so renderer code can
 *  import the *values* (`TilePreset`, `WindowState`) without pulling
 *  this preload module — and therefore `electron` — into its bundle. */
export {
	type MonitorSummary,
	TilePreset,
	type WindowBounds,
	type WindowEntry,
	WindowState,
} from "../shared/window-types";
import type { MonitorSummary, TilePreset, WindowEntry } from "../shared/window-types";

const WINDOWS_CHANGED_CHANNEL = "windows:changed";
const onWindowsChanged = (listener: (entries: WindowEntry[]) => void): (() => void) =>
	subscribe<WindowEntry[]>(WINDOWS_CHANGED_CHANNEL, listener);

const windows = {
	list: (): Promise<WindowEntry[]> => ipcRenderer.invoke("windows:list"),
	listMonitors: (): Promise<MonitorSummary[]> => ipcRenderer.invoke("windows:list-monitors"),
	onChanged: onWindowsChanged,
	focus: (id: string): Promise<boolean> => ipcRenderer.invoke("windows:focus", id),
	minimize: (id: string): Promise<boolean> => ipcRenderer.invoke("windows:minimize", id),
	close: (id: string): Promise<boolean> => ipcRenderer.invoke("windows:close", id),
	tile: (id: string, preset: TilePreset, monitorId?: string): Promise<boolean> =>
		ipcRenderer.invoke("windows:tile", id, preset, monitorId),
	moveToMonitor: (id: string, monitorId: string): Promise<boolean> =>
		ipcRenderer.invoke("windows:move-to-monitor", id, monitorId),
};

const FULLSCREEN_CHANNEL = "window:fullscreen-changed";
const onFullscreenChanged = (listener: (isFullscreen: boolean) => void): (() => void) =>
	subscribe<boolean>(FULLSCREEN_CHANNEL, listener);

const windowState = {
	isFullscreen: (): Promise<boolean> => ipcRenderer.invoke("window:is-fullscreen"),
	onFullscreenChanged,
};

const MAIN_ERROR_CHANNEL = "main:error";
type MainErrorPayload = { message: string };

const onMainError = (listener: (payload: MainErrorPayload) => void): (() => void) =>
	subscribe<MainErrorPayload>(MAIN_ERROR_CHANNEL, listener);

const mainErrors = { on: onMainError };

/** Dev-only helpers. Always exposed; the main-process handler is registered
 *  only when `!app.isPackaged`, so a packaged build will reject the call.
 *  `isDev` is read from the `--brainstorm-dev` argv flag the main process
 *  injects (via `additionalArguments`) when `!app.isPackaged`. NODE_ENV is
 *  unset in a packaged build, so it can't drive this — using it left dev-only
 *  affordances (e.g. "Reseed vault") visible in production. */
export type DevSeedResult = {
	installed: number;
	skipped: number;
	pinned: number;
	errors: string[];
};

/** Result of `dev.refreshAppRegistrations` (7.6). Mirrors the shell's
 *  `RefreshResult`; `ok:false` carries the reason (not installed / bad
 *  manifest / id mismatch). */
export type DevRefreshResult =
	| { ok: true; id: string; version: string }
	| { ok: false; reason: string; path?: string };

/** Result of `dev.reseedVault`. Mirrors the dev-handler's
 *  `DevReseedVaultResult` — seed-cli outcome + the kv→entities backfill
 *  tally so the dashboard toast can report what landed. */
export type DevReseedResult =
	| {
			ok: true;
			backfill: {
				entitiesCreated: number;
				entitiesSkipped: number;
				entitiesHealed: number;
				entitiesResynced: number;
				entitiesRemoved: number;
				linksWritten: number;
			};
	  }
	| { ok: false; reason: string };

/** Result of `dev.notes.createAndOpenScratchNote` (13.4a.2-followup).
 *  Mirrors the shell-side `CreateAndOpenScratchNoteResult` — `ok: true`
 *  carries the freshly-minted entity id (for the bench to log + correlate)
 *  + the `IntentDispatchResult` from the open-intent fan-out (handler info,
 *  resolution rung). `ok: false` carries the reason for early-exit
 *  (no active vault / intents bus not ready). */
export type DevCreateAndOpenScratchNoteResult =
	| { ok: true; entityId: string; dispatch: IntentDispatchResult }
	| { ok: false; reason: string };

const dev = {
	isDev: process.argv.includes("--brainstorm-dev"),
	seedDemoApps: (): Promise<DevSeedResult> => ipcRenderer.invoke("dev:seed-demo-apps"),
	/** Install the bundles already on disk (`<app>/dist`) without a per-app
	 *  vite rebuild. The dogfood harness builds apps once in its global setup,
	 *  so per-session re-seeding stays fast. */
	seedPrebuiltApps: (): Promise<DevSeedResult> => ipcRenderer.invoke("dev:seed-prebuilt-apps"),
	/** Re-apply an installed app's manifest registrations from its
	 *  already-installed bundle — no uninstall/reinstall or shell
	 *  restart. The running IntentsBus reflects it on the next dispatch. */
	refreshAppRegistrations: (appId: string): Promise<DevRefreshResult> =>
		ipcRenderer.invoke("dev:refresh-app-registrations", appId),
	/** Spawn the BrainstormProject seed-cli against the active vault
	 *  (release-plan rich seed: plan iterations → Tasks, OQs → Notes,
	 *  docs → Notes/Files, milestones → Calendar events, …) then run the
	 *  kv→entities backfill so seeded rows appear in apps that read
	 *  `entities.db` directly (Notes since 9.3.5.N2). */
	reseedVault: (): Promise<DevReseedResult> => ipcRenderer.invoke("dev:reseed-vault"),
	/** Seed a believable real-world studio workspace for marketing
	 *  screenshots (clients, projects, people, notes, tasks, events). */
	seedMarketingEntities: (): Promise<{ seeded: boolean }> =>
		ipcRenderer.invoke("dev:seed-marketing-entities"),
	/** Soak harness probes (Stage 10.9a). Main-side handlers are gated by
	 *  `BRAINSTORM_SOAK_DEBUG=1` AND `!app.isPackaged` — every call rejects
	 *  in production. Return shape: `Uint8Array` for state vectors / DEKs
	 *  (sent as `number[]` over IPC + reconstructed on the renderer). */
	getStateVector: async (entityId: string): Promise<Uint8Array> => {
		const arr = (await ipcRenderer.invoke("dev:soak:get-state-vector", entityId)) as number[];
		return new Uint8Array(arr);
	},
	getStateAsUpdate: async (entityId: string): Promise<Uint8Array> => {
		const arr = (await ipcRenderer.invoke("dev:soak:get-state-as-update", entityId)) as number[];
		return new Uint8Array(arr);
	},
	peekEntityDek: async (entityId: string): Promise<Uint8Array | null> => {
		const arr = (await ipcRenderer.invoke("dev:soak:peek-entity-dek", entityId)) as number[] | null;
		return arr ? new Uint8Array(arr) : null;
	},
	setSyncRelay: (url: string | null): Promise<{ changed: boolean }> =>
		ipcRenderer.invoke("dev:soak:set-sync-relay", url),
	/** 10.9d — closes the WS-connect race between `setSyncRelay` and the
	 *  pairing service's subscribe/send chain. Awaits the active relay's
	 *  WebSocketRelayPort reaching `Open`. */
	waitForRelayOpen: (timeoutMs?: number): Promise<{ open: boolean }> =>
		ipcRenderer.invoke("dev:soak:wait-relay-open", timeoutMs),
	/** 10.9e — install a per-entity DEK + per-device wrap so the soak's
	 *  encrypted typed-update envelopes survive the relay round-trip.
	 *  First side calls without `dek` (fresh DEK minted), returns its
	 *  bytes; second side calls with those bytes so both sides resolve
	 *  the same plaintext DEK on local unwrap. */
	installEntityDek: async (entityId: string, dek?: Uint8Array): Promise<{ dek: Uint8Array }> => {
		const arr = await (ipcRenderer.invoke(
			"dev:soak:install-entity-dek",
			entityId,
			dek ? Array.from(dek) : null,
		) as Promise<{ dek: number[] }>);
		return { dek: new Uint8Array(arr.dek) };
	},
	/** 10.9e — install a wire-receive listener on the active relay so the
	 *  target shell actually applies incoming encrypted Update envelopes
	 *  to its local Y.Doc. Also subscribes to the entity's relay channel
	 *  so the relay server fans outbound frames back to this connection
	 *  (no subscribe → relay drops the frame, even when the peer sends
	 *  successfully). Production main doesn't wire this up yet (the full
	 *  sync orchestrator integration is post-10.9 work). Idempotent. */
	installWireReceiver: (entityId: string): Promise<{ ok: boolean }> =>
		ipcRenderer.invoke("dev:soak:install-wire-receiver", entityId),
	appendText: (entityId: string, text: string): Promise<void> =>
		ipcRenderer.invoke("dev:soak:append-text", entityId, text),
	structuralEdit: (entityId: string): Promise<void> =>
		ipcRenderer.invoke("dev:soak:structural-edit", entityId),
	/** 13.4a.2-followup — mint a fresh empty `Note/v1` in the active vault
	 *  + dispatch `intent.open` for it. The Notes window opens with that
	 *  note selected, so the editor-keystroke bench gets a contenteditable
	 *  to type against without a 30s timeout on the empty-state UI. Gated
	 *  identically to every other `dev:*` channel (only registered when
	 *  `!app.isPackaged`). */
	notes: {
		createAndOpenScratchNote: (): Promise<DevCreateAndOpenScratchNoteResult> =>
			ipcRenderer.invoke("dev:notes:create-and-open-scratch-note"),
	},
	/** Collab-C4-live — two-user share/co-edit dogfood surface. Only wired when
	 *  the main process registered the handlers (dev + `BRAINSTORM_COLLAB_DEBUG=1`);
	 *  every call rejects with "no handler" otherwise. Drives the C1/C2 share flow
	 *  over the live relay so two shells (two users) can collaborate end to end. */
	collab: {
		whoami: (): Promise<CollabIdentity> => ipcRenderer.invoke("dev:collab:whoami"),
		createInvite: (label: string): Promise<ShareInvite> =>
			ipcRenderer.invoke("dev:collab:create-invite", label),
		provisionEntity: (
			entityId: string,
			type: string,
			properties?: Record<string, unknown>,
		): Promise<{ ok: boolean }> =>
			ipcRenderer.invoke("dev:collab:provision-entity", entityId, type, properties),
		installShareReceiver: (entityId: string, type: string): Promise<{ ok: boolean }> =>
			ipcRenderer.invoke("dev:collab:install-share-receiver", entityId, type),
		share: (
			entityId: string,
			type: string,
			invite: ShareInvite,
			role: AccessRole,
		): Promise<CollabAccessView[]> =>
			ipcRenderer.invoke("dev:collab:share", entityId, type, invite, role),
		shareCollection: (
			entityId: string,
			type: string,
			invite: ShareInvite,
			role: AccessRole,
		): Promise<CollabAccessView[]> =>
			ipcRenderer.invoke("dev:collab:share-collection", entityId, type, invite, role),
		editText: (entityId: string, text: string): Promise<{ ok: boolean }> =>
			ipcRenderer.invoke("dev:collab:edit-text", entityId, text),
		revoke: (entityId: string, memberB64: string): Promise<{ revoked: boolean }> =>
			ipcRenderer.invoke("dev:collab:revoke", entityId, memberB64),
		access: (entityId: string): Promise<CollabAccessView[]> =>
			ipcRenderer.invoke("dev:collab:access", entityId),
		stateVector: async (entityId: string): Promise<Uint8Array> => {
			const arr = (await ipcRenderer.invoke("dev:collab:state-vector", entityId)) as number[];
			return new Uint8Array(arr);
		},
		readText: (entityId: string): Promise<string> =>
			ipcRenderer.invoke("dev:collab:read-text", entityId),
	},
};

/** 13.6 manual-download check + 13.12 in-app auto-update (app-global,
 *  dashboard-only). `check`/`getPrefs`/`setChannel` are the 13.6 feed path;
 *  `getState`/`checkAuto`/`download`/`installNow`/`onStateChange` drive the
 *  packaged-build electron-updater engine. */
const update = {
	check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke("update:check"),
	getPrefs: (): Promise<UpdatePrefs> => ipcRenderer.invoke("update:get-prefs"),
	setChannel: (channel: UpdateChannel): Promise<UpdatePrefs> =>
		ipcRenderer.invoke("update:set-channel", channel),
	getState: (): Promise<AutoUpdateState> => ipcRenderer.invoke("update:get-state"),
	checkAuto: (): Promise<AutoUpdateState> => ipcRenderer.invoke("update:check-auto"),
	download: (): Promise<AutoUpdateState> => ipcRenderer.invoke("update:download"),
	installNow: (): Promise<void> => ipcRenderer.invoke("update:install"),
	onStateChange: (listener: (state: AutoUpdateState) => void): (() => void) =>
		subscribe<AutoUpdateState>(UPDATE_STATE_EVENT, listener),
};

/** Welcome-2 (9.3.5.V 7d) — first-launch template gallery import. Privileged,
 *  dashboard-only; `templateId` is validated against the registry main-side. */
const welcome = {
	listTemplates: (): Promise<WelcomeTemplateSummary[]> =>
		ipcRenderer.invoke("welcome:list-templates"),
	importTemplate: (templateId: string): Promise<WelcomeImportTemplateResult> =>
		ipcRenderer.invoke("welcome:import-template", templateId),
};

/** The running app version, resolved synchronously from the main process
 *  (`app.getVersion()`) at preload init so the static bridge property is the
 *  real packaged version, never a build-time placeholder. */
function resolveAppVersion(): string {
	try {
		const version = ipcRenderer.sendSync("app:get-version");
		return typeof version === "string" && version.length > 0 ? version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const brainstorm = {
	version: resolveAppVersion(),
	platform: process.platform,
	windowState,
	vaults,
	welcome,
	credentials,
	ledger,
	apps,
	windows,
	dashboard,
	marketplace,
	bin,
	properties,
	search,
	intents,
	icons,
	covers,
	importExport,
	spellcheck,
	aiSettings,
	mcpSettings,
	filesHandles,
	pairing,
	profile,
	syncStatus,
	network,
	webPrivacy,
	feedback,
	help,
	shortcuts,
	shellActions: { on: onShellAction },
	capabilityPrompt: { on: onCapabilityPrompt, respond: respondCapabilityPrompt },
	osHandoffPrompt: { on: onOsHandoffPrompt, respond: respondOsHandoffPrompt },
	openWithPrompt: { on: onOpenWithPrompt, respond: respondOpenWithPrompt },
	mainErrors,
	update,
	dev,
};

try {
	contextBridge.exposeInMainWorld("brainstorm", brainstorm);
} catch (error) {
	console.error("Failed to expose brainstorm bridge", error);
}

export type BrainstormBridge = typeof brainstorm;
