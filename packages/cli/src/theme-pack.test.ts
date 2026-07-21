import { TokenSetAppearance } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	PackComponent,
	PackSeverity,
	type ThemePackage,
	formatPackIssues,
	packTheme,
} from "./theme-pack";

function pkg(over: Partial<ThemePackage> = {}): ThemePackage {
	return { name: "Solarized", appearance: TokenSetAppearance.Dark, ...over };
}

describe("packTheme", () => {
	it("packs a clean token-set + style-pack package", () => {
		const result = packTheme(
			pkg({
				tokenSet: {
					name: "Solarized Dark",
					appearance: TokenSetAppearance.Dark,
					overrides: { "--color-accent-default": "#268bd2" },
				},
				stylePack: {
					name: "Polish",
					css: '[data-bs-region="dashboard-header"] { border-radius: 8px; }',
				},
			}),
		);
		expect(result.ok).toBe(true);
		expect(result.bundle?.name).toBe("Solarized");
		expect(result.bundle?.stylePack?.css).toContain("data-bs-region");
		expect(result.issues.filter((i) => i.severity === PackSeverity.Error)).toEqual([]);
	});

	it("fails on an empty name", () => {
		const result = packTheme(pkg({ name: "  " }));
		expect(result.ok).toBe(false);
		expect(result.bundle).toBeUndefined();
		expect(result.issues[0]?.component).toBe(PackComponent.Package);
	});

	it("fails on an unsafe StylePack (script/network vector)", () => {
		const result = packTheme(
			pkg({ stylePack: { name: "Bad", css: "@import url(https://e.test/x.css);" } }),
		);
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.component === PackComponent.StylePack)).toBe(true);
	});

	it("fails on an unknown token name in the token set", () => {
		const result = packTheme(
			pkg({
				tokenSet: { name: "T", appearance: TokenSetAppearance.Dark, overrides: { "--bogus": "#fff" } },
			}),
		);
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.component === PackComponent.TokenSet)).toBe(true);
	});

	it("warns (does not block) on low contrast", () => {
		const result = packTheme(
			pkg({
				tokenSet: {
					name: "T",
					appearance: TokenSetAppearance.Light,
					overrides: {
						"--color-text-primary": "#cccccc",
						"--color-background-primary": "#ffffff",
					},
				},
			}),
		);
		// Low-contrast text → warning, but no error → still packs.
		expect(result.ok).toBe(true);
		expect(result.issues.some((i) => i.component === PackComponent.Contrast)).toBe(true);
		expect(result.issues.every((i) => i.severity === PackSeverity.Warning)).toBe(true);
	});

	it("rejects a missing package", () => {
		expect(packTheme(null).ok).toBe(false);
	});

	it("formatPackIssues marks errors vs warnings", () => {
		const lines = formatPackIssues([
			{ severity: PackSeverity.Error, component: PackComponent.Package, message: "x" },
			{ severity: PackSeverity.Warning, component: PackComponent.Contrast, message: "y" },
		]);
		expect(lines[0]).toContain("✗");
		expect(lines[1]).toContain("⚠");
	});
});
