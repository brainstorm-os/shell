/**
 * Analytics event + property taxonomy. One place names the events and property
 * keys so they never drift as loose string literals scattered across call sites
 * (repo convention: no string discriminators — §CLAUDE.md). Wire values are the
 * enum values; renaming a name/key is a single edit here.
 */

/** Canonical product-analytics event names. */
export enum AnalyticsEvent {
	ApplicationStarted = "Application Started",
	AppLaunched = "App Launched",
	VaultOpened = "Vault Opened",
	VaultClosed = "Vault Closed",
	WelcomeViewed = "Welcome Viewed",
	/** A user-facing operation failed. Payload carries a normalized scope +
	 *  code only — never raw messages or paths (which embed the OS username). */
	ErrorEncountered = "Error Encountered",
}

/**
 * Canonical event / user-property key names (snake_case wire form). Dimensions
 * that can be normalized live here as properties rather than being baked into
 * distinct event names.
 */
export const AnalyticsProp = {
	Surface: "surface",
	Platform: "platform",
	OsVersion: "os_version",
	Arch: "arch",
	Locale: "locale",
	Language: "language",
	Region: "region",
	ShellVersion: "shell_version",
	AppId: "app_id",
	AppName: "app_name",
	AppVersion: "app_version",
	Source: "source",
	ErrorScope: "error_scope",
	ErrorCode: "error_code",
} as const;

/** Where a tracked error originated. */
export enum AnalyticsErrorScope {
	VaultCreate = "vault_create",
	VaultOpen = "vault_open",
	TemplateImport = "template_import",
	AppLaunch = "app_launch",
}

/**
 * Locale broken into the dimensions analytics cares about, derived from a BCP-47
 * tag (e.g. `en-US` → language `en`, region `US`). Region is a privacy-safe,
 * self-reported geography signal from OS settings — NOT IP geolocation, which we
 * deliberately leave off (see analytics/index.ts init).
 */
export type LocaleParts = {
	locale: string;
	language: string;
	region: string;
};

/** Split a BCP-47 locale tag into normalized language + region dimensions. */
export function parseLocale(tag: string | undefined | null): LocaleParts | null {
	const trimmed = tag?.trim();
	if (!trimmed) return null;
	const [languageRaw, ...rest] = trimmed.replace(/_/g, "-").split("-");
	const language = languageRaw?.toLowerCase() ?? "";
	if (!language) return null;
	// The region subtag is the first 2-letter (ISO-3166 alpha-2) or 3-digit
	// (UN M49) part after the language — skips script subtags like `Hans`.
	const region = rest.find((part) => /^[A-Za-z]{2}$|^\d{3}$/.test(part))?.toUpperCase() ?? "";
	const parts: LocaleParts = { locale: trimmed, language, region };
	return parts;
}
