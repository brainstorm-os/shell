import {
	AppearanceSlot,
	type AppearanceState,
	effectiveSlotFor,
} from "@brainstorm-os/protocol/appearance";
import { DEFAULT_THEME, ThemeName, flattenTokens, themes } from "@brainstorm-os/tokens";
import { type ReactNode, useEffect, useState } from "react";
import { onSystemPreferenceChange, systemPrefersDark } from "../dashboard/appearance-watcher";
import { useDashboard } from "../dashboard/use-dashboard";
import { useVaultMaybe } from "../vault-context";
import { typographyCssVars } from "./typography-vars";

// `brainstorm/Typography/v1` render-application (Stage 8.7): the frozen
// contract's SYSTEM default resolves every FontRole to a non-empty
// `--text-family-*`, applied as the BASE before theme tokens so the
// contract is the documented base layer. Constant (no bundled fonts,
// no user source until the Stage 9.9 theme-editor), precomputed once.
const TYPOGRAPHY_BASE = typographyCssVars(null);

// Flattened maps are static — the Tokens shape is uniform across every
// built-in theme, so we precompute once and skip the cleanup-then-reapply
// dance on each switch (the same keys get overwritten in place).
const FLATTENED: Record<ThemeName, Record<string, string>> = Object.fromEntries(
	Object.entries(themes).map(([id, tokens]) => [id, flattenTokens(tokens)]),
) as Record<ThemeName, Record<string, string>>;

/**
 * Binds a theme's CSS variables onto `:root`. Typography base first; per-theme
 * `text.family` tokens then compose over the family vars (Sepia's serif etc.
 * is preserved), while `--typography-scale` and any role a theme omits fall to
 * the contract default.
 */
export function applyThemeVars(theme: ThemeName): void {
	const root = document.documentElement;
	for (const [key, value] of Object.entries(TYPOGRAPHY_BASE)) {
		root.style.setProperty(key, value);
	}
	for (const [key, value] of Object.entries(FLATTENED[theme])) {
		root.style.setProperty(key, value);
	}
	root.dataset.theme = theme;
}

/**
 * The theme `:root` should carry: the active vault's effective theme while a
 * vault is open, or Default Light on the welcome screen (no open vault) so a
 * stale palette can't clash with the green-valley splash. `DEFAULT_THEME`
 * bridges the brief gap before the first snapshot arrives.
 *
 * The effective theme is resolved HERE from `appearance` + the live OS dark
 * preference — NOT read off the broadcast `snapshot.theme`. The store can't know
 * the renderer's OS preference, so its broadcast `snapshot.theme` falls back to
 * `defaultEffectiveSlot(mode)` (Auto→Dark always). Reading that left the
 * dashboard pinned to the wrong slot in Auto mode while app windows (which call
 * the OS-aware `activeTheme`) updated correctly — the "apps change, dashboard
 * doesn't" bug. Resolving via `effectiveSlotFor(mode, prefersDark)` makes the
 * dashboard track the same slot the apps do, so the appearance toggle (button +
 * shortcut) and OS light/dark changes repaint it.
 */
export function effectiveTheme(
	hasVault: boolean,
	appearance: AppearanceState | undefined,
	prefersDark: boolean,
): ThemeName {
	if (!hasVault) return ThemeName.DefaultLight;
	if (!appearance) return DEFAULT_THEME;
	const slot = effectiveSlotFor(appearance.mode, prefersDark);
	return (slot === AppearanceSlot.Dark ? appearance.dark : appearance.light).theme;
}

type Props = {
	children: ReactNode;
};

/**
 * The single authority for the `:root` theme variables. Reads the active theme
 * from the dashboard snapshot while a vault is open; with no open vault (the
 * welcome screen — the green-valley splash) it pins the Default Light theme so
 * a stale dark/sepia/solar palette can't clash with the welcome chrome. A
 * static base (`applyThemeVars(DEFAULT_THEME)` at renderer entry) covers the
 * error-boundary fallback, which renders outside this provider's subtree.
 */
export function ThemeProvider({ children }: Props) {
	// Tolerant read: the theme is the first vault consumer in the tree, so a
	// transiently missing context (HMR re-created it) must not crash the whole
	// shell — fall back to the no-vault pin and recover on the next render.
	const current = useVaultMaybe()?.current ?? null;
	const snapshot = useDashboard();
	const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());
	useEffect(() => onSystemPreferenceChange(setPrefersDark), []);
	const theme = effectiveTheme(current !== null, snapshot?.appearance, prefersDark);

	useEffect(() => {
		applyThemeVars(theme);
	}, [theme]);

	// Fast-path repaint. The shell resolves its theme from the entity-pin-enriched
	// `dashboard:snapshot`, which awaits a DB read on a pinned dashboard — so a
	// light/dark toggle flipped the app windows instantly (they get a synchronous
	// `app:theme-changed` push) while the shell lagged until enrichment resolved
	// ("works in the apps, but the shell doesn't change immediately"). The main
	// process now pushes the resolved theme name to the dashboard on that same
	// signal; apply it the moment it arrives. Gated on an open vault so it never
	// overrides the welcome-screen Default Light pin; the snapshot-derived effect above
	// stays the source of truth and re-applies the same value idempotently.
	useEffect(() => {
		const onTheme = window.brainstorm?.dashboard?.onTheme;
		if (!onTheme || current === null) return;
		return onTheme((pushed) => applyThemeVars(pushed));
	}, [current]);

	// Transient cross-surface theme preview (9.9.6). A sanitized payload paints
	// preview token overrides inline (winning over the committed inline vars);
	// `null` reverts by re-applying the committed theme (which re-sets every
	// token, overwriting the overrides). Values arrive pre-sanitized; still set
	// via CSSOM `setProperty` (never string-built) as defence in depth.
	useEffect(() => {
		const onPreview = window.brainstorm?.dashboard?.onThemePreview;
		if (!onPreview) return;
		return onPreview((payload) => {
			if (!payload) {
				applyThemeVars(theme);
				return;
			}
			const root = document.documentElement;
			for (const [key, value] of Object.entries(payload.vars ?? {})) {
				root.style.setProperty(key, value);
			}
		});
	}, [theme]);

	return <>{children}</>;
}
