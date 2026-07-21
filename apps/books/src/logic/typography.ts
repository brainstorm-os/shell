/**
 * Pure reading-typography model — the "glass" the reflow reader looks
 * through. Five orthogonal axes (family / size / leading / measure /
 * theme) bound to the frozen `brainstorm/Typography/v1` render-application
 * (Stage 8.7): `family` selects which `FontRole` body stack
 * `resolveFontStack` resolves, and the resolved CSS vars feed
 * `font-family: var(--text-family-body)` exactly as every other surface
 * consumes Typography — no second font system.
 *
 * The whole point of keeping this pure: a typography change re-paginates
 * by recomputing the chars-per-page budget (`charsPerPageBudget`) while
 * locators stay stable (`reader-state.repaginate` re-anchors on the live
 * locator). The renderer never re-derives page breaks itself.
 *
 * Persisted per book via `serializeTypography` / `parseTypography`: a
 * compact, forward-tolerant JSON blob stored on the `Book/v1` entity
 * (the vault write lands with the library view in 9.21.6 — this is the
 * codec keystone that outlives the preview renderer).
 */

import {
	FontRole,
	SYSTEM_TYPOGRAPHY,
	type TypographyDef,
	resolveFontStack,
} from "@brainstorm-os/sdk-types";

/** Body font family. Each maps to a real `font-family` stack; `System`
 *  resolves through the Typography render-application's body role so the
 *  reader inherits whatever Typography the vault theme installed. */
export enum ReadingFamily {
	System = "system",
	Serif = "serif",
	Sans = "sans",
	Mono = "mono",
}

/** Reading-page colour scheme — independent of the app/UI theme so a
 *  reader can keep a sepia page in a dark shell (a long-standing reader
 *  affordance). `Theme` defers to the surrounding app theme. */
export enum ReadingTheme {
	Theme = "theme",
	Light = "light",
	Sepia = "sepia",
	Dark = "dark",
}

/** The full typography state. Bounded numeric axes (clamped on every
 *  mutation) keep pagination budgets sane and the UI predictable. */
export type TypographySettings = {
	family: ReadingFamily;
	/** Body font size in px. */
	size: number;
	/** Line-height multiplier (unitless leading). */
	leading: number;
	/** Reading column width in characters (the `measure`). */
	measure: number;
	theme: ReadingTheme;
};

export const SIZE_MIN = 14;
export const SIZE_MAX = 28;
export const SIZE_STEP = 2;

export const LEADING_MIN = 1.2;
export const LEADING_MAX = 2.0;
export const LEADING_STEP = 0.1;

export const MEASURE_MIN = 45;
export const MEASURE_MAX = 90;
export const MEASURE_STEP = 5;

export const DEFAULT_TYPOGRAPHY: TypographySettings = Object.freeze({
	family: ReadingFamily.System,
	size: 18,
	leading: 1.6,
	measure: 65,
	theme: ReadingTheme.Theme,
});

/** Named font stacks for the non-system families. The `System` family
 *  resolves through the Typography render-application instead (so it
 *  follows the installed vault Typography). */
