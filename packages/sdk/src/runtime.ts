/**
 * SDK runtime — turns `brainstorm.services.<service>.<method>(...)` calls
 * into broker envelopes via the Bridge.
 *
 * Pure code; no Electron / Node deps. Testable by passing in a fake Bridge.
 *
 * Stage 5 ships a starter subset (storage, credentials, identity, ui.notify);
 * the full service surface — entities, files, intents, ui.openWindow, etc. —
 * arrives in Stage 5b alongside the matching service handlers in main.
 */

import type {
	AiCostEstimate,
	AiExtractRequest,
	AiExtractResult,
	AiGenerateRequest,
	AiGenerateResult,
	AiService,
	AiTransformRequest,
	AiTransformResult,
	AppHandshake,
	AppRuntime,
	AutomationsHostStatus,
	AutomationsRunResult,
	AutomationsService,
	AutomationsWebhookInfo,
	BlockInfo,
	BlocksService,
	BpMessage,
	BpService,
	CalDavCalendarInfo,
	CalDavService,
	CalDavSyncSummary,
	ConnectorRequestResult,
	ConnectorsService,
	ContributedAction,
	ContributedActionTarget,
	ContributedVerb,
	CoverImageEntry,
	CoverUploadResult,
	CoversService,
	CredentialMetadata,
	CredentialsService,
	DashboardService,
	Dictionary,
	DndService,
	DragExportResult,
	DragSessionInfo,
	DropResult,
	EntitiesService,
	Entity,
	EntityMergeResult,
	EntityQuery,
	ExportService,
	FileHandle,
	FileImportResult,
	FilesService,
	FormatContext,
	GraphPatternWire,
	IconEntry,
	IconUploadResult,
	IconsService,
	IdentityService,
	IdentityUser,
	ImportPlanResult,
	ImportPreviewResult,
	ImportRunResult,
	ImportService,
	Intent,
	IntentResult,
	IntentsService,
	LifecycleEvent,
	LifecycleHandler,
	LinkPreview,
	ListSource,
	MailAttachmentFile,
	MailBackfillSummary,
	MailService,
	MailSyncSummary,
	McpAgentTool,
	McpService,
	NetworkFetchInput,
	NetworkFetchResult,
	NetworkReadableResult,
	NetworkService,
	ObjectDragItem,
	PatternQueryResult,
	PlatformCatalog,
	PlatformService,
	PresenceService,
	PropertiesService,
	PropertiesSnapshot,
	PropertyDef,
	RosterMember,
	RosterProfileInput,
	RosterSelf,
	RosterService,
	SearchHit,
	SearchQuery,
	SearchService,
	SelectionService,
	SelectionSnapshot,
	SettingsService,
	ShareInviteToken,
	SharedContact,
	SharedMember,
	SharingService,
	ShortcutDeclaration,
	ShortcutsService,
	SourceQueryResult,
	StorageService,
	StoredAsset,
	Subscription,
	SuggestedIntentHandler,
	ThemeService,
	UiService,
	VaultEntitiesService,
	VaultEntitiesSnapshot,
	WebViewClient,
	WebViewEvent,
	WebViewRect,
} from "@brainstorm-os/sdk-types";
import {
	DEFAULT_FORMAT_CONTEXT,
	DEFAULT_LOCALE,
	WEBVIEW_SERVICE,
	WEB_BROWSE_CAP,
	WEB_CAPTURE_CAP,
	WebViewMethod,
	mcpServerCapability,
} from "@brainstorm-os/sdk-types";
import type { Bridge } from "./bridge";
import { makeSdkError } from "./errors";

export type BuildRuntimeOptions = {
	handshake: AppHandshake;
	bridge: Bridge;
};

/** Push the active locale into a runtime built by `buildRuntimeWithEmitter`.
 *  The preload calls this from its `app:locale-changed` IPC listener so
 *  `runtime.locale` updates and every `onLocaleChange` handler fires. */
export type LocaleSetter = (locale: string) => void;

/** Holds the runtime's current locale + the change listeners. A no-op set
 *  (same value, empty, or non-string) never notifies, so a redundant
 *  broadcast can't churn the app. */
class LocaleHolder {
	private current: string;
	private readonly listeners = new Set<(locale: string) => void>();

	constructor(initial: string) {
		this.current = initial;
	}

	get value(): string {
		return this.current;
	}

	set(locale: string): void {
		if (typeof locale !== "string" || locale.length === 0 || locale === this.current) return;
		this.current = locale;
		for (const fn of this.listeners) {
			try {
				fn(locale);
			} catch (error) {
				console.error("[brainstorm] locale change handler threw:", error);
			}
		}
	}

	on(fn: (locale: string) => void): { unsubscribe: () => void } {
		this.listeners.add(fn);
		return {
			unsubscribe: () => {
				this.listeners.delete(fn);
			},
		};
	}
}

/** Push the active regional-format context into a runtime built by
 *  `buildRuntimeWithEmitter`. The preload calls this from its
 *  `app:format-changed` IPC listener (12.15 slice 15f). */
export type FormatSetter = (format: FormatContext) => void;

// Deliberate twin of the shell's `sameFormatContext` (`shared/format-context.ts`):
// the leaf SDK can't import shell code, so the two-line structural compare is
// duplicated rather than shared. Keep them in sync; don't merge across the layer.
function sameFormat(a: FormatContext, b: FormatContext): boolean {
	return a.locale === b.locale && a.hour12 === b.hour12 && a.timeZone === b.timeZone;
}

/** Holds the runtime's current `FormatContext` + the change listeners. A no-op
 *  set (structurally equal) never notifies, so a redundant broadcast can't churn
 *  the app — the object sibling of `LocaleHolder`. */
class FormatHolder {
	private current: FormatContext;
	private readonly listeners = new Set<(format: FormatContext) => void>();

	constructor(initial: FormatContext) {
		this.current = initial;
	}

	get value(): FormatContext {
		return this.current;
	}

	set(format: FormatContext): void {
		if (!format || typeof format !== "object" || sameFormat(format, this.current)) return;
		this.current = format;
		for (const fn of this.listeners) {
			try {
				fn(format);
			} catch (error) {
				console.error("[brainstorm] format change handler threw:", error);
			}
		}
	}

	on(fn: (format: FormatContext) => void): { unsubscribe: () => void } {
		this.listeners.add(fn);
		return {
			unsubscribe: () => {
				this.listeners.delete(fn);
			},
		};
	}
}

