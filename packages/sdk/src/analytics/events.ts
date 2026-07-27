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
	// `bs_` on the five that collide with Amplitude BUILT-IN fields. Amplitude
	// derives its own platform / os_version / language / region (and owns
	// app_version), so writing those names shadowed the real ones and made the
	// stock charts unreadable: Version Composition showed the SANDBOXED APP's
	// version (0.1.0) for app renderers and `(none)` for shell renderers, so the
	// actual shell release appeared nowhere. `region` was the most misleading —
	// Amplitude's is geo-from-IP, which we deliberately disable, while ours is
	// OS-locale-derived, so charts read like geolocation and were not.
	//
	// The other nine names are NOT prefixed on purpose: they collide with
	// nothing, so renaming them would break historical continuity for zero
	// correctness gain. Enforced by RESERVED_AMPLITUDE_FIELDS below.
	Platform: "bs_platform",
	OsVersion: "bs_os_version",
	Arch: "arch",
	Locale: "locale",
	Language: "bs_language",
	Region: "bs_region",
	ShellVersion: "shell_version",
	AppId: "app_id",
	AppName: "app_name",
	AppVersion: "bs_app_version",
	Source: "source",
	ErrorScope: "error_scope",
	ErrorCode: "error_code",
} as const;

/**
 * Fields Amplitude populates itself. Writing a custom property with one of
 * these names shadows the built-in in the UI: the stock chart silently reports
 * OUR value instead of Amplitude's, which is how "Version Composition" ended up
 * showing per-app versions and `(none)`.
 *
 * Pinned by `events.test.ts` — a new `AnalyticsProp` using a reserved name
 * fails the suite instead of quietly corrupting a dashboard months later.
 */
export const RESERVED_AMPLITUDE_FIELDS: readonly string[] = [
	"app_version",
	"platform",
	"os_name",
	"os_version",
	"language",
	"country",
	"region",
	"city",
	"dma",
	"carrier",
	"device_id",
	"device_brand",
	"device_manufacturer",
	"device_model",
	"device_type",
	"ip",
	"library",
	"version_name",
	"start_version",
	"user_id",
	"session_id",
	"event_id",
	"insert_id",
	"event_type",
	"revenue",
	"price",
	"quantity",
	"location_lat",
	"location_lng",
];

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