const FAMILY_STACKS: Record<Exclude<ReadingFamily, ReadingFamily.System>, string> = {
	[ReadingFamily.Serif]: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
	[ReadingFamily.Sans]: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
	[ReadingFamily.Mono]: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

function clamp(value: number, min: number, max: number): number {
	if (Number.isNaN(value)) return min;
	return Math.min(max, Math.max(min, value));
}

/** Snap to the nearest step within bounds — keeps the numeric axes on a
 *  predictable ladder regardless of how a value arrives (button step,
 *  parsed blob, slider). */
function snap(value: number, min: number, max: number, step: number): number {
	const clamped = clamp(value, min, max);
	const steps = Math.round((clamped - min) / step);
	return clamp(min + steps * step, min, max);
}

/** Clamp every axis into its bounds (numeric) / valid enum (categorical).
 *  Idempotent — applying twice equals once. */
export function clampTypography(settings: TypographySettings): TypographySettings {
	return {
		family: isReadingFamily(settings.family) ? settings.family : DEFAULT_TYPOGRAPHY.family,
		size: snap(settings.size, SIZE_MIN, SIZE_MAX, SIZE_STEP),
		leading: roundLeading(clamp(settings.leading, LEADING_MIN, LEADING_MAX)),
		measure: snap(settings.measure, MEASURE_MIN, MEASURE_MAX, MEASURE_STEP),
		theme: isReadingTheme(settings.theme) ? settings.theme : DEFAULT_TYPOGRAPHY.theme,
	};
}

/** Leading carries a single decimal — float math leaves dust (1.6 + 0.1
 *  → 1.7000000000000002); round so equality + display stay clean. */
function roundLeading(value: number): number {
	return Math.round(value * 10) / 10;
}

export function withSize(settings: TypographySettings, size: number): TypographySettings {
	return clampTypography({ ...settings, size });
}

export function stepSize(settings: TypographySettings, delta: number): TypographySettings {
	return withSize(settings, settings.size + delta * SIZE_STEP);
}

export function stepLeading(settings: TypographySettings, delta: number): TypographySettings {
	return clampTypography({ ...settings, leading: settings.leading + delta * LEADING_STEP });
}

export function stepMeasure(settings: TypographySettings, delta: number): TypographySettings {
	return clampTypography({ ...settings, measure: settings.measure + delta * MEASURE_STEP });
}

export function withFamily(
	settings: TypographySettings,
	family: ReadingFamily,
): TypographySettings {
	return clampTypography({ ...settings, family });
}

export function withTheme(settings: TypographySettings, theme: ReadingTheme): TypographySettings {
	return clampTypography({ ...settings, theme });
}

const READING_FAMILIES: readonly ReadingFamily[] = Object.freeze([
	ReadingFamily.System,
	ReadingFamily.Serif,
	ReadingFamily.Sans,
	ReadingFamily.Mono,
]);

const READING_THEMES: readonly ReadingTheme[] = Object.freeze([
	ReadingTheme.Theme,
	ReadingTheme.Light,
	ReadingTheme.Sepia,
	ReadingTheme.Dark,
]);

export function isReadingFamily(value: unknown): value is ReadingFamily {
	return READING_FAMILIES.includes(value as ReadingFamily);
}

export function isReadingTheme(value: unknown): value is ReadingTheme {
	return READING_THEMES.includes(value as ReadingTheme);
}

/** Resolve the body `font-family` for these settings. The non-system
 *  families return their named stack; `System` defers to the installed
 *  Typography (`typo`, the `brainstorm/Typography/v1` body role), falling
 *  back to `SYSTEM_TYPOGRAPHY` when no Typography is bound. */
export function resolveReadingFontFamily(
	settings: TypographySettings,
	typo?: TypographyDef | null,
): string {
	if (settings.family === ReadingFamily.System) {
		return resolveFontStack(typo ?? SYSTEM_TYPOGRAPHY, FontRole.Body);
	}
	return FAMILY_STACKS[settings.family];
}

/** Recompute the chars-per-page budget from the typography + the measured
 *  reading area. The budget is purely a function of (settings, width,
 *  height) — change the glass, get a new budget, re-paginate, locators
 *  stay put. `measure` caps the column width in characters; the effective
 *  columns are `min(measure, area-fit)`. */
export function charsPerPageBudget(
	settings: TypographySettings,
	width: number,
	height: number,
): number {
	const charWidth = settings.size * 0.5;
	const lineHeight = settings.size * settings.leading;
	const fitCols = Math.floor(width / charWidth);
	const cols = Math.max(20, Math.min(settings.measure, Math.max(20, fitCols)));
	const lines = Math.max(4, Math.floor(height / lineHeight));
	return cols * lines;
}

/** CSS custom properties the reader element consumes. Names are
 *  app-local reader vars the reader's own CSS declares + injects (per the
 *  no-phantom-tokens rule the reader CSS must declare these). */
export type ReaderCssVars = {
	"--reader-font-family": string;
	"--reader-font-size": string;
	"--reader-leading": string;
	"--reader-measure": string;
};

export function readerCssVars(
	settings: TypographySettings,
	typo?: TypographyDef | null,
): ReaderCssVars {
	return {
		"--reader-font-family": resolveReadingFontFamily(settings, typo),
		"--reader-font-size": `${settings.size}px`,
		"--reader-leading": String(settings.leading),
		"--reader-measure": `${settings.measure}ch`,
	};
}

type TypographyBlob = {
	family: string;
	size: number;
	leading: number;
	measure: number;
	theme: string;
};

/** Per-book persisted form — a compact JSON blob stored on the `Book/v1`
 *  entity. Always serializes a clamped snapshot so a stored value is
 *  always valid. */
export function serializeTypography(settings: TypographySettings): string {
	const clamped = clampTypography(settings);
	const blob: TypographyBlob = {
		family: clamped.family,
		size: clamped.size,
		leading: clamped.leading,
		measure: clamped.measure,
		theme: clamped.theme,
	};
	return JSON.stringify(blob);
}

/** Parse a persisted blob, defaulting + clamping every field — forward-
 *  tolerant: unknown/missing fields fall back to the default, so a future
 *  reader that wrote extra axes (or a corrupt blob) never breaks an older
 *  one. Returns `DEFAULT_TYPOGRAPHY` for non-JSON / non-object input. */
export function parseTypography(raw: string | null | undefined): TypographySettings {
	if (typeof raw !== "string" || raw.length === 0) return DEFAULT_TYPOGRAPHY;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_TYPOGRAPHY;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return DEFAULT_TYPOGRAPHY;
	}
	const blob = parsed as Partial<TypographyBlob>;
	return clampTypography({
		family: isReadingFamily(blob.family) ? blob.family : DEFAULT_TYPOGRAPHY.family,
		size: typeof blob.size === "number" ? blob.size : DEFAULT_TYPOGRAPHY.size,
		leading: typeof blob.leading === "number" ? blob.leading : DEFAULT_TYPOGRAPHY.leading,
		measure: typeof blob.measure === "number" ? blob.measure : DEFAULT_TYPOGRAPHY.measure,
		theme: isReadingTheme(blob.theme) ? blob.theme : DEFAULT_TYPOGRAPHY.theme,
	});
}