/**
 * Build the `brainstorm` global from a handshake + a bridge. Use this from
 * the app preload to expose the runtime via Electron's `contextBridge`, or
 * from tests / mock-shell-dock for unit work.
 */
export function buildRuntime(options: BuildRuntimeOptions): AppRuntime {
	const { handshake, bridge } = options;
	const lifecycle = new LifecycleEmitter();
	const localeHolder = new LocaleHolder(handshake.locale ?? DEFAULT_LOCALE);
	const formatHolder = new FormatHolder(handshake.format ?? DEFAULT_FORMAT_CONTEXT);

	const runtime: AppRuntime = {
		app: handshake.app,
		capabilities: handshake.capabilities,
		launch: handshake.launch,
		get locale() {
			return localeHolder.value;
		},
		onLocaleChange: (handler) => localeHolder.on(handler),
		get format() {
			return formatHolder.value;
		},
		onFormatChange: (handler) => formatHolder.on(handler),
		services: {
			entities: entitiesProxy(bridge),
			vaultEntities: vaultEntitiesProxy(bridge),
			search: searchProxy(bridge),
			ai: aiProxy(bridge),
			mcp: mcpProxy(bridge),
			automations: automationsProxy(bridge),
			network: networkProxy(bridge),
			connectors: connectorsProxy(bridge),
			mail: mailProxy(bridge),
			caldav: caldavProxy(bridge),
			covers: coversProxy(bridge),
			blocks: blocksProxy(bridge),
			bp: bpProxy(bridge),
			storage: storageProxy(bridge),
			settings: settingsProxy(bridge),
			files: filesProxy(bridge),
			credentials: credentialsProxy(bridge),
			intents: intentsProxy(bridge, handshake.capabilities),
			dashboard: dashboardProxy(bridge),
			export: exportProxy(bridge),
			import: importProxy(bridge),
			icons: iconsProxy(bridge),
			identity: identityProxy(bridge),
			properties: propertiesProxy(bridge),
			platform: platformProxy(bridge),
			roster: rosterProxy(bridge),
			sharing: sharingProxy(bridge),
			presence: presenceProxy(bridge),
			ui: uiProxy(bridge),
			theme: themeProxy(bridge),
			capabilities: capabilitiesProxy(bridge),
			shortcuts: shortcutsProxy(bridge),
			webView: webViewProxy(bridge),
			selection: selectionProxy(bridge),
			dnd: dndProxy(bridge),
		},
		on: <T extends LifecycleEvent["type"]>(event: T, handler: LifecycleHandler<T>) =>
			lifecycle.on(event, handler),
	};

	// Fire `ready` on next tick so listeners attached during `buildRuntime` see it.
	queueMicrotask(() => {
		lifecycle.emit({ type: "ready", handshake });
	});

	return runtime;
}

/** Test helper / preload helper: dispatch a lifecycle event from the host side. */
export type LifecycleDispatcher = (event: LifecycleEvent) => void;

export function attachLifecycleDispatcher(runtime: AppRuntime): LifecycleDispatcher {
	// We grabbed the emitter inside buildRuntime via closure; for external
	// dispatch from the preload's host side, we use a re-attach trick: build
	// the runtime through a constructor that returns the emitter alongside.
	throw new Error("attachLifecycleDispatcher: use buildRuntimeWithEmitter for host control");
}

/** Variant that returns the emitter alongside the runtime so the preload (or
 *  tests) can drive lifecycle events into the app. */
export function buildRuntimeWithEmitter(options: BuildRuntimeOptions): {
	runtime: AppRuntime;
	emitter: LifecycleEmitter;
	setLocale: LocaleSetter;
	setFormat: FormatSetter;
} {
	const { handshake, bridge } = options;
	const lifecycle = new LifecycleEmitter();
	const localeHolder = new LocaleHolder(handshake.locale ?? DEFAULT_LOCALE);
	const formatHolder = new FormatHolder(handshake.format ?? DEFAULT_FORMAT_CONTEXT);
	const runtime: AppRuntime = {
		app: handshake.app,
		capabilities: handshake.capabilities,
		launch: handshake.launch,
		get locale() {
			return localeHolder.value;
		},
		onLocaleChange: (handler) => localeHolder.on(handler),
		get format() {
			return formatHolder.value;
		},
		onFormatChange: (handler) => formatHolder.on(handler),
		services: {
			entities: entitiesProxy(bridge),
			vaultEntities: vaultEntitiesProxy(bridge),
			search: searchProxy(bridge),
			ai: aiProxy(bridge),
			mcp: mcpProxy(bridge),
			automations: automationsProxy(bridge),
			network: networkProxy(bridge),
			connectors: connectorsProxy(bridge),
			mail: mailProxy(bridge),
			caldav: caldavProxy(bridge),
			covers: coversProxy(bridge),
			blocks: blocksProxy(bridge),
			bp: bpProxy(bridge),
			storage: storageProxy(bridge),
			settings: settingsProxy(bridge),
			files: filesProxy(bridge),
			credentials: credentialsProxy(bridge),
			intents: intentsProxy(bridge, handshake.capabilities),
			dashboard: dashboardProxy(bridge),
			export: exportProxy(bridge),
			import: importProxy(bridge),
			icons: iconsProxy(bridge),
			identity: identityProxy(bridge),
			properties: propertiesProxy(bridge),
			platform: platformProxy(bridge),
			roster: rosterProxy(bridge),
			sharing: sharingProxy(bridge),
			presence: presenceProxy(bridge),
			ui: uiProxy(bridge),
			theme: themeProxy(bridge),
			capabilities: capabilitiesProxy(bridge),
			shortcuts: shortcutsProxy(bridge),
			webView: webViewProxy(bridge),
			selection: selectionProxy(bridge),
			dnd: dndProxy(bridge),
		},
		on: <T extends LifecycleEvent["type"]>(event: T, handler: LifecycleHandler<T>) =>
			lifecycle.on(event, handler),
	};
	queueMicrotask(() => lifecycle.emit({ type: "ready", handshake }));
	return {
		runtime,
		emitter: lifecycle,
		setLocale: (locale: string) => localeHolder.set(locale),
		setFormat: (format: FormatContext) => formatHolder.set(format),
	};
}

// ─── LifecycleEmitter ────────────────────────────────────────────────────────

