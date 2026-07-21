/**
 * Deep-link extraction — the Browser is the registered in-vault opener for
 * `http`/`https`, so the shell delivers clicked links either as a
 * `deep-link` launch context (fresh launch) or as a pushed `open` intent
 * (already-running window). Both funnel through here; only web URLs pass
 * (a deep link must never smuggle `file:` / `javascript:` into a tab —
 * the shell's web-view scheme allowlist is the backstop, this is the
 * front door).
 */

import type { Intent, LaunchContext } from "@brainstorm-os/sdk-types";

const WEB_URL_PATTERN = /^https?:\/\//i;
const OPEN_VERB = "open";

export function isWebUrl(url: string): boolean {
	return WEB_URL_PATTERN.test(url);
}

export function externalUrlFromLaunch(launch: LaunchContext | null | undefined): string | null {
	if (!launch || launch.reason !== "deep-link") return null;
	return isWebUrl(launch.deepLink) ? launch.deepLink : null;
}

export function externalUrlFromIntent(intent: Intent | null | undefined): string | null {
	if (!intent || intent.verb !== OPEN_VERB) return null;
	const candidate = intent.payload.url ?? intent.payload.deepLink;
	return typeof candidate === "string" && isWebUrl(candidate) ? candidate : null;
}
