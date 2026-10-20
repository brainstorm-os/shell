import {
	ContrastLevel,
	contrastRatio,
	lintSurfaceSeparation,
	lintTokenContrast,
	parseColor,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { ThemeName, themes } from "./themes";
import { flattenTokens } from "./tokens";
import { higherContrastOverrides } from "./visibility";

const SELECTION_MIX = 0.4;

function overOpaque(color: string, base: string): string {
	const c = parseColor(color);
	const b = parseColor(base);
	if (!c || !b || c.a >= 1) return color;
	const mix = (x: number, y: number) => Math.round(x * c.a + y * (1 - c.a));
	return `rgb(${mix(c.r, b.r)}, ${mix(c.g, b.g)}, ${mix(c.b, b.b)})`;
}

describe("visibility preferences — every theme", () => {
	for (const name of Object.values(ThemeName)) {
		const base = flattenTokens(themes[name]);
		const overrides = higherContrastOverrides(themes[name]);
		const merged = { ...base, ...overrides };

		it(`${name}: higher-contrast overrides only name tokens the theme defines`, () => {
			expect(Object.keys(overrides).length).toBeGreaterThan(0);
			for (const key of Object.keys(overrides)) {
				expect(base[key], `${name} has no ${key}`).toBeDefined();
			}
		});

		it(`${name}: higher contrast still clears the 12.16/12.17 contrast ratchet`, () => {
			expect(lintTokenContrast((token) => merged[token])).toEqual([]);
			expect(lintSurfaceSeparation((token) => merged[token])).toEqual([]);
		});

		it(`${name}: a strong border clears the 3:1 non-text bar under higher contrast`, () => {
			const page = base["--color-background-primary"] as string;
			const ratio = contrastRatio(overOpaque(merged["--color-border-strong"] as string, page), page);
			expect(ratio).not.toBeNull();
			expect(ratio as number).toBeGreaterThanOrEqual(ContrastLevel.Large);
		});

		it(`${name}: higher contrast never weakens a border or a muted label`, () => {
			const page = base["--color-background-primary"] as string;
			for (const token of [
				"--color-border-subtle",
				"--color-border-default",
				"--color-border-strong",
				"--color-text-tertiary",
			]) {
				const before = contrastRatio(overOpaque(base[token] as string, page), page) ?? 0;
				const after = contrastRatio(overOpaque(merged[token] as string, page), page) ?? 0;
				expect(after, `${name} ${token}`).toBeGreaterThanOrEqual(before);
			}
		});

		it(`${name}: emphasised selection keeps primary text at AA and the caret is accent-as-text`, () => {
			expect(base["--color-emphasis-caret"]).toBe("var(--color-accent-on-surface)");
			expect(base["--color-emphasis-selection"]).toContain(`${SELECTION_MIX * 100}%`);
			const accent = parseColor(base["--color-accent-default"]);
			expect(accent).not.toBeNull();
			const wash = `rgba(${accent?.r}, ${accent?.g}, ${accent?.b}, ${SELECTION_MIX})`;
			const page = base["--color-background-primary"] as string;
			const ratio = contrastRatio(base["--color-text-primary"] as string, overOpaque(wash, page));
			expect(ratio as number).toBeGreaterThanOrEqual(ContrastLevel.Normal);
		});
	}
});