/** Event types whose last emit is replayed to listeners that subscribe
 *  AFTER the emit. Without sticky semantics, the preload's
 *  `queueMicrotask(() => emit("ready"))` fires before the renderer script
 *  has even loaded — every `on("ready", …)` handler would silently miss
 *  the event. Boot/state events ("ready", capabilities) are sticky;
 *  transient events ("intent", "suspend", "resume", "close") are not. */
const STICKY_EVENT_TYPES: ReadonlySet<LifecycleEvent["type"]> = new Set([
	"ready",
	"capability-changed",
]);

export class LifecycleEmitter {
	private readonly listeners = new Map<LifecycleEvent["type"], Set<(e: LifecycleEvent) => void>>();
	private readonly stuck = new Map<LifecycleEvent["type"], LifecycleEvent>();

	on<T extends LifecycleEvent["type"]>(event: T, handler: LifecycleHandler<T>): Subscription {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		const fn = handler as unknown as (e: LifecycleEvent) => void;
		set.add(fn);
		// Replay the last sticky event so handlers attached after the emit
		// still see it.
		const cached = this.stuck.get(event);
		if (cached) {
			try {
				fn(cached);
			} catch (error) {
				console.error("[brainstorm] lifecycle replay threw:", error);
			}
		}
		return {
			unsubscribe: () => {
				set?.delete(fn);
			},
		};
	}

	emit(event: LifecycleEvent): void {
		if (STICKY_EVENT_TYPES.has(event.type)) {
			this.stuck.set(event.type, event);
		}
		const set = this.listeners.get(event.type);
		if (!set) return;
		for (const handler of set) {
			try {
				handler(event);
			} catch (error) {
				// Lifecycle handlers must not break each other; surface to console
				// and continue.
				console.error("[brainstorm] lifecycle handler threw:", error);
			}
		}
	}
}

// ─── Service proxies ─────────────────────────────────────────────────────────

async function callService<T>(
	bridge: Bridge,
	service: string,
	method: string,
	args: unknown[],
	caps: string[],
): Promise<T> {
	const reply = await bridge.dispatch({ service, method, args, caps });
	if (reply.ok) return reply.value as T;
	throw makeSdkError(reply.error.kind, reply.error.message, reply.error);
}

function selectionProxy(bridge: Bridge): SelectionService {
	return {
		publish: (items: ObjectDragItem[]) =>
			callService<void>(bridge, "selection", "publish", [items], ["selection.publish"]),
		current: () =>
			callService<SelectionSnapshot | null>(bridge, "selection", "current", [], ["selection.read"]),
	};
}

function dndProxy(bridge: Bridge): DndService {
	return {
		begin: (args) => callService<DragSessionInfo>(bridge, "dnd", "begin", [args], ["dnd.drag"]),
		move: (args) => callService<void>(bridge, "dnd", "move", [args], ["dnd.drag"]),
		drop: (args) => callService<DropResult>(bridge, "dnd", "drop", [args], ["dnd.drag"]),
		cancel: (args) => callService<void>(bridge, "dnd", "cancel", [args], ["dnd.drag"]),
		setEffect: (args) => callService<void>(bridge, "dnd", "setEffect", [args], ["dnd.drop"]),
		exportFile: (args) =>
			callService<DragExportResult>(bridge, "dnd", "exportFile", [args], ["dnd.export-file"]),
	};
}

function storageProxy(bridge: Bridge): StorageService {
	const proxy: StorageService = {
		put: (key, value) => callService(bridge, "storage", "put", [{ key, value }], ["storage.kv"]),
		get: <T = unknown>(key: string) =>
			callService<T | null>(bridge, "storage", "get", [{ key }], ["storage.kv"]),
		list: (prefix) => callService(bridge, "storage", "list", [{ prefix }], ["storage.kv"]),
		delete: (key) => callService(bridge, "storage", "delete", [{ key }], ["storage.kv"]),
		uploadFile: (filename, bytes, mime) =>
			callService(
				bridge,
				"storage",
				"uploadFile",
				[{ filename, bytes, mime: mime ?? "" }],
				["storage.kv"],
			),
		uploadBegin: (args) => callService(bridge, "storage", "uploadBegin", [args], ["storage.kv"]),
		uploadChunk: (args) => callService(bridge, "storage", "uploadChunk", [args], ["storage.kv"]),
		uploadCommit: (args) => callService(bridge, "storage", "uploadCommit", [args], ["storage.kv"]),
		uploadAbort: (args) => callService(bridge, "storage", "uploadAbort", [args], ["storage.kv"]),
		uploadStreamed: async (args) => {
			const totalBytes = args.bytes.byteLength;
			const { uploadToken, chunkBytes } = await proxy.uploadBegin({
				name: args.name,
				mime: args.mime ?? "",
				totalBytes,
			});
			let aborted = false;
			const onAbort = () => {
				aborted = true;
			};
			args.signal?.addEventListener("abort", onAbort);
			try {
				let seq = 0;
				for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
					if (aborted || args.signal?.aborted) break;
					const end = Math.min(offset + chunkBytes, totalBytes);
					const slice = args.bytes.subarray(offset, end);
					const reply = await proxy.uploadChunk({
						uploadToken,
						seq,
						bytesBase64: encodeBase64(slice),
					});
					args.onProgress?.(reply.receivedBytes, totalBytes);
					seq += 1;
				}
				if (aborted || args.signal?.aborted) {
					await proxy.uploadAbort({ uploadToken }).catch(() => undefined);
					throw args.signal?.reason ?? new Error("upload aborted");
				}
				const file = await proxy.uploadCommit({ uploadToken });
				// The signal may have fired during the commit await; if so the
				// caller asked for cancellation and we MUST not silently hand
				// them the committed file. The .tmp is already renamed into
				// the content-addressed store; uploadAbort is a no-op past
				// commit (token already torn down), so we just rethrow.
				if (aborted || args.signal?.aborted) {
					throw args.signal?.reason ?? new Error("upload aborted");
				}
				return file;
			} catch (error) {
				await proxy.uploadAbort({ uploadToken }).catch(() => undefined);
				throw error;
			} finally {
				args.signal?.removeEventListener("abort", onAbort);
			}
		},
	};
	return proxy;
}

/** Per-device app settings (device-local, never synced). Mirrors the kv
 *  shape; backed by the shell's `settings.db`. No capability scope — the
 *  service is namespaced by the calling app's verified identity. */
