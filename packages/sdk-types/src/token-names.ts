/**
 * Canonical semantic-token namespace — the frozen set of `--kebab` CSS
 * variable names a `brainstorm/TokenSet/v1` may override (
 * theme-store.md §Validation: "A token set defines only known semantic
 * tokens; unknown token names are rejected").
 *
 * This is a **snapshot** of `Object.keys(flattenTokens(defaultLight))`
 * from `@brainstorm/tokens`. It lives here (not in the tokens package)
 * so the sdk-types contracts stay dependency-free — `token-set.ts` can
 * validate namespace membership without importing the tokens runtime.
 * A drift guard in `packages/tokens/src/token-names.test.ts` pins this
 * list against the live `flattenTokens` output so it never goes stale.
 *
 * Mirrors the `CANONICAL_ICON_NAMES` / `isCanonicalIconName` precedent
 * in `icon-pack.ts`. Leaf module — no imports beyond `./enum-guard`.
 */

import { enumGuard } from "./enum-guard";

/** Bumped whenever the canonical token namespace changes shape, so a
 *  TokenSet authored against an older namespace can be detected. */
export const TOKEN_NAME_VERSION = 2;

/**
 * Every legal semantic-token CSS variable name, sorted. A `TokenSet`'s
 * `overrides` keys must each be a member of this set. Snapshot of the
 * `@brainstorm/tokens` flattened key space (pinned by the tokens-package
 * drift test).
 */
export const CANONICAL_TOKEN_NAMES = Object.freeze([
	"--border-width",
	"--border-width-thick",
	"--color-accent-default",
	"--color-accent-on-surface",
	"--color-accent-strong",
	"--color-accent-subtle",
	"--color-accent-text",
	"--color-background-elevated",
	"--color-background-inverse",
	"--color-background-primary",
	"--color-background-subtle",
	"--color-border-default",
	"--color-border-strong",
	"--color-border-subtle",
	"--color-chrome-background",
	"--color-chrome-text",
	"--color-dimmer",
	"--color-focus-ring",
	"--color-glass-background",
	"--color-glass-background-strong",
	"--color-glass-background-subtle",
	"--color-glass-border",
	"--color-gloss-bottom",
	"--color-gloss-inner-bottom",
	"--color-gloss-inner-top",
	"--color-gloss-shine-bottom",
	"--color-gloss-shine-top",
	"--color-gloss-top",
	"--color-graph-edge-matched",
	"--color-graph-edge-unmatched",
	"--color-graph-subject-1",
	"--color-graph-subject-2",
	"--color-graph-subject-3",
	"--color-graph-subject-4",
	"--color-graph-subject-5",
	"--color-graph-subject-6",
	"--color-graph-subject-7",
	"--color-graph-subject-8",
	"--color-graph-unmatched",
	"--color-interactive-active",
	"--color-interactive-hover",
	"--color-shadow-default",
	"--color-shadow-strong",
	"--color-shadow-subtle",
	"--color-state-error",
	"--color-state-info",
	"--color-state-success",
	"--color-state-warning",
	"--color-surface-default",
	"--color-surface-overlay",
	"--color-text-inverse",
	"--color-text-link",
	"--color-text-primary",
	"--color-text-secondary",
	"--color-text-shadow-on-glass",
	"--color-text-tertiary",
	"--control-height-lg",
	"--control-height-md",
	"--control-height-sm",
	"--glass-blur",
	"--glass-saturate",
	"--motion-duration-deliberate",
	"--motion-duration-fast",
	"--motion-duration-instant",
	"--motion-duration-normal",
	"--motion-duration-slow",
	"--motion-easing-decelerated",
	"--motion-easing-emphasized",
	"--motion-easing-linear",
	"--motion-easing-standard",
	"--radius-full",
	"--radius-lg",
	"--radius-md",
	"--radius-none",
	"--radius-sm",
	"--radius-xl",
	"--radius-xs",
	"--shadow-lg",
	"--shadow-md",
	"--shadow-none",
	"--shadow-sm",
	"--shadow-xl",
	"--space-0",
	"--space-0_5",
	"--space-1",
	"--space-2",
	"--space-3",
	"--space-4",
	"--space-5",
	"--space-6",
	"--space-7",
	"--space-8",
	"--text-family-body",
	"--text-family-code",
	"--text-family-display",
	"--text-family-ui",
	"--text-line-height-normal",
	"--text-line-height-relaxed",
	"--text-line-height-tight",
	"--text-size-2xl",
	"--text-size-3xl",
	"--text-size-display",
	"--text-size-lg",
	"--text-size-md",
	"--text-size-sm",
	"--text-size-xl",
	"--text-size-xs",
	"--text-weight-bold",
	"--text-weight-medium",
	"--text-weight-regular",
	"--text-weight-semibold",
	"--z-base",
	"--z-command-palette",
	"--z-dropdown",
	"--z-modal",
	"--z-overlay",
	"--z-popover",
	"--z-sticky",
	"--z-toast",
	"--z-window-controls-overlay",
]) as readonly string[];

/** `true` iff `name` is a member of the canonical token namespace. */
export const isCanonicalTokenName = enumGuard(CANONICAL_TOKEN_NAMES);
