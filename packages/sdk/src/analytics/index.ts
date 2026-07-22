/**
 * Client-side product analytics — Amplitude Browser SDK wrapper.
 * Initializes once per renderer process; safe to call from every app entry.
 *
 * Identity posture (beta):
 *   - One stable anonymous **install** id as Amplitude `deviceId` (from the
 *     shell preload / main-process installationId). Not a user id, vault id,
 *     or device Ed25519 key.
 *   - Packaged builds only: main hands the id out solely when
 *     `app.isPackaged`, so dev, CI and Playwright shells — which get a fresh
 *     `--user-data-dir` (and thus a fresh installationId) per run — never
 *     register as Amplitude users. No id, no init.
 *   - Never sets Amplitude `userId`.
 *   - Never sends vault / identity / key material in event properties.
 *   - API key is module-private and never exported or attached to events.
 *
 * The SDK is dynamically imported so session replay + autocapture land in a
 * separate chunk (the shell renderer's `index-*.js` size budget is tight).
 */

import { isPublicBeta } from "./beta";
import {
	type AnalyticsErrorScope,
	AnalyticsEvent,
	AnalyticsProp,
	type LocaleParts,
	parseLocale,
} from "./events";

export {
	AnalyticsErrorScope,
	AnalyticsEvent,
	AnalyticsProp,
	parseLocale,
} from "./events";
export { isPublicBeta } from "./beta";
export {
	BETA_ANALYTICS_NOTICE_ID,
	hasDismissedBetaAnalyticsNotice,
	markBetaAnalyticsNoticeDismissed,
} from "./beta-notice-storage";
export {
	AMPLITUDE_EU_CONNECT_SRC,
	AMPLITUDE_EU_SCRIPT_SRC,
	AMPLITUDE_WORKER_SRC,
} from "./csp";

/**
 * Amplitude project write key — module-private. Client-side write keys are not
 * auth secrets, but we still refuse to export them on the package surface or
 * attach them to events / identify payloads.
 */
function amplitudeApiKey(): string {
	return "691a93081b9b1af38116b0655eb17bd9";
}

/** Property names that must never leave the device via analytics. */
const BLOCKED_EVENT_KEYS = new Set([
	"vault_id",
	"vaultId",
	"user_id",
	"userId",
	"email",
	"api_key",
	"apiKey",
	"public_key",
	"publicKey",
	"device_id",
	"deviceId",
	"installation_id",
	"installationId",
	"identity",
	"private_key",
	"privateKey",
]);

let initialized = false;
let analyticsEnabled = false;
let initPromise: Promise<void> | null = null;
type AmplitudeModule = typeof import("@amplitude/unified");
let amplitudeModule: AmplitudeModule | null = null;

type AnalyticsBridge = {
	version?: string;
	platform?: string;
	osVersion?: string;
	arch?: string;
	/** Anonymous install id from main (preferred Amplitude deviceId). */
	analyticsDeviceId?: string;
	app?: { id?: string; version?: string; name?: string };
};

type AnalyticsContext = {
	surface: "shell" | "app";
	appId?: string;
	appName?: string;
	appVersion?: string;
	platform?: string;
	osVersion?: string;
	arch?: string;
	shellVersion?: string;
	locale?: LocaleParts;
};

function readBridge(): AnalyticsBridge | null {
	if (typeof window === "undefined") return null;
	return (window as Window & { brainstorm?: AnalyticsBridge }).brainstorm ?? null;
}

/**
 * Stable anonymous device id for this install — the main-process
 * installation id handed through the preload bridge. Main exposes it only
 * in packaged builds; an empty result means analytics must stay off (no
 * local fallback — minting an id here is exactly how ephemeral dev / CI
 * shells would masquerade as new users).
 */
export function resolveAnalyticsDeviceId(bridge: AnalyticsBridge | null = readBridge()): string {
	return bridge?.analyticsDeviceId?.trim() ?? "";
}

/** OS locale (BCP-47) from the renderer — a privacy-safe geography/language
 *  signal that needs no IP geolocation. */
function readLocaleTag(): string | undefined {
	if (typeof navigator === "undefined") return undefined;
	return navigator.language || navigator.languages?.[0];
}

function readContext(): AnalyticsContext {
	const bridge = readBridge();
	const locale = parseLocale(readLocaleTag());
	const base: AnalyticsContext = { surface: "shell" };
	if (locale) base.locale = locale;
	if (!bridge) return base;
	if (bridge.platform) base.platform = bridge.platform;
	if (bridge.osVersion) base.osVersion = bridge.osVersion;
	if (bridge.arch) base.arch = bridge.arch;
	if (bridge.version) base.shellVersion = bridge.version;
	const app = bridge.app;
	if (!app?.id) return base;
	const context: AnalyticsContext = { ...base, surface: "app", appId: app.id };
	if (app.name) context.appName = app.name;
	if (app.version) context.appVersion = app.version;
	return context;
}