function webViewProxy(bridge: Bridge): WebViewClient {
	const browse = [WEB_BROWSE_CAP];
	return {
		open: (tabId, url, isPrivate) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.Open,
				[{ method: WebViewMethod.Open, tabId, url, private: isPrivate === true }],
				browse,
			),
		navigate: (tabId, url) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.Navigate,
				[{ method: WebViewMethod.Navigate, tabId, url }],
				browse,
			),
		back: (tabId) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.Back,
				[{ method: WebViewMethod.Back, tabId }],
				browse,
			),
		forward: (tabId) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.Forward,
				[{ method: WebViewMethod.Forward, tabId }],
				browse,
			),
		reload: (tabId) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.Reload,
				[{ method: WebViewMethod.Reload, tabId }],
				browse,
			),
		stop: (tabId) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.Stop,
				[{ method: WebViewMethod.Stop, tabId }],
				browse,
			),
		close: (tabId) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.Close,
				[{ method: WebViewMethod.Close, tabId }],
				browse,
			),
		activate: (tabId) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.Activate,
				[{ method: WebViewMethod.Activate, tabId }],
				browse,
			),
		setBounds: (tabId, bounds: WebViewRect) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.SetBounds,
				[{ method: WebViewMethod.SetBounds, tabId, bounds }],
				browse,
			),
		findInPage: (tabId, query, forward) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.FindInPage,
				[{ method: WebViewMethod.FindInPage, tabId, query, forward }],
				browse,
			),
		stopFind: (tabId) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.StopFind,
				[{ method: WebViewMethod.StopFind, tabId }],
				browse,
			),
		capture: (tabId, selectionOnly) =>
			callService<{ bookmarkId: string } | null>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.Capture,
				[{ method: WebViewMethod.Capture, tabId, selectionOnly }],
				[WEB_CAPTURE_CAP],
			),
		setSitePermission: (tabId, origin, permission, allow) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.SetSitePermission,
				[{ method: WebViewMethod.SetSitePermission, tabId, origin, permission, allow }],
				browse,
			),
		clearBrowsingData: () =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.ClearBrowsingData,
				[{ method: WebViewMethod.ClearBrowsingData }],
				browse,
			),
		setSiteTrust: (origin, trusted) =>
			callService<void>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.SetSiteTrust,
				[{ method: WebViewMethod.SetSiteTrust, origin, trusted }],
				browse,
			),
		isSiteTrusted: (origin) =>
			callService<boolean>(
				bridge,
				WEBVIEW_SERVICE,
				WebViewMethod.IsSiteTrusted,
				[{ method: WebViewMethod.IsSiteTrusted, origin }],
				browse,
			),
		// The default proxy mints the call path but can't route the broadcast
		// event stream — the preload overlays `onEvent` with the channel-backed
		// shape (mirrors `files.watch`). Non-Electron bridges keep this no-op.
		onEvent: (_listener: (event: WebViewEvent) => void) => () => undefined,
	};
}

function settingsProxy(bridge: Bridge): SettingsService {
	return {
		get: <T = unknown>(key: string) =>
			callService<T | null>(bridge, "settings", "get", [{ key }], []),
		put: (key, value) => callService<void>(bridge, "settings", "put", [{ key, value }], []),
		delete: (key) => callService<boolean>(bridge, "settings", "delete", [{ key }], []),
		list: (prefix) =>
			callService<Array<{ key: string; value: unknown }>>(
				bridge,
				"settings",
				"list",
				[{ prefix }],
				[],
			),
	};
}

function credentialsProxy(bridge: Bridge): CredentialsService {
	return {
		list: () =>
			callService<CredentialMetadata[]>(bridge, "credentials", "list", [], ["credentials.read:self"]),
		get: async (key) => {
			const result = await callService<string | null>(
				bridge,
				"credentials",
				"get",
				[{ key }],
				["credentials.read:self"],
			);
			if (result === null) return null;
			return new Uint8Array(decodeBase64(result));
		},
		set: (key, value) =>
			callService<void>(
				bridge,
				"credentials",
				"set",
				[{ key, valueB64: encodeBase64(value) }],
				["credentials.write:self"],
			),
		delete: (key) =>
			callService<boolean>(bridge, "credentials", "delete", [{ key }], ["credentials.write:self"]),
	};
}

function identityProxy(bridge: Bridge): IdentityService {
	return {
		user: () => callService<IdentityUser>(bridge, "identity", "user", [], []),
		signPayload: async (payload) => {
			const result = await callService<string>(
				bridge,
				"identity",
				"sign",
				[{ payloadB64: encodeBase64(payload) }],
				["identity.sign"],
			);
			return new Uint8Array(decodeBase64(result));
		},
	};
}

function themeProxy(bridge: Bridge): ThemeService {
	return {
		preview: (spec) => callService<void>(bridge, "theme", "preview", [spec], ["theme.preview"]),
		clearPreview: () => callService<void>(bridge, "theme", "clearPreview", [], ["theme.preview"]),
	};
}

function uiProxy(bridge: Bridge): UiService {
	return {
		openWindow: (spec) => callService<string>(bridge, "ui", "openWindow", [spec], []),
		closeWindow: (id) => callService<void>(bridge, "ui", "closeWindow", [{ id }], []),
		notify: (notification) =>
			callService<void>(bridge, "ui", "notify", [notification], ["notifications.post"]),
		openSearch: (args) => callService<void>(bridge, "ui", "openSearch", [args], ["search.open"]),
		tray: {
			publish: (spec) => callService<void>(bridge, "ui", "tray.publish", [spec], ["tray.publish"]),
			clear: () => callService<void>(bridge, "ui", "tray.clear", [], ["tray.publish"]),
		},
	};
}

function capabilitiesProxy(bridge: Bridge) {
	return {
		list: (): readonly string[] => {
			// Capabilities snapshot is part of the handshake; this returns the
			// runtime-cached copy via lifecycle updates. The bridge call is for
			// fresh-read paths.
			return [];
		},
		request: (capability: string, reason: string) =>
			callService<boolean>(bridge, "capabilities", "request", [{ capability, reason }], []),
		subscribe: (_onChange: (capabilities: readonly string[]) => void): Subscription => ({
			unsubscribe: () => undefined,
		}),
	};
}

// ─── Placeholders for full Stage 5b surface ──────────────────────────────────

