/**
 * Client-side product analytics — Amplitude Browser SDK wrapper.
 * Initializes once per renderer process; safe to call from every app entry.
 *
 * Identity posture (beta):
 *   - One stable anonymous **install** id as Amplitude `deviceId` (from the
 *     shell preload / main-process installationId). Not a user id, vault id,
 *     or device Ed25519 key.
 *   - Never sets Amplitude `userId`.
 *   - Never sends vault / identity / key material in event properties.
 *   - API key is module-private and never exported or attached to events.
 *
 * The SDK is dynamically imported so session replay + autocapture land in a
 * separate chunk (the shell renderer's `index-*.js` size budget is tight).
 */

import { isPublicBeta } from "./beta";

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

const FALLBACK_DEVICE_STORAGE_KEY = "brainstorm.analytics.deviceId";

let initialized = false;
let analyticsEnabled = false;
let initPromise: Promise<void> | null = null;
type AmplitudeModule = typeof import("@amplitude/unified");
let amplitudeModule: AmplitudeModule | null = null;

type AnalyticsBridge = {
	version?: string;
	platform?: string;
	/** Anonymous install id from main (preferred Amplitude deviceId). */
	analyticsDeviceId?: string;
	app?: { id?: string; version?: string };
};

type AnalyticsContext = {
	surface: "shell" | "app";
	appId?: string;
	appVersion?: string;
	platform?: string;
	shellVersion?: string;
};

function readBridge(): AnalyticsBridge | null {
	if (typeof window === "undefined") return null;
	return (window as Window & { brainstorm?: AnalyticsBridge }).brainstorm ?? null;
}

/**
 * Stable anonymous device id for this install. Prefer the main-process
 * installation id (same value for every renderer). Fall back to a
 * localStorage-minted UUID only when the bridge is missing (tests / edge).
 */
export function resolveAnalyticsDeviceId(bridge: AnalyticsBridge | null = readBridge()): string {
	const fromBridge = bridge?.analyticsDeviceId?.trim();
	if (fromBridge && fromBridge.length > 0) return fromBridge;

	const storage =
		typeof window !== "undefined" && window.localStorage
			? window.localStorage
			: typeof localStorage !== "undefined"
				? localStorage
				: null;
	if (storage) {
		const existing = storage.getItem(FALLBACK_DEVICE_STORAGE_KEY);
		if (existing && existing.length > 0) return existing;
		const minted =
			typeof window !== "undefined" &&
			window.crypto &&
			typeof window.crypto.randomUUID === "function"
				? window.crypto.randomUUID()
				: typeof crypto !== "undefined" && "randomUUID" in crypto
					? crypto.randomUUID()
					: `bs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
		try {
			storage.setItem(FALLBACK_DEVICE_STORAGE_KEY, minted);
		} catch {
			// private mode / quota — still return the minted id for this session
		}
		return minted;
	}

	return `bs-ephemeral-${Date.now().toString(36)}`;
}

function readContext(): AnalyticsContext {
	const bridge = readBridge();
	if (!bridge) return { surface: "shell" };
	const base: AnalyticsContext = { surface: "shell" };
	if (bridge.platform) base.platform = bridge.platform;
	if (bridge.version) base.shellVersion = bridge.version;
	const app = bridge.app;
	if (!app?.id) return base;
	const context: AnalyticsContext = { ...base, surface: "app", appId: app.id };
	if (app.version) context.appVersion = app.version;
	return context;
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

			const context = readContext();
			// Non-identifying product context only — no vault, user, or keys.
			const userProps: Record<string, string> = { surface: context.surface };
			if (context.platform) userProps.platform = context.platform;
			if (context.shellVersion) userProps.shell_version = context.shellVersion;
			if (context.appId) userProps.app_id = context.appId;
			if (context.appVersion) userProps.app_version = context.appVersion;

			const identify = new amplitude.Identify();
			for (const [key, value] of Object.entries(userProps)) {
				identify.set(key, value);
			}
			amplitude.identify(identify);
			amplitude.track("Application Started", userProps);
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
	const version = readBridge()?.version ?? "0.0.0";
	analyticsEnabled = isPublicBeta(version);
	if (!analyticsEnabled) return;
	void ensureInitialized();
}

/** Track a named product event. No-ops until initialization completes. */
export function track(
	event: string,
	properties?: Record<string, string | number | boolean | null | undefined>,
): void {
	if (!analyticsEnabled || !initialized || typeof window === "undefined") return;
	const cleaned = sanitizeEventProperties(properties);
	void ensureInitialized().then((amplitude) => {
		amplitude?.track(event, cleaned);
	});
}
