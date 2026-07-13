/**
 * Client-side product analytics — Amplitude Browser SDK wrapper.
 * Initializes once per renderer process; safe to call from every app entry.
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

const AMPLITUDE_API_KEY = "691a93081b9b1af38116b0655eb17bd9";

let initialized = false;
let analyticsEnabled = false;
let initPromise: Promise<void> | null = null;
type AmplitudeModule = typeof import("@amplitude/unified");
let amplitudeModule: AmplitudeModule | null = null;

type AnalyticsBridge = {
	version?: string;
	platform?: string;
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

async function ensureInitialized(): Promise<AmplitudeModule | null> {
	if (typeof window === "undefined") return null;
	if (amplitudeModule) return amplitudeModule;
	if (!initPromise) {
		initPromise = (async () => {
			const amplitude = await import("@amplitude/unified");
			amplitude.initAll(AMPLITUDE_API_KEY, {
				serverZone: "EU",
				analytics: { autocapture: true },
				sessionReplay: { sampleRate: 1 },
			});

			const context = readContext();
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
	const cleaned: Record<string, string | number | boolean> = {};
	if (properties) {
		for (const [key, value] of Object.entries(properties)) {
			if (value !== undefined && value !== null) cleaned[key] = value;
		}
	}
	void ensureInitialized().then((amplitude) => {
		amplitude?.track(event, cleaned);
	});
}