function entitiesProxy(bridge: Bridge): EntitiesService {
	// `caps: []` — `entities` is type-scoped and the row's type isn't known
	// until the shell fetches it, so the per-type capability check is the
	// shell handler's job (against the ledger), not a static per-call gate.
	return {
		get: (id) => callService<Entity | null>(bridge, "entities", "get", [{ id }], []),
		query: (query: EntityQuery) =>
			callService<Entity[]>(bridge, "entities", "query", [{ query }], []),
		create: (type, properties, id) =>
			callService<Entity>(
				bridge,
				"entities",
				"create",
				[id === undefined ? { type, properties } : { type, properties, id }],
				[],
			),
		update: (id, patch) => callService<Entity>(bridge, "entities", "update", [{ id, patch }], []),
		delete: (id) => callService<void>(bridge, "entities", "delete", [{ id }], []),
		merge: (survivorId, loserIds, patch) =>
			callService<EntityMergeResult>(
				bridge,
				"entities",
				"merge",
				[patch === undefined ? { survivorId, loserIds } : { survivorId, loserIds, patch }],
				[],
			),
		loadDoc: (id) =>
			callService<{ snapshotB64: string; truncatedTail: boolean }>(
				bridge,
				"entities",
				"loadDoc",
				[{ id }],
				[],
			),
		applyDoc: (id, updateB64) =>
			callService<unknown>(bridge, "entities", "applyDoc", [{ id, updateB64 }], []),
		closeDoc: (id) => callService<void>(bridge, "entities", "closeDoc", [{ id }], []),
		// No-op default. The preload overrides this with an IPC-backed
		// implementation riding the `app:vault-entities-changed` broadcast
		// (the same channel the vault-entities preview uses). Tests /
		// non-Electron bridges keep the no-op.
		subscribe: (_query, _onUpdate): Subscription => ({ unsubscribe: () => undefined }),
	};
}

/**
 * Files host service proxy (Stage 9.10). Cap hints carry scope per
 * `[[project_intents_dispatch_cap_scope]]` — the read-side methods stamp
 * `files.read`, the write-side methods stamp `files.write`. A scoped grant
 * resolution failure on the broker side returns `CapabilityDenied`
 * (mapped to an SdkError by `callService`); apps surface that as "the
 * user hasn't granted file access yet".
 *
 * `watch` is layered over a `subscribe`/`unwatch` envelope pair: the SDK
 * call returns a `Subscription` that the renderer's preload listener
 * dispatches into, because the broker is request/reply — the broadcast
 * channel (`app:files-watch`) is what carries the streaming half. The
 * default proxy returned here exposes the request/reply envelopes; the
 * preload overlays the listener wiring exactly like
 * `vaultEntities.onChange` does for the vault-entities staleness signal.
 */
function filesProxy(bridge: Bridge): FilesService {
	return {
		requestOpen: (opts) =>
			callService<readonly FileHandle[]>(bridge, "files", "requestOpen", [opts ?? {}], ["files.read"]),
		requestSave: (opts) =>
			callService<FileHandle | null>(bridge, "files", "requestSave", [opts ?? {}], ["files.write"]),
		read: async (handle) => {
			const reply = await callService<{ base64: string }>(
				bridge,
				"files",
				"read",
				[{ handleId: handle.handleId }],
				["files.read"],
			);
			return new Uint8Array(decodeBase64(reply.base64));
		},
		write: (handle, data) => {
			const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
			return callService<void>(
				bridge,
				"files",
				"write",
				[{ handleId: handle.handleId, data: { base64: encodeBase64(bytes) } }],
				["files.write"],
			);
		},
		// Default proxy can mint the subscription but cannot route events —
		// the preload swaps this with the broadcast-channel-backed shape.
		// Tests / non-Electron bridges keep the no-op listener.
		watch: async (handle, _onChange) => {
			await callService<{ subscriptionId: string }>(
				bridge,
				"files",
				"watch",
				[{ handleId: handle.handleId }],
				["files.read"],
			);
			return { unsubscribe: () => undefined };
		},
		handleFromIntent: (handle) =>
			callService<FileHandle | null>(
				bridge,
				"files",
				"handleFromIntent",
				[{ token: handle.handleId }],
				["files.read"],
			),
		import: (input) => {
			if ("handle" in input) {
				return callService<FileImportResult>(
					bridge,
					"files",
					"import",
					[{ handleId: input.handle.handleId }],
					["files.read"],
				);
			}
			const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
			return callService<FileImportResult>(
				bridge,
				"files",
				"import",
				[{ name: input.name, data: { base64: encodeBase64(bytes) } }],
				["files.read"],
			);
		},
		listStorageInventory: () =>
			callService<readonly StoredAsset[]>(bridge, "files", "listStorageInventory", [], ["files.read"]),
	};
}

function propertiesProxy(bridge: Bridge): PropertiesService {
	return {
		list: () =>
			callService<PropertiesSnapshot>(bridge, "properties", "list", [], ["properties.read"]),
		getProperty: (key) =>
			callService<PropertyDef | null>(
				bridge,
				"properties",
				"getProperty",
				[{ key }],
				["properties.read"],
			),
		setProperty: (def) =>
			callService<void>(bridge, "properties", "setProperty", [{ def }], ["properties.write"]),
		removeProperty: (key) =>
			callService<void>(bridge, "properties", "removeProperty", [{ key }], ["properties.write"]),
		getDictionary: (id) =>
			callService<Dictionary | null>(
				bridge,
				"properties",
				"getDictionary",
				[{ id }],
				["properties.read"],
			),
		setDictionary: (dict) =>
			callService<void>(bridge, "properties", "setDictionary", [{ dict }], ["properties.write"]),
		removeDictionary: (id) =>
			callService<void>(bridge, "properties", "removeDictionary", [{ id }], ["properties.write"]),
		// No-op default. The preload overrides this with an IPC-backed
		// implementation that fires whenever the shell's PropertiesStore
		// mutates (writes from Settings → Data, sibling apps, future sync
		// peers). Tests / non-Electron bridges keep the no-op.
		onChange: (_listener: () => void): Subscription => ({ unsubscribe: () => undefined }),
	};
}

function searchProxy(bridge: Bridge): SearchService {
	return {
		query: (q: SearchQuery) =>
			callService<SearchHit[]>(bridge, "search", "query", [q], ["search.read"]),
		hybrid: (q: SearchQuery) =>
			callService<SearchHit[]>(bridge, "search", "hybrid", [q], ["search.read"]),
	};
}

