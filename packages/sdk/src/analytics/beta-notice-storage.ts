/** Bump when the beta analytics copy changes so users see the new notice. */
export const BETA_ANALYTICS_NOTICE_ID = "beta-analytics-v1";

const STORAGE_KEY = "brainstorm.analytics.betaNoticeDismissed";

export function hasDismissedBetaAnalyticsNotice(): boolean {
	if (typeof window === "undefined") return true;
	try {
		return window.localStorage.getItem(STORAGE_KEY) === BETA_ANALYTICS_NOTICE_ID;
	} catch {
		return true;
	}
}

export function markBetaAnalyticsNoticeDismissed(): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, BETA_ANALYTICS_NOTICE_ID);
	} catch {
		// localStorage unavailable — the popover may reappear next launch.
	}
}
