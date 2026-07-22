import { AnalyticsEvent, AnalyticsProp, track } from "@brainstorm-os/sdk/analytics";

/**
 * id → human name cache so `App Launched` carries a normalized `app_name`
 * property regardless of which surface triggered the launch. The launch itself
 * is one unified event keyed on `app_id`; the name is a convenience dimension.
 */
const appNames = new Map<string, string>();

/** Feed the id→name cache from an installed-apps list (launcher / app grid). */
export function rememberAppNames(apps: readonly { id: string; name: string }[]): void {
	for (const app of apps) appNames.set(app.id, app.name);
}

// Best-effort prime at module load so early dashboard-icon launches resolve a
// name before any surface has fetched the installed list itself.
if (typeof window !== "undefined") {
	void window.brainstorm?.apps
		?.listInstalled?.()
		.then(rememberAppNames)
		.catch(() => {});
}

export function trackAppLaunch(appId: string, source: string, appName?: string): void {
	const name = appName ?? appNames.get(appId);
	const props: Record<string, string> = {
		[AnalyticsProp.AppId]: appId,
		[AnalyticsProp.Source]: source,
	};
	if (name) props[AnalyticsProp.AppName] = name;
	track(AnalyticsEvent.AppLaunched, props);
}

export function launchApp(appId: string, source: string, appName?: string): void {
	trackAppLaunch(appId, source, appName);
	void window.brainstorm.apps.launch(appId);
}
