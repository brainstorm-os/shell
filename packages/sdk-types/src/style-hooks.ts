/**
 * The frozen `data-bs-region` hook contract (OQ-183) — the documented,
 * stable attribute surface on user-visible shell + app chrome that
 * `brainstorm/StylePack/v1` raw-CSS authors target with selectors instead
 * of private class names (which churn on every refactor).
 *
 * A StylePack writes e.g. `[data-bs-region="dashboard-header"] { … }` and
 * is guaranteed that anchor stays put across releases. The shell + SDK
 * stamp `data-bs-region="<value>"` on the corresponding chrome root; a
 * structural guard (`style-hooks.guard.test`) asserts every value here is
 * actually present in the rendered chrome, so a refactor can't silently
 * drop a hook the contract promises.
 *
 * This is a **contract freeze** — adding a region is additive and safe;
 * removing or renaming one is a breaking change to published StylePacks
 * and bumps `STYLE_HOOK_VERSION`. Dependency-free leaf, barrel-re-exported.
 */

import { enumGuard } from "./enum-guard";

/** The HTML attribute carrying a chrome region's stable hook name. */
export const STYLE_HOOK_ATTR = "data-bs-region";

/** Bumped only when a region is removed/renamed (a breaking change to
 *  published StylePacks). Additions don't bump it. */
export const STYLE_HOOK_VERSION = 1;

/**
 * The frozen region vocabulary. Grouped by surface; values are kebab-case
 * and namespaced by surface so a StylePack author can target a whole
 * surface or a sub-region. Keep alphabetical within each group.
 */
export const STYLE_HOOK_REGIONS = Object.freeze([
	// App frame (shared @brainstorm-os/sdk app-theme chrome — every app).
	"app-header",
	"app-header-left",
	"app-header-right",
	"app-header-title",
	// Dashboard shell.
	"dashboard",
	"dashboard-body",
	"dashboard-header",
	"dashboard-header-left",
	"dashboard-header-right",
	"dashboard-tray",
	// Lock screen.
	"lock-screen",
	// Shared Popover / dialog primitive (Settings, Marketplace, Bin, Help, …).
	"popover",
	"popover-backdrop",
	"popover-panel",
	// Settings overlay.
	"settings",
	"settings-main",
	"settings-sidebar",
]) as readonly string[];

/** `true` iff `name` is a member of the frozen hook vocabulary. */
export const isStyleHookRegion = enumGuard(STYLE_HOOK_REGIONS);
