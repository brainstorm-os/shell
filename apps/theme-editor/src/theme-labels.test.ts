/**
 * Every `ThemeName` must have a theme-editor label: an entry in the
 * `THEME_LABEL_KEY` map (app.tsx) and a `theme.*` key in every locale
 * catalog. TS enforces the Record shape at compile time, but two theme PRs
 * in a row (Porcelain #433, Graphite #434) merged with the entry missing —
 * `typecheck:apps` only reds in CI's Verify leg, which authors skip locally.
 * This guard fails in the plain vitest suite instead, the net people
 * actually run before pushing.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ThemeName } from "@brainstorm-os/tokens";
import { describe, expect, it } from "vitest";
import en from "./i18n/en.json";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const camel = (kebab: string): string => kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

describe("theme labels stay complete for every ThemeName", () => {
	const entries = Object.entries(ThemeName) as Array<[string, string]>;

	it("THEME_LABEL_KEY maps every enum member", () => {
		const appSource = readFileSync(join(SRC_DIR, "app.tsx"), "utf8");
		for (const [key] of entries) {
			expect(appSource, `THEME_LABEL_KEY is missing [ThemeName.${key}]`).toContain(
				`[ThemeName.${key}]`,
			);
		}
	});

	it("every locale catalog carries a theme.* label for every theme", () => {
		const locales = readdirSync(join(SRC_DIR, "i18n")).filter((f) => f.endsWith(".json"));
		expect(locales.length).toBeGreaterThan(0);
		for (const file of locales) {
			const catalog = JSON.parse(readFileSync(join(SRC_DIR, "i18n", file), "utf8")) as Record<
				string,
				string
			>;
			for (const [, value] of entries) {
				const labelKey = `theme.${camel(value)}`;
				expect(catalog[labelKey], `${file} is missing ${labelKey}`).toBeTruthy();
			}
		}
	});

	it("the convention test itself is not vacuous", () => {
		// If the en catalog ever renames the theme.* namespace, fail loudly
		// instead of silently asserting nothing meaningful.
		expect(en["theme.defaultDark"]).toBe("Default Dark");
	});
});
