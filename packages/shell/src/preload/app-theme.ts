/**
 * Per-app icon-chip variables, pushed at runtime.
 *
 * The shared component CSS — aliases, glass, buttons, find-bar, header-nav,
 * panel-toggle, icon-pick, searchbar, resize-suppress, app-header drag
 * region — lives in `@brainstorm-os/sdk/app-theme.css` and is BUNDLED INTO
 * EACH APP at build time (apps import it from their TS entry). The only
 * piece that varies per app is the `.app-header__icon` chip face (URL +
 * palette gradient keyed on appId), and the shared CSS reads it from
 * four `:root` custom properties. This module emits the per-app values
 * for those properties.
 *
 * Theme TOKEN VALUES (`--color-*`, `--text-*`, …) are still pushed at
 * runtime by `app-preload.ts` because the user can switch themes without
 * rebuilding apps.
 */

import { type IconGradient, gradientFor } from "../shared/app-icon-palette";

export const APP_THEME_STYLE_ID = "brainstorm-app-theme";

/**
 * Returns the four `:root` custom properties that pin `.app-header__icon`
 * to this app's declared icon + palette gradient fallback. The shared
 * `@brainstorm-os/sdk/app-theme.css` reads them via `var(--app-icon-*)`.
 */
export function buildAppIconVarsCss(appId: string): string {
	const g = gradientFor(appId);
	return `:root {\n${appIconVarLines(appId, g).join("\n")}\n}`;
}

/**
 * Same four values as a pair list — for inlining onto
 * `document.documentElement.style` (the fastest paint path, used by
 * `app-preload.ts` alongside the `<style>` fallback).
 */
export function appIconVarPairs(appId: string): [string, string][] {
	const g = gradientFor(appId);
	return [
		["--app-icon-image", `url("brainstorm://app-icon/${encodeURIComponent(appId)}")`],
		["--app-icon-grad-from", g.from],
		["--app-icon-grad-to", g.to],
		["--app-icon-ink", g.ink],
	];
}

function appIconVarLines(appId: string, g: IconGradient): string[] {
	return [
		`\t--app-icon-image: url("brainstorm://app-icon/${encodeURIComponent(appId)}");`,
		`\t--app-icon-grad-from: ${g.from};`,
		`\t--app-icon-grad-to: ${g.to};`,
		`\t--app-icon-ink: ${g.ink};`,
	];
}
