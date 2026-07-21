/**
 * Universal object covers — the ONE resolution + render path every
 * surface uses to paint an object's wide banner backdrop. The React
 * shell surfaces use `<EntityCover>`; `createEntityCoverElement` is its
 * imperative twin so Database / Files / Bookmarks / search-result cards /
 * the dashboard pin all paint a cover identically (per
 *  §Per-object covers everywhere —
 * the object's OWN cover, an id-seeded gradient as the only fallback,
 * never a broken-image square).
 *
 * The cover is read from the object's reserved universal property
 * `properties.cover` (OQ-DM-1 / OQ-COV-1); keying a backdrop off
 * `entity.type` is the rejected anti-pattern, exactly as for icons.
 *
 * `resolveCoverBackground` is the pure keystone both render paths share
 * (no DOM, no React) so the precedence — explicit cover → id-seeded
 * gradient — and the focal-point geometry live in exactly one place.
 *
 * The DOM twin is fully self-styled (inline) so it renders identically
 * regardless of which app's stylesheet is loaded; callers only choose
 * the display `aspect` and an optional `className` / `radius`.
 */

import type { Cover, CoverFocal } from "@brainstorm-os/sdk-types";
import { CoverKind } from "@brainstorm-os/sdk-types";

/** The structural minimum needed to render a cover: a stable id (the
 *  gradient seed) and the bag the universal `cover` property lives in.
 *  `Entity` and the preview `VaultEntity` both satisfy this — callers
 *  pass the object, never its type, so the per-object invariant holds
 *  structurally. */
export type CoverSubject = {
	id: string;
	properties?: Record<string, unknown> | null;
};

/**
 * Curated gradient set — the *seeded-fallback* range. A `null`-cover
 * object falls back deterministically to one of THESE six (and only
 * these), so it stays the exact palette the dashboard
 * `app-icon-palette.ts` uses, kept in lockstep, and adding picker choices
 * never reshuffles an existing vault's fallback covers. Soft pastel
 * two-stop gradients in the COCO family, matched lightness across hues so
 * a wall of objects reads as siblings. Hex literals are content data here
 * — a curated palette, not chrome — the same precedent as
 * `app-icon-palette.ts`.
 */
export const COVER_GRADIENTS: Readonly<Record<string, readonly [string, string]>> = {
	coral: ["#f5cdb6", "#e0815f"],
	sage: ["#a6e2d2", "#4faa92"],
	violet: ["#cdb9f4", "#8867d0"],
	cornflower: ["#b8d4f5", "#5491cf"],
	rose: ["#f3c9d8", "#c66a8c"],
	sand: ["#e8d8b4", "#b89150"],
};

/**
 * Additional curated gradients — *pickable* but never seeded-fallback
 * targets, so the choice set can grow without changing what any existing
 * coverless object renders (`seededGradientKey` ranges over
 * `COVER_GRADIENTS` only). Same COCO family / matched lightness band as
 * the six above so the whole grid still reads as siblings.
 */
export const COVER_GRADIENTS_EXTRA: Readonly<Record<string, readonly [string, string]>> = {
	amber: ["#f3dcae", "#d39a3f"],
	teal: ["#a8e0e2", "#3f9aa0"],
	indigo: ["#c2c1f3", "#5d5bcb"],
	sky: ["#b9e6f5", "#4aa6cf"],
	lime: ["#d4e7b0", "#84a83f"],
	magenta: ["#f1c2e8", "#b85bb0"],
	slate: ["#cdd6e0", "#6c7a8c"],
	apricot: ["#f7dcc0", "#e0a24f"],
	mint: ["#b8e8d0", "#4faa86"],
	lavender: ["#ddccf5", "#9b7fd6"],
	blush: ["#f5ccd6", "#d4708a"],
	ocean: ["#aed6ec", "#3f7fb0"],
};

/** Every pickable gradient (seeded-fallback set + extras). Lookups
 *  (`coverGradientCss`, the picker grid) resolve over the union; only
 *  `seededGradientKey` is restricted to `COVER_GRADIENTS`. */
export const ALL_COVER_GRADIENTS: Readonly<Record<string, readonly [string, string]>> = {
	...COVER_GRADIENTS,
	...COVER_GRADIENTS_EXTRA,
};

const GRADIENT_KEYS = Object.keys(COVER_GRADIENTS);

/** Discriminator for what cover resolution produced — an `<img>`-backed
 *  cover, a CSS paint, or (per OQ-COV-1 (2), only via `resolveCoverForView`)
 *  an explicit per-view suppression where the band is omitted entirely.
 *  Enum, not a bare literal, per the no-string-discriminator convention. */
