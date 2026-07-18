import { track } from "@brainstorm/sdk/analytics";

export function trackAppLaunch(appId: string, source: string): void {
	track("App Launched", { app_id: appId, source });
}

export function launchApp(appId: string, source: string): void {
	trackAppLaunch(appId, source);
	void window.brainstorm.apps.launch(appId);
}