function networkProxy(bridge: Bridge): NetworkService {
	return {
		fetch: (input: NetworkFetchInput) => {
			// Net-1b — when the caller opts into private-network reach,
			// add the `.private` widener cap to the envelope. The broker
			// enforces both caps are granted (user has loudly approved
			// `network.fetch.private` in the manifest grant prompt).
			const caps = input.allowPrivate ? ["network.fetch", "network.fetch.private"] : ["network.fetch"];
			return callService<NetworkFetchResult>(bridge, "network", "fetch", [input], caps);
		},
		preview: (input: { url: string; locale?: string }) =>
			callService<LinkPreview>(bridge, "network", "preview", [input], ["network.preview"]),
		readable: (input: { url: string; locale?: string; allowPrivate?: boolean }) => {
			// `.private` is the scope-widener; the broker enforces both are granted.
			const caps = input.allowPrivate
				? ["network.readable", "network.readable.private"]
				: ["network.readable"];
			return callService<NetworkReadableResult>(bridge, "network", "readable", [input], caps);
		},
	};
}

function aiProxy(bridge: Bridge): AiService {
	return {
		generate: (req: AiGenerateRequest) => {
			// `ai.use` is the gate; pin `ai.provider:<id>` too when the
			// caller names a provider so the broker matches the scoped grant
			// (mirrors `aiCapabilitiesForRequest` in the contract leaf).
			const caps = req.provider ? ["ai.use", `ai.provider:${req.provider}`] : ["ai.use"];
			return callService<AiGenerateResult>(bridge, "ai", "generate", [req], caps);
		},
		transform: (req: AiTransformRequest) => {
			const caps = req.provider ? ["ai.use", `ai.provider:${req.provider}`] : ["ai.use"];
			return callService<AiTransformResult>(bridge, "ai", "transform", [req], caps);
		},
		extract: (req: AiExtractRequest) => {
			const caps = req.provider ? ["ai.use", `ai.provider:${req.provider}`] : ["ai.use"];
			return callService<AiExtractResult>(bridge, "ai", "extract", [req], caps);
		},
		cost: (req: AiGenerateRequest) => {
			const caps = req.provider ? ["ai.use", `ai.provider:${req.provider}`] : ["ai.use"];
			return callService<AiCostEstimate>(bridge, "ai", "cost", [req], caps);
		},
	};
}

function platformProxy(bridge: Bridge): PlatformService {
	return {
		// doc 63 — read-only platform catalog. `platform.read` is scarce; the
		// broker re-checks it against the ledger (fail-closed).
		catalog: () => callService<PlatformCatalog>(bridge, "platform", "catalog", [], ["platform.read"]),
	};
}

function rosterProxy(bridge: Bridge): RosterService {
	return {
		// Collab-C6 — vault membership joined to self-asserted display profiles.
		// `roster.read` / `roster.write` are scarce; the broker re-checks them
		// against the ledger (fail-closed).
		members: (entityId) =>
			callService<RosterMember[]>(bridge, "roster", "members", [entityId], ["roster.read"]),
		self: () => callService<RosterSelf>(bridge, "roster", "self", [], ["roster.read"]),
		setSelf: (input: RosterProfileInput) =>
			callService<RosterSelf>(bridge, "roster", "setSelf", [input], ["roster.write"]),
	};
}

function sharingProxy(bridge: Bridge): SharingService {
	// Collab-C5 — multi-user share/revoke over the Stage-10 crypto spine.
	// `sharing.read` (mint own invite, read access) is a default grant;
	// `sharing.share` (grant/revoke) is scarce and re-checked server-side.
	return {
		createInvite: (label) =>
			callService<ShareInviteToken>(bridge, "sharing", "createInvite", [label], ["sharing.read"]),
		share: (input) =>
			callService<SharedMember[]>(bridge, "sharing", "share", [input], ["sharing.share"]),
		shareCollection: (input) =>
			callService<SharedMember[]>(bridge, "sharing", "shareCollection", [input], ["sharing.share"]),
		saveContact: (input) =>
			callService<SharedContact>(bridge, "sharing", "saveContact", [input], ["sharing.read"]),
		listContacts: () =>
			callService<SharedContact[]>(bridge, "sharing", "listContacts", [], ["sharing.read"]),
		revoke: (input) =>
			callService<SharedMember[]>(bridge, "sharing", "revoke", [input], ["sharing.share"]),
		access: (entityId) =>
			callService<SharedMember[]>(bridge, "sharing", "access", [entityId], ["sharing.read"]),
	};
}

function presenceProxy(bridge: Bridge): PresenceService {
	// PRES-2b — live presence. `publish` piggybacks on the entity read grant
	// (`entities.read:<type>`, re-checked server-side); `untrack` needs no cap
	// (it only clears our own presence). Peers arrive on the `presence.onPeers`
	// push, wired separately by the app preload.
	return {
		publish: (input) =>
			callService<void>(bridge, "presence", "publish", [input], [`entities.read:${input.type}`]),
		untrack: (input) => callService<void>(bridge, "presence", "untrack", [input], []),
	};
}

function mcpProxy(bridge: Bridge): McpService {
	return {
		// listTools declares no per-server cap: the broker filters to the servers
		// whose `mcp.server:<id>` the ledger holds (it can't know the set ahead of
		// the call). callTool pins the specific server's cap so the broker matches
		// the scoped grant — and re-checks it against the ledger (fail-closed).
		listTools: (input) =>
			callService<readonly McpAgentTool[]>(bridge, "mcp", "listTools", [input ?? {}], []),
		callTool: (input) =>
			callService<{ content: unknown; isError: boolean }>(
				bridge,
				"mcp",
				"callTool",
				[input],
				[mcpServerCapability(input.serverId)],
			),
	};
}

function mailProxy(bridge: Bridge): MailService {
	return {
		connectGmail: (input) =>
			callService<{ accountId: string; address: string }>(
				bridge,
				"mail",
				"connectGmail",
				[input],
				["mail.manage"],
			),
		connectImap: (input) =>
			callService<{ accountId: string; address: string }>(
				bridge,
				"mail",
				"connectImap",
				[input],
				["mail.manage"],
			),
		syncNow: (input) =>
			callService<MailSyncSummary>(bridge, "mail", "syncNow", [input], ["mail.manage"]),
		loadOlder: (input) =>
			callService<MailBackfillSummary>(bridge, "mail", "loadOlder", [input], ["mail.manage"]),
		fetchAttachment: (input) =>
			callService<MailAttachmentFile>(bridge, "mail", "fetchAttachment", [input], ["mail.manage"]),
		disconnect: (input) =>
			callService<{ ok: true }>(bridge, "mail", "disconnect", [input], ["mail.manage"]),
	};
}

