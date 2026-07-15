/**
 * CSP host sources required by the beta Amplitude stack (serverZone: EU).
 *
 * Used by product analytics (`@amplitude/unified`): event API, remote config,
 * session replay, and the engagement CDN script. Keep every renderer CSP that
 * calls `initAnalytics()` in sync — see `csp.test.ts`.
 */

/** `connect-src` host for EU event API, remote config, and session-replay upload. */
export const AMPLITUDE_EU_CONNECT_SRC = "https://*.eu.amplitude.com";

/** `script-src` host for the Engagement (Guides & Surveys) browser bundle. */
export const AMPLITUDE_EU_SCRIPT_SRC = "https://cdn.eu.amplitude.com";

/**
 * `worker-src` for Amplitude's track-destination + compression blob workers.
 * Without this the SDK falls back to main-thread sending (noisy console errors).
 */
export const AMPLITUDE_WORKER_SRC = "'self' blob:";
