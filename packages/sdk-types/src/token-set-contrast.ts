/**
 * Token-set **contrast lint** (§Validation;
 * OQ-171). Given the *resolved* effective value of each colour token (the
 * base theme composed with a `brainstorm/TokenSet/v1`'s overrides), this
 * checks the foreground/background pairs that carry text against the WCAG
 * 2.1 minimum contrast ratios so an authored token set can't ship text
 * that's unreadable on its own surface. The theme-editor surfaces failures
 * inline (9.9.6) and the CLI `pack` fails on them.
 *
 * sdk-types is a leaf and must not depend on `@brainstorm/tokens`, so the
 * caller supplies a `resolve(tokenName)` returning the effective CSS colour
 * (base ∪ overrides) — the theme-editor's `composePreviewVars` is exactly
 * that map. Colours the lint can't evaluate (named, `var()`, gradients) are
 * skipped, not failed: contrast is asserted only where it's computable.
 *
 * Pure + dependency-free leaf; barrel-re-exported.
 */

/** WCAG 2.1 minimum contrast ratios. */
export enum ContrastLevel {
	/** Normal-size body text — 4.5:1 (AA). */
	Normal = 4.5,
	/** Large / secondary text + UI affordances — 3:1 (AA-large). */
	Large = 3,
}

type Rgba = { r: number; g: number; b: number; a: number };

function clamp8(n: number): number {
	return n < 0 ? 0 : n > 255 ? 255 : n;
}

function parseHex(hex: string): Rgba | null {
	const h = hex.slice(1);
	const expand = (s: string) =>
		s
			.split("")
			.map((c) => c + c)
			.join("");
	let r: number;
	let g: number;
	let b: number;
	let a = 1;
	if (h.length === 3 || h.length === 4) {
		r = Number.parseInt(expand(h[0] as string), 16);
		g = Number.parseInt(expand(h[1] as string), 16);
		b = Number.parseInt(expand(h[2] as string), 16);
		if (h.length === 4) a = Number.parseInt(expand(h[3] as string), 16) / 255;
	} else if (h.length === 6 || h.length === 8) {
		r = Number.parseInt(h.slice(0, 2), 16);
		g = Number.parseInt(h.slice(2, 4), 16);
		b = Number.parseInt(h.slice(4, 6), 16);
		if (h.length === 8) a = Number.parseInt(h.slice(6, 8), 16) / 255;
	} else {
		return null;
	}
	if ([r, g, b].some((n) => Number.isNaN(n))) return null;
	return { r, g, b, a };
}

function parseRgbFn(value: string): Rgba | null {
	const inner = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")"));
	// Accept both comma and modern slash/space syntax.
	const parts = inner
		.split(/[,/]/)
		.flatMap((p) => p.trim().split(/\s+/))
		.filter(Boolean);
	if (parts.length < 3) return null;
	const channel = (raw: string): number => {
		const s = raw.trim();
		return s.endsWith("%")
			? clamp8((Number.parseFloat(s) / 100) * 255)
			: clamp8(Number.parseFloat(s));
	};
	const r = channel(parts[0] as string);
	const g = channel(parts[1] as string);
	const b = channel(parts[2] as string);
	let a = 1;
	if (parts[3] !== undefined) {
		const s = (parts[3] as string).trim();
		a = s.endsWith("%") ? Number.parseFloat(s) / 100 : Number.parseFloat(s);
	}
	if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
	return { r, g, b, a: Math.max(0, Math.min(1, a)) };
}

/** Parse a CSS colour to RGBA, or `null` when it isn't a computable
 *  literal (named colours, `var()`, gradients, `currentColor`). */
export function parseColor(value: string | undefined | null): Rgba | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (v.startsWith("#")) return parseHex(v);
	if (v.startsWith("rgb(") || v.startsWith("rgba(")) return parseRgbFn(v);
	return null;
}

/** Composite a possibly-translucent foreground over an opaque background. */
function flatten(fg: Rgba, bg: Rgba): Rgba {
	if (fg.a >= 1) return fg;
	return {
		r: fg.r * fg.a + bg.r * (1 - fg.a),
		g: fg.g * fg.a + bg.g * (1 - fg.a),
		b: fg.b * fg.a + bg.b * (1 - fg.a),
		a: 1,
	};
}

