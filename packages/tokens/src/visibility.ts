/**
 * Visibility preferences (12.18) expressed as token arithmetic, so a
 * preference lands identically in the shell renderer and every app renderer —
 * both already paint a theme by setting flattened `--color-…` vars inline on
 * `:root`, which means a stylesheet rule cannot override them. A preference is
 * therefore a second inline layer applied after the theme, computed FROM that
 * theme: every override names a token the theme already defines, and every
 * value is one of the theme's own colours (or a stronger alpha of it), so the
 * result is still a valid, theme-coherent token set.
 *
 * Text-cursor emphasis and always-visible scrollbars need no override layer —
 * they are attribute-scoped CSS rules over the `color.emphasis.*` tokens every
 * theme carries; see `DisplayAttribute`.
 */

import type { Tokens } from "./tokens";

/** Root `data-*` attributes the visibility preferences stamp on `<html>`. The
 *  shell renderer and the app preload both write these, and both stylesheets
 *  (`renderer/styles.css`, SDK `app-theme.css`) key their rules off them. */
export enum DisplayAttribute {
	Contrast = "data-bs-contrast",
	TextEmphasis = "data-bs-text-emphasis",
	Scrollbars = "data-bs-scrollbars",
	/** Auto-hide sidebars (7.15) — read by `@brainstorm-os/sdk/panel-toggle`
	 *  `useAutoHidePanel`; a layout preference, so it carries no tokens. */
	AutoHideSidebars = "data-bs-autohide-sidebars",
}

/** The single value each attribute carries while its preference is on; the
 *  attribute is removed entirely while it is off. */
export enum DisplayAttributeValue {
	More = "more",
	On = "on",
	Always = "always",
}

const ACCENT_SUBTLE_BOOST = 2;
const ACCENT_SUBTLE_MAX_ALPHA = 0.4;

/**
 * Inline token overrides for "Higher contrast", derived from `tokens`. Each
 * hierarchy step moves one rung up — subtle borders take the default border,
 * default borders take the strong one, strong borders take tertiary text
 * (which the contrast ratchet already holds at 3:1 on the page, so a strong
 * border clears the WCAG 1.4.11 non-text bar), and tertiary text takes
 * secondary (inactive tab labels, disabled-switch captions, hints). The active
 * sidebar/nav fill (`accent.subtle`) doubles its alpha.
 */
export function higherContrastOverrides(tokens: Tokens): Record<string, string> {
	const { border, text, accent, background } = tokens.color;
	const page = background.primary;
	return {
		"--color-border-subtle": stronger(border.default, border.subtle, page),
		"--color-border-default": stronger(border.strong, border.default, page),
		"--color-border-strong": stronger(text.tertiary, border.strong, page),
		"--color-text-tertiary": stronger(text.secondary, text.tertiary, page),
		"--color-accent-subtle": boostAlpha(accent.subtle),
	};
}

type Rgba = { r: number; g: number; b: number; a: number };

/** `candidate` unless the theme's own `current` already stands out more
 *  against the page — High Contrast's strong border is pure white, brighter
 *  than its tertiary text, and a preference must never weaken a token. A
 *  colour this can't evaluate (a `var()` alias) keeps the candidate. */
function stronger(candidate: string, current: string, page: string): string {
	const pageRgba = parseRgba(page);
	const c = parseRgba(candidate);
	const k = parseRgba(current);
	if (!pageRgba || !c || !k) return candidate;
	return separation(k, pageRgba) > separation(c, pageRgba) ? current : candidate;
}

function separation(color: Rgba, page: Rgba): number {
	const flat: Rgba = {
		r: color.r * color.a + page.r * (1 - color.a),
		g: color.g * color.a + page.g * (1 - color.a),
		b: color.b * color.a + page.b * (1 - color.a),
		a: 1,
	};
	const a = luminance(flat);
	const b = luminance(page);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function luminance({ r, g, b }: Rgba): number {
	const channel = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function parseRgba(color: string): Rgba | null {
	const value = color.trim();
	const hex = value.match(/^#([0-9a-f]{6})$/i);
	if (hex) {
		const n = Number.parseInt(hex[1] as string, 16);
		return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
	}
	const fn = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i);
	if (!fn) return null;
	return {
		r: Number(fn[1]),
		g: Number(fn[2]),
		b: Number(fn[3]),
		a: fn[4] === undefined ? 1 : Number(fn[4]),
	};
}

function boostAlpha(color: string): string {
	const rgba = parseRgba(color);
	if (!rgba || rgba.a >= 1) return color;
	const alpha = Math.min(ACCENT_SUBTLE_MAX_ALPHA, rgba.a * ACCENT_SUBTLE_BOOST);
	return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${Number(alpha.toFixed(3))})`;
}