function caldavProxy(bridge: Bridge): CalDavService {
	return {
		connect: (input) =>
			callService<{ accountId: string; calendars: CalDavCalendarInfo[] }>(
				bridge,
				"caldav",
				"connect",
				[input],
				["caldav.manage"],
			),
		listCalendars: (input) =>
			callService<CalDavCalendarInfo[]>(bridge, "caldav", "listCalendars", [input], ["caldav.manage"]),
		addCalendar: (input) =>
			callService<{ calendarRef: string }>(
				bridge,
				"caldav",
				"addCalendar",
				[input],
				["caldav.manage"],
			),
		syncNow: (input) =>
			callService<CalDavSyncSummary>(bridge, "caldav", "syncNow", [input], ["caldav.manage"]),
		disconnect: (input) =>
			callService<{ ok: true }>(bridge, "caldav", "disconnect", [input], ["caldav.manage"]),
	};
}

function automationsProxy(bridge: Bridge): AutomationsService {
	return {
		runNow: (input) =>
			callService<AutomationsRunResult>(bridge, "automations", "runNow", [input], ["automations.run"]),
		hostStatus: () =>
			callService<AutomationsHostStatus>(
				bridge,
				"automations",
				"hostStatus",
				[{}],
				["automations.run"],
			),
		claimHost: () =>
			callService<AutomationsHostStatus>(
				bridge,
				"automations",
				"claimHost",
				[{}],
				["automations.run"],
			),
		webhookInfo: () =>
			callService<AutomationsWebhookInfo>(
				bridge,
				"automations",
				"webhookInfo",
				[{}],
				["automations.run"],
			),
	};
}

function connectorsProxy(bridge: Bridge): ConnectorsService {
	return {
		authorize: (input) =>
			callService<{ accountId: string }>(
				bridge,
				"connectors",
				"authorize",
				[input],
				["connectors.oauth"],
			),
		connectToken: (input) =>
			callService<{ accountId: string }>(
				bridge,
				"connectors",
				"connectToken",
				[input],
				["connectors.oauth"],
			),
		revoke: (input) =>
			callService<{ ok: true }>(bridge, "connectors", "revoke", [input], ["connectors.oauth"]),
		request: (input) =>
			callService<ConnectorRequestResult>(
				bridge,
				"connectors",
				"request",
				[input],
				["connectors.request"],
			),
		sync: (input) =>
			callService<unknown>(bridge, "connectors", "sync", [input], ["connectors.request"]),
	};
}

function coversProxy(bridge: Bridge): CoversService {
	return {
		uploadBytes: (filename: string, bytes: Uint8Array) =>
			callService<CoverUploadResult>(
				bridge,
				"covers",
				"uploadBytes",
				[{ name: filename, bytesBase64: encodeBase64(bytes) }],
				["covers.write"],
			),
		list: () => callService<CoverImageEntry[]>(bridge, "covers", "list", [], ["covers.read"]),
		delete: (url: string) =>
			callService<boolean>(bridge, "covers", "delete", [{ url }], ["covers.write"]),
	};
}

function blocksProxy(bridge: Bridge): BlocksService {
	return {
		list: () => callService<BlockInfo[]>(bridge, "blocks", "list", [], ["blocks.read"]),
		resolve: (blockId: string) =>
			callService<BlockInfo | null>(bridge, "blocks", "resolve", [{ blockId }], ["blocks.read"]),
		source: (blockId: string) =>
			callService<string | null>(bridge, "blocks", "source", [{ blockId }], ["blocks.read"]),
		forType: (entityType: string) =>
			callService<string | null>(bridge, "blocks", "forType", [{ entityType }], ["blocks.read"]),
	};
}

function bpProxy(bridge: Bridge): BpService {
	// No caps: `bp.dispatch` is structural routing with no ambient
	// authority — the shell's per-module handlers enforce per-type grants
	// on the entities service downstream. The broker allows no-cap methods
	// (`broker-context.ts` checkCapability: "methods that declare no caps
	// are allowed; service handlers enforce method-level requirements").
	return {
		dispatch: (entityId: string, message: BpMessage) =>
			callService<BpMessage | null>(bridge, "bp", "dispatch", [{ entityId, payload: message }], []),
	};
}

/**
 * 6.10c — runtime-registered (dynamic) shortcuts + active-scope reporting.
 * The shell side lives in `packages/shell/src/main/shortcuts/shortcuts-service.ts`;
 * this proxy is the app-facing face. Capability: `shortcuts.register`
 * (default-granted at install).
 */
function shortcutsProxy(bridge: Bridge): ShortcutsService {
	return {
		register: (args: { additions: readonly ShortcutDeclaration[] }) =>
			callService<void>(
				bridge,
				"shortcuts",
				"register",
				[{ additions: args.additions }],
				["shortcuts.register"],
			),
		unregister: (args: { ids: readonly string[] }) =>
			callService<void>(
				bridge,
				"shortcuts",
				"unregister",
				[{ ids: args.ids }],
				["shortcuts.register"],
			),
		setActiveScope: (args: { scope: string | null }) =>
			callService<void>(
				bridge,
				"shortcuts",
				"setActiveScope",
				[{ scope: args.scope }],
				["shortcuts.register"],
			),
	};
}

function vaultEntitiesProxy(bridge: Bridge): VaultEntitiesService {
	return {
		// Wire identifier is `vault-entities` (lowercase + hyphen) because
		// the envelope validator only accepts `[a-z][a-z0-9-]*`. The proxy
		// itself is still exposed as `runtime.services.vaultEntities` to the
		// app — that's a JS property name and unconstrained.
		list: () =>
			callService<VaultEntitiesSnapshot>(bridge, "vault-entities", "list", [], ["entities.read:*"]),
		queryPattern: (pattern: GraphPatternWire) =>
			callService<PatternQueryResult>(
				bridge,
				"vault-entities",
				"queryPattern",
				[{ pattern }],
				["entities.read:*"],
			),
		querySource: (source: ListSource | null) =>
			callService<SourceQueryResult>(
				bridge,
				"vault-entities",
				"querySource",
				[{ source }],
				["entities.read:*"],
			),
		// No-op default. The preload overrides this with an IPC-backed
		// implementation that fires whenever a note write reaches the
		// storage worker (Settings → Data analogue for vault-entities).
		// Tests / non-Electron bridges keep the no-op.
		onChange: (_listener: () => void): Subscription => ({ unsubscribe: () => undefined }),
	};
}