function channelLuminance(c: number): number {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }: Rgba): number {
	return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio (1..21) between two CSS colours, composited so a
 *  translucent `fg` is evaluated over `bg`. `null` if either is unparseable. */
export function contrastRatio(fg: string, bg: string): number | null {
	const fgRgba = parseColor(fg);
	const bgRgba = parseColor(bg);
	if (!fgRgba || !bgRgba) return null;
	const f = relativeLuminance(flatten(fgRgba, bgRgba));
	const b = relativeLuminance(bgRgba);
	const lighter = Math.max(f, b);
	const darker = Math.min(f, b);
	return (lighter + 0.05) / (darker + 0.05);
}

/** A foreground/background token pair that carries text + its required level. */
export type ContrastPair = {
	id: string;
	label: string;
	foreground: string;
	background: string;
	level: ContrastLevel;
};

/** The frozen set of text-bearing token pairs the lint asserts. Each names
 *  canonical tokens (`token-names.ts`); the level reflects how the pair is
 *  used (primary body text → Normal; muted / large / UI affordances →
 *  Large). */
export const CONTRAST_PAIRS: readonly ContrastPair[] = Object.freeze([
	{
		id: "text-on-bg",
		label: "Primary text on background",
		foreground: "--color-text-primary",
		background: "--color-background-primary",
		level: ContrastLevel.Normal,
	},
	{
		id: "text-on-surface",
		label: "Primary text on surface",
		foreground: "--color-text-primary",
		background: "--color-surface-default",
		level: ContrastLevel.Normal,
	},
	{
		id: "text-on-elevated",
		label: "Primary text on elevated surface",
		foreground: "--color-text-primary",
		background: "--color-background-elevated",
		level: ContrastLevel.Normal,
	},
	{
		id: "secondary-on-bg",
		label: "Secondary text on background",
		foreground: "--color-text-secondary",
		background: "--color-background-primary",
		level: ContrastLevel.Normal,
	},
	{
		id: "tertiary-on-bg",
		label: "Tertiary text on background",
		foreground: "--color-text-tertiary",
		background: "--color-background-primary",
		level: ContrastLevel.Large,
	},
	{
		id: "link-on-bg",
		label: "Link text on background",
		foreground: "--color-text-link",
		background: "--color-background-primary",
		level: ContrastLevel.Normal,
	},
	{
		id: "accent-text-on-accent",
		label: "Accent text on accent fill",
		foreground: "--color-accent-text",
		// The fill that carries `accent.text` is `accent.onFill` (theme-correct),
		// NOT the decorative `accent.default` — white text on the light default is
		// sub-AA in several light themes (12.17).
		background: "--color-accent-on-fill",
		level: ContrastLevel.Normal,
	},
	{
		id: "accent-on-surface-on-bg",
		label: "Accent-as-text on background",
		foreground: "--color-accent-on-surface",
		background: "--color-background-primary",
		level: ContrastLevel.Normal,
	},
	{
		id: "accent-on-surface-on-elevated",
		label: "Accent-as-text on elevated surface",
		foreground: "--color-accent-on-surface",
		background: "--color-background-elevated",
		level: ContrastLevel.Normal,
	},
	{
		id: "inverse-on-inverse",
		label: "Inverse text on inverse background",
		foreground: "--color-text-inverse",
		background: "--color-background-inverse",
		level: ContrastLevel.Normal,
	},
	{
		id: "chrome-text-on-chrome",
		label: "Chrome text on chrome background",
		foreground: "--color-chrome-text",
		background: "--color-chrome-background",
		level: ContrastLevel.Normal,
	},
]) as readonly ContrastPair[];

export type ContrastIssue = {
	pairId: string;
	label: string;
	ratio: number;
	required: number;
};

/** The opaque base every translucent surface token is layered over. A surface
 *  like `surface.default` = `rgba(255,255,255,0.05)` is an OVERLAY, not a
 *  standalone background — evaluating text against its raw RGB (ignoring alpha)
 *  treats a 5%-white overlay as pure white and wildly misreports the ratio. */
const BASE_BACKGROUND_TOKEN = "--color-background-primary";

/** Composite a possibly-translucent background colour over `base` so the
 *  effective opaque colour is what the eye sees. Returns `bg` unchanged when it
 *  is already opaque or either colour is unparseable. */
function opaqueBackground(bg: string, base: string | undefined): string {
	const c = parseColor(bg);
	if (!c || c.a >= 1) return bg;
	const b = base ? parseColor(base) : null;
	if (!b) return bg;
	const f = flatten(c, b);
	return `rgb(${Math.round(f.r)}, ${Math.round(f.g)}, ${Math.round(f.b)})`;
}

/**
 * Lint the resolved colour tokens. `resolve(tokenName)` returns the
 * effective CSS colour (base ∪ overrides). Returns one issue per pair whose
 * computable contrast is below its required ratio; pairs with an
 * unevaluable colour are skipped. `[]` ⇒ every computable pair passes.
 *
 * A translucent background token is composited over `--color-background-primary`
 * first, so an overlay surface is evaluated as its rendered opaque colour.
 */
export function lintTokenContrast(
	resolve: (tokenName: string) => string | undefined,
): ContrastIssue[] {
	const issues: ContrastIssue[] = [];
	const base = resolve(BASE_BACKGROUND_TOKEN);
	for (const pair of CONTRAST_PAIRS) {
		const fg = resolve(pair.foreground);
		const bgRaw = resolve(pair.background);
		if (fg === undefined || bgRaw === undefined) continue;
		const bg = opaqueBackground(bgRaw, base);
		const ratio = contrastRatio(fg, bg);
		if (ratio === null) continue;
		if (ratio < pair.level) {
			issues.push({
				pairId: pair.id,
				label: pair.label,
				ratio: Math.round(ratio * 100) / 100,
				required: pair.level,
			});
		}
	}
	return issues;
}