export enum CoverRenderKind {
	Image = "image",
	Paint = "paint",
	Suppressed = "suppressed",
}

export type ResolvedCover =
	| {
			kind: CoverRenderKind.Image;
			/** The image URL — always a local `brainstorm://cover/<hash>`
			 *  content reference. Remote URLs are only ever a *download
			 *  input* (fetched → stored locally → `brainstorm://`), never a
			 *  persisted cover value. */
			url: string;
			/** CSS `object-position` keeping the focal point visible. */
			position: string;
			/** Seeded-gradient CSS to swap to if the image 404s / fails to
			 *  decode — precomputed so the error path never recomputes. */
			fallbackCss: string;
	  }
	| { kind: CoverRenderKind.Paint; css: string };

/** `resolveCoverForView` adds one outcome `resolveCoverBackground` can't
 *  produce: an explicit per-view "no cover" → the consumer omits the
 *  band for that view only (the object still shows its own cover
 *  elsewhere). Never the id-seeded gradient — "none" means *no band*. */
export type ResolvedCoverForView = ResolvedCover | { kind: CoverRenderKind.Suppressed };

/** FNV-1a 32-bit — identical to `app-icon-palette.ts::hash32` so a given
 *  seed lands on the same gradient family across the icon + cover
 *  surfaces. */
function hash32(input: string): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h;
}

/** The curated gradient key a `null`-cover object falls back to —
 *  deterministic in the object's id so "the blue one" stays the blue
 *  one across every surface and every session. */
export function seededGradientKey(seed: string): string {
	if (GRADIENT_KEYS.length === 0) return "";
	const idx = hash32(seed) % GRADIENT_KEYS.length;
	return GRADIENT_KEYS[idx] ?? (GRADIENT_KEYS[0] as string);
}

/** A curated gradient key → its CSS. An unknown key degrades to the
 *  seeded gradient rather than rendering nothing (never broken). */
export function coverGradientCss(key: string, seed: string): string {
	const stops =
		ALL_COVER_GRADIENTS[key] ??
		COVER_GRADIENTS[seededGradientKey(seed)] ??
		(["#cdb9f4", "#8867d0"] as const);
	return `linear-gradient(135deg, ${stops[0]}, ${stops[1]})`;
}