/**
 * Normalized context attached to EVERY event so any event (launch, error, …)
 * is segmentable by version / os / locale without relying on user-property
 * back-fill. Keys are the canonical `AnalyticsProp` names.
 */
function contextProps(context: AnalyticsContext): Record<string, string> {
	const props: Record<string, string> = { [AnalyticsProp.Surface]: context.surface };
	if (context.platform) props[AnalyticsProp.Platform] = context.platform;
	if (context.osVersion) props[AnalyticsProp.OsVersion] = context.osVersion;
	if (context.arch) props[AnalyticsProp.Arch] = context.arch;
	if (context.locale) {
		props[AnalyticsProp.Locale] = context.locale.locale;
		if (context.locale.language) props[AnalyticsProp.Language] = context.locale.language;
		if (context.locale.region) props[AnalyticsProp.Region] = context.locale.region;
	}
	if (context.shellVersion) props[AnalyticsProp.ShellVersion] = context.shellVersion;
	if (context.appId) props[AnalyticsProp.AppId] = context.appId;
	if (context.appName) props[AnalyticsProp.AppName] = context.appName;
	if (context.appVersion) props[AnalyticsProp.AppVersion] = context.appVersion;
	return props;
}

/** Drop identity / key material from event property bags. */
export function sanitizeEventProperties(
	properties?: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean> {
	const cleaned: Record<string, string | number | boolean> = {};
	if (!properties) return cleaned;
	for (const [key, value] of Object.entries(properties)) {
		if (value === undefined || value === null) continue;
		if (BLOCKED_EVENT_KEYS.has(key)) continue;
		cleaned[key] = value;
	}
	return cleaned;
}

async function ensureInitialized(): Promise<AmplitudeModule | null> {
	if (typeof window === "undefined") return null;
	if (amplitudeModule) return amplitudeModule;
	if (!initPromise) {
		initPromise = (async () => {
			const apiKey = amplitudeApiKey();
			const deviceId = resolveAnalyticsDeviceId();
			const amplitude = await import("@amplitude/unified");
			// deviceId only — never userId. trackingOptions.ipAddress off so
			// Amplitude does not reverse-geolocate the install.
			await amplitude.initAll(apiKey, {
				serverZone: "EU",
				analytics: {
					autocapture: true,
					deviceId,
					identityStorage: "localStorage",
					trackingOptions: {
						ipAddress: false,
					},
				},
				sessionReplay: { sampleRate: 1 },
			});

			// Non-identifying product context only — no vault, user, or keys.
			const userProps = contextProps(readContext());
			const identify = new amplitude.Identify();
			for (const [key, value] of Object.entries(userProps)) {
				identify.set(key, value);
			}
			amplitude.identify(identify);
			amplitude.track(AnalyticsEvent.ApplicationStarted, userProps);
			amplitudeModule = amplitude;
		})().catch((error: unknown) => {
			initPromise = null;
			console.warn("[brainstorm] analytics init failed:", error);
		});
	}
	await initPromise;
	return amplitudeModule;
}

/** Whether analytics is active in this renderer (public beta builds only). */
export function isAnalyticsEnabled(): boolean {
	return analyticsEnabled;
}

/** Initialize Amplitude analytics + session replay once for this renderer. */
export function initAnalytics(): void {
	if (initialized || typeof window === "undefined") return;
	initialized = true;
	const bridge = readBridge();
	const version = bridge?.version ?? "0.0.0";
	// Two gates: pre-1.0 public beta AND a packaged-shell install id.
	analyticsEnabled = isPublicBeta(version) && resolveAnalyticsDeviceId(bridge).length > 0;
	if (!analyticsEnabled) return;
	void ensureInitialized();
}

/**
 * Track a named product event. No-ops until initialization completes. Every
 * event is enriched with normalized context (version / os / locale / app) so
 * any event is segmentable without relying on user-property back-fill;
 * explicit `properties` win over context on a key clash.
 */
export function track(
	event: AnalyticsEvent | string,
	properties?: Record<string, string | number | boolean | null | undefined>,
): void {
	if (!analyticsEnabled || !initialized || typeof window === "undefined") return;
	const cleaned = sanitizeEventProperties({ ...contextProps(readContext()), ...properties });
	void ensureInitialized().then((amplitude) => {
		amplitude?.track(event, cleaned);
	});
}

/**
 * Report a user-facing failure as a normalized `Error Encountered` event.
 * Only a stable `scope` + `code` (and optional pre-normalized extras) are sent
 * — never raw error messages or paths, which embed the OS username and other
 * PII. Callers classify the raw error into a code before calling.
 */
export function trackError(
	scope: AnalyticsErrorScope,
	code: string,
	extra?: Record<string, string | number | boolean | null | undefined>,
): void {
	track(AnalyticsEvent.ErrorEncountered, {
		...extra,
		[AnalyticsProp.ErrorScope]: scope,
		[AnalyticsProp.ErrorCode]: code,
	});
}