/** Does the app hold the dispatch grant for `verb`? A grant is verb-scoped
 *  (`intents.dispatch:process`) or wildcard (`intents.dispatch:*`); an unscoped
 *  `intents.dispatch` never matches (mirrors the ledger's scope rule). */
function hasDispatchCap(capabilities: readonly string[], verb: string): boolean {
	return capabilities.some((c) => c === `intents.dispatch:${verb}` || c === "intents.dispatch:*");
}

function intentsProxy(bridge: Bridge, capabilities: readonly string[]): IntentsService {
	return {
		dispatch: async (intent: Omit<Intent, "source">): Promise<IntentResult | null> => {
			// The capability is verb-scoped (`intents.dispatch:open`,
			// `:share`, `:quick-look` …) — the ledger stores the grant with
			// the verb as scope, and an unscoped request never matches a
			// scoped grant, so the hint must carry the verb or every
			// dispatch is denied (cross-app open silently no-ops).
			const result = await callService<{ handled: boolean; value?: unknown } | null>(
				bridge,
				"intents",
				"dispatch",
				[{ verb: intent.verb, payload: intent.payload }],
				[`intents.dispatch:${intent.verb}`],
			);
			if (!result) return null;
			const out: IntentResult = { handled: result.handled };
			if (result.value !== undefined) out.value = result.value;
			return out;
		},
		suggest: async (intent: Omit<Intent, "source">): Promise<SuggestedIntentHandler[]> => {
			// Read-only "who can handle this" — gated on the same verb-scoped
			// grant as dispatch (an app that may open an object may also ask
			// which apps can open it, for the "Open with…" picker).
			const result = await callService<SuggestedIntentHandler[] | null>(
				bridge,
				"intents",
				"suggest",
				[{ verb: intent.verb, payload: intent.payload }],
				[`intents.dispatch:${intent.verb}`],
			);
			return result ?? [];
		},
		suggestActions: async (input: {
			target: ContributedActionTarget;
			verbs: readonly ContributedVerb[];
		}): Promise<ContributedAction[]> => {
			// The action surface (doc 63): the contributed actions other apps
			// offer on `target`. A contributed action renders in the host but
			// DISPATCHES from the host's renderer, so the host can only surface
			// (and later dispatch) a verb it actually holds the dispatch grant for
			// (doc 63 §Security — fail-closed; "not shown as enabled" when the host
			// can't authorize it). We narrow the requested verbs to the granted
			// ones (so an action the host couldn't dispatch is never shown) and
			// pass exactly those as the per-verb cap hints — the broker requires
			// EVERY declared cap, so an unheld-verb hint would deny the whole read.
			// No granted verb ⇒ no query, no denied error, just an empty surface.
			const dispatchable = input.verbs.filter((v) => hasDispatchCap(capabilities, v));
			if (dispatchable.length === 0) return [];
			const result = await callService<ContributedAction[] | null>(
				bridge,
				"intents",
				"suggestActions",
				[{ target: input.target, verbs: dispatchable }],
				dispatchable.map((v) => `intents.dispatch:${v}`),
			);
			return result ?? [];
		},
	};
}

function dashboardProxy(bridge: Bridge): DashboardService {
	// `dashboard.pin` is an unscoped default-minimum grant (see
	// default-grants.ts) — the hint carries the bare capability, no scope
	// segment. `isPinned` reads over the same grant: the object menu needs
	// the toggle state to label itself, so there is no separate read cap.
	return {
		pin: (target: { entityId: string }) =>
			callService<boolean>(bridge, "dashboard", "pin", [target], ["dashboard.pin"]),
		unpin: (target: { entityId: string }) =>
			callService<boolean>(bridge, "dashboard", "unpin", [target], ["dashboard.pin"]),
		isPinned: (target: { entityId: string }) =>
			callService<boolean>(bridge, "dashboard", "isPinned", [target], ["dashboard.pin"]),
	};
}

function iconsProxy(bridge: Bridge): IconsService {
	// Mirrors coversProxy — bytes go over the wire base64-encoded in an object
	// arg. `icons.read` for list, `icons.write` for upload/delete.
	return {
		uploadBytes: (filename: string, bytes: Uint8Array) =>
			callService<IconUploadResult>(
				bridge,
				"icons",
				"uploadBytes",
				[{ name: filename, bytesBase64: encodeBase64(bytes) }],
				["icons.write"],
			),
		list: () => callService<IconEntry[]>(bridge, "icons", "list", [], ["icons.read"]),
		delete: (url: string) =>
			callService<boolean>(bridge, "icons", "delete", [{ url }], ["icons.write"]),
	};
}

function exportProxy(bridge: Bridge): ExportService {
	// `export.print-to-pdf` is a default-minimum grant (exporting your own
	// content is benign; the shell renders it in a sandboxed, script-disabled,
	// network-blocked offscreen window). The capability string is lowercase-
	// hyphen per the envelope's CAPABILITY_PATTERN — the camelCase service
	// *method* (`printToPdf`) is separate and stays as-is.
	return {
		printToPdf: (input: { html: string }) =>
			callService<Uint8Array>(bridge, "export", "printToPdf", [input], ["export.print-to-pdf"]),
		// `caps: []` — serializeEntities is read-only + type-scoped: the shell
		// handler filters to entities the app may `entities.read` (no static gate).
		serializeEntities: (input) =>
			callService<string>(bridge, "export", "serializeEntities", [input], []),
	};
}

function importProxy(bridge: Bridge): ImportService {
	// `caps: []` — `import` is type-scoped (like `entities`): the shell handler
	// is the cap authority and checks `entities.write:<targetType>` against the
	// ledger, so there's no static per-call gate.
	return {
		preview: (request) =>
			callService<ImportPreviewResult>(bridge, "import", "preview", [request], []),
		plan: (request) => callService<ImportPlanResult>(bridge, "import", "plan", [request], []),
		run: (request) => callService<ImportRunResult>(bridge, "import", "run", [request], []),
	};
}

// ─── Base64 helpers (Buffer-free for renderer compat) ────────────────────────

function encodeBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) {
		bin += String.fromCharCode(bytes[i] ?? 0);
	}
	if (typeof btoa === "function") return btoa(bin);
	// Node fallback for tests
	return Buffer.from(bytes).toString("base64");
}

function decodeBase64(encoded: string): Uint8Array {
	if (typeof atob === "function") {
		const bin = atob(encoded);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}
	return new Uint8Array(Buffer.from(encoded, "base64"));
}