function clamp01(n: unknown): number {
	if (typeof n !== "number" || !Number.isFinite(n)) return 0.5;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

/** A focal `{x,y}` (0..1) → a CSS `object-position` / `background-position`
 *  string. Absent / malformed focal centres the image. */
export function focalToObjectPosition(focal: CoverFocal | undefined): string {
	if (!focal || typeof focal !== "object") return "50% 50%";
	return `${(clamp01(focal.x) * 100).toFixed(2)}% ${(clamp01(focal.y) * 100).toFixed(2)}%`;
}

/** A normalised `CoverKind.Color` value: the CSS to paint, and whether
 *  it follows the active theme (a custom-property reference) vs. a frozen
 *  literal (the user's explicit escape hatch). Per OQ-COV-1 (3). */
export type NormalizedCoverColor = { css: string; themed: boolean };

// A theme token: `--name` shorthand or a *bare* `var(--name)` (no comma /
// fallback — the picker only ever writes a lone token, and a `var(--x, …)`
// fallback is an injection surface we don't need).
const TOKEN_SHORTHAND = /^--[a-zA-Z_][\w-]*$/;
const TOKEN_VAR = /^var\(\s*(--[a-zA-Z_][\w-]*)\s*\)$/;
// Literal colour *shapes*, allow-listed by form. The function-form charset
// deliberately excludes `;{}:` so a `Color` value can never break out of
// the inline `style` declaration it is interpolated into.
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FN = /^(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([0-9a-zA-Z.,%/\s+-]*\)$/;
const NAMED = /^[a-zA-Z]{1,30}$/; // `rebeccapurple`, `transparent`, `currentColor`

/**
 * Normalise a user-supplied `CoverKind.Color` value (OQ-COV-1 (3)).
 * A theme-token reference (`--accent` / `var(--accent)`) becomes
 * `var(--accent)` and is `themed: true` (follows the active theme — the
 * default); a recognised literal colour shape passes through verbatim as
 * `themed: false` (the explicit absolute escape hatch). Anything that is
 * not a *single* token or colour — multiple tokens, arbitrary CSS, a
 * `;`/`{`/`}` — returns `null`, so the caller degrades to the id-seeded
 * gradient rather than interpolating attacker-controlled text into an
 * inline `style`.
 */
export function normalizeCoverColor(value: unknown): NormalizedCoverColor | null {
	if (typeof value !== "string") return null;
	const v = value.trim();
	if (v.length === 0 || v.length > 64) return null;
	if (TOKEN_SHORTHAND.test(v)) return { css: `var(${v})`, themed: true };
	const varMatch = TOKEN_VAR.exec(v);
	if (varMatch?.[1]) return { css: `var(${varMatch[1]})`, themed: true };
	if (HEX.test(v) || COLOR_FN.test(v) || NAMED.test(v)) return { css: v, themed: false };
	return null;
}

/** Validate a loosely-typed raw value into a well-formed `Cover`. Vault
 *  data can be anything; every field is guarded — anything that isn't a
 *  well-formed `Cover` is `null` (→ the caller's seeded fallback). */
export function parseCover(raw: unknown): Cover | null {
	if (!raw || typeof raw !== "object") return null;
	const c = raw as { kind?: unknown; value?: unknown; focal?: unknown };
	if (typeof c.value !== "string" || c.value.length === 0) return null;
	if (c.kind === CoverKind.Image) {
		// A persisted Image cover is ALWAYS a local `brainstorm://cover/`
		// reference — covers/icons are never remote. A remote URL is only
		// a transient download input (fetched → stored → `brainstorm://`),
		// so rejecting any non-`brainstorm:` scheme here (the one shared
		// chokepoint) stops a cross-app-authored `https://…`/`data:` value
		// from becoming an `<img>`/background egress beacon on render.
		if (!c.value.startsWith("brainstorm:")) return null;
		const focal = c.focal as { x?: unknown; y?: unknown } | undefined;
		return focal && typeof focal === "object"
			? { kind: CoverKind.Image, value: c.value, focal: { x: clamp01(focal.x), y: clamp01(focal.y) } }
			: { kind: CoverKind.Image, value: c.value };
	}
	if (c.kind === CoverKind.Gradient) return { kind: CoverKind.Gradient, value: c.value };
	if (c.kind === CoverKind.Color) return { kind: CoverKind.Color, value: c.value };
	return null;
}

/** Read + validate the reserved universal `cover` property off an object.
 *  Thin wrapper over `parseCover` for the canonical `properties.cover`
 *  slot — `resolveCoverForView`'s Property mode reuses `parseCover` for
 *  an arbitrary per-view cover property key. */
export function coverOf(subject: CoverSubject | null | undefined): Cover | null {
	return parseCover(subject?.properties?.cover);
}

/**
 * The pure keystone: an object → how its cover should paint. Shared by
 * `<EntityCover>` and `createEntityCoverElement` so precedence + focal
 * geometry exist once. Pass the resolved `cover` explicitly to override
 * the object's `properties.cover` (the documented `view.coverProperty`
 * per-view override per OQ-COV-1) — otherwise it is read off the object.
 */
export function resolveCoverBackground(
	subject: CoverSubject,
	cover: Cover | null = coverOf(subject),
): ResolvedCover {
	const seed = subject.id ?? "";
	const seededCss = coverGradientCss(seededGradientKey(seed), seed);

	if (cover && cover.kind === CoverKind.Image) {
		return {
			kind: CoverRenderKind.Image,
			url: cover.value,
			position: focalToObjectPosition(cover.focal),
			fallbackCss: seededCss,
		};
	}
	if (cover && cover.kind === CoverKind.Gradient) {
		return { kind: CoverRenderKind.Paint, css: coverGradientCss(cover.value, seed) };
	}
	if (cover && cover.kind === CoverKind.Color) {
		// User-supplied; sanitise (token-ref or lone literal) before it
		// reaches an inline `style`. Unrecognised / unsafe → seeded
		// gradient, never a raw interpolation.
		const color = normalizeCoverColor(cover.value);
		return { kind: CoverRenderKind.Paint, css: color ? color.css : seededCss };
	}
	return { kind: CoverRenderKind.Paint, css: seededCss };
}

/** How a *view* sources its cards' cover, per OQ-COV-1 (2). Enum, not a
 *  bare literal, per the no-string-discriminator convention. */
export enum ViewCoverMode {
	/** No per-view override — use the object's own `properties.cover`
	 *  (→ id-seeded gradient if absent). The common case. */
	Inherit = "inherit",
	/** This view sources the cover from a specific property key instead
	 *  of `properties.cover` (the Database gallery's `coverProperty`
	 *  knob). Absent/invalid on the object → id-seeded gradient. */
	Property = "property",
	/** The user explicitly chose "no cover" for this view — omit the
	 *  band for this view only (NOT the seeded gradient). */
	None = "none",
}

export type CoverViewSource =
	| { mode: ViewCoverMode.Inherit }
	| { mode: ViewCoverMode.Property; key: string }
	| { mode: ViewCoverMode.None };

/**
 * Per-view cover resolution — the typed primitive for OQ-COV-1 (2)'s
 * precedence `view.coverProperty → properties.cover → id-seeded
 * gradient`, plus the explicit per-view suppression. The single place
 * the rule lives so B7.3's cross-app adoption never re-implements it
 * per app (keying a card backdrop off a per-app rule is the rejected
 * anti-pattern, exactly as for per-object icons).
 *
 * - `Inherit` → the object's own cover (delegates to
 *   `resolveCoverBackground`; id-seeded gradient when absent).
 * - `Property` → the cover stored at `properties[key]`; if that slot
 *   isn't a well-formed cover the object still gets *a* backdrop (the
 *   id-seeded gradient), never a broken square.
 * - `None` → `Suppressed`; the consumer omits the band for this view
 *   while the object keeps its own cover everywhere else.
 */
export function resolveCoverForView(
	subject: CoverSubject,
	source: CoverViewSource = { mode: ViewCoverMode.Inherit },
): ResolvedCoverForView {
	if (source.mode === ViewCoverMode.None) return { kind: CoverRenderKind.Suppressed };
	if (source.mode === ViewCoverMode.Property) {
		return resolveCoverBackground(subject, parseCover(subject.properties?.[source.key]));
	}
	return resolveCoverBackground(subject);
}

/** Neutral banner aspect (width / height). The layout chrome cell
 *  owns the real per-context band height;
 *  this is just a sensible default when a caller doesn't pin one. */
export const DEFAULT_COVER_ASPECT = 16 / 9;

export type CreateEntityCoverOptions = {
	/** Display aspect ratio (width / height). Default 16/9. */
	aspect?: number;
	/** Border radius in px (cards may round; full-bleed bands don't).
	 *  Default 0. */
	radius?: number;
	/** Extra class on the outer element (layout/positioning only). */
	className?: string;
};

/**
 * Imperative twin of `<EntityCover>`. Returns a self-styled block element
 * painting `subject`'s cover at the requested aspect. Images lazy-load
 * (`loading="lazy"`) and degrade to the id-seeded gradient on error — no
 * broken-image square, ever.
 */
export function createEntityCoverElement(
	subject: CoverSubject,
	options: CreateEntityCoverOptions = {},
	cover: Cover | null = coverOf(subject),
): HTMLElement {
	const aspect = options.aspect && options.aspect > 0 ? options.aspect : DEFAULT_COVER_ASPECT;
	const wrap = document.createElement("div");
	if (options.className) wrap.className = options.className;
	wrap.setAttribute("aria-hidden", "true");
	wrap.style.display = "block";
	wrap.style.width = "100%";
	wrap.style.aspectRatio = String(aspect);
	// The band's only height is `aspect-ratio` — never an explicit value — so a
	// column flex ancestor's `flex-shrink: 1` would compress it (height then
	// drifts with how much sibling content the object has). Pin it here for the
	// direct-mount case; consumers that wrap the cover in their own clickable
	// host (every right-panel inspector) must also pin that host — see the
	// "cover host in a right panel" convention in CLAUDE.md.
	wrap.style.flexShrink = "0";
	wrap.style.overflow = "hidden";
	wrap.style.borderRadius = `${options.radius ?? 0}px`;
	wrap.style.backgroundSize = "cover";
	wrap.style.backgroundPosition = "center";

	const resolved = resolveCoverBackground(subject, cover);

	const paint = (css: string): void => {
		wrap.dataset.entityCoverKind = "paint";
		wrap.style.background = css;
		wrap.replaceChildren();
	};

	if (resolved.kind === CoverRenderKind.Paint) {
		paint(resolved.css);
		return wrap;
	}

	wrap.dataset.entityCoverKind = "image";
	const img = document.createElement("img");
	img.src = resolved.url;
	img.alt = "";
	img.draggable = false;
	img.setAttribute("loading", "lazy");
	img.setAttribute("decoding", "async");
	img.style.width = "100%";
	img.style.height = "100%";
	img.style.objectFit = "cover";
	img.style.objectPosition = resolved.position;
	img.style.display = "block";
	img.addEventListener("error", () => paint(resolved.fallbackCss), { once: true });
	wrap.appendChild(img);
	return wrap;
}
