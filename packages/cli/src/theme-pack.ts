/**
 * `brainstorm-cli pack` — the non-GUI path to validate + bundle a theme
 * package (§CLI; 9.9.6). A distributable theme
 * is self-contained: it inlines its component data (token set, optional
 * style pack) rather than referencing installed entities, so the pack runs
 * the SAME validators the theme-editor does — token namespace, WCAG contrast
 * lint, and the StylePack CSS bundle validator — and refuses to emit a
 * bundle with any error-severity finding.
 *
 * This module is **pure** (no fs / argv) so the validate→bundle round-trip
 * is unit-testable; `cli.ts` is the thin fs/argv wrapper.
 */

import {
	type StylePackDef,
	StylePackSanitizeSeverity,
	type TokenSetAppearance,
	type TokenSetDef,
	isValidStylePack,
	lintTokenContrast,
	resolveStylePack,
	resolveTokenOverrides,
	sanitizeStylePackCss,
	validateStylePack,
	validateTokenSet,
} from "@brainstorm-os/sdk-types";

/** A distributable theme package — components inlined (not entity refs). */
export type ThemePackage = {
	name: string;
	appearance: TokenSetAppearance;
	tokenSet?: TokenSetDef;
	stylePack?: Pick<StylePackDef, "name" | "css">;
};

export enum PackSeverity {
	Error = "error",
	Warning = "warning",
}

export enum PackComponent {
	Package = "package",
	TokenSet = "token-set",
	StylePack = "style-pack",
	Contrast = "contrast",
}

export type PackIssue = {
	severity: PackSeverity;
	component: PackComponent;
	message: string;
};

export type PackResult = {
	ok: boolean;
	issues: PackIssue[];
	/** The normalized, validated package — present only when `ok`. */
	bundle?: ThemePackage;
};

function err(component: PackComponent, message: string): PackIssue {
	return { severity: PackSeverity.Error, component, message };
}

function warn(component: PackComponent, message: string): PackIssue {
	return { severity: PackSeverity.Warning, component, message };
}

/**
 * Validate a theme package + (when clean) produce the normalized bundle.
 * Runs token-set structure + WCAG contrast (over the inlined overrides) +
 * the StylePack CSS bundle validator. `ok` is false iff any error-severity
 * issue is present (warnings don't block).
 */
export function packTheme(pkg: ThemePackage | null | undefined): PackResult {
	const issues: PackIssue[] = [];
	if (!pkg || typeof pkg !== "object") {
		return { ok: false, issues: [err(PackComponent.Package, "Theme package is missing.")] };
	}
	if (typeof pkg.name !== "string" || pkg.name.trim().length === 0) {
		issues.push(err(PackComponent.Package, "Theme package name is empty."));
	}

	let normalizedTokenSet: TokenSetDef | undefined;
	if (pkg.tokenSet) {
		for (const issue of validateTokenSet(pkg.tokenSet)) {
			issues.push(err(PackComponent.TokenSet, issue.message));
		}
		// WCAG contrast over the inlined overrides — pairs whose colours
		// aren't both overridden are skipped (can't evaluate without a base).
		const overrides = resolveTokenOverrides(pkg.tokenSet);
		for (const fail of lintTokenContrast((token) => overrides[token])) {
			issues.push(
				warn(
					PackComponent.Contrast,
					`${fail.label}: contrast ${fail.ratio}:1 is below the ${fail.required}:1 minimum.`,
				),
			);
		}
		normalizedTokenSet = pkg.tokenSet;
	}

	let normalizedStylePack: StylePackDef | undefined;
	if (pkg.stylePack) {
		const pack = resolveStylePack(pkg.stylePack);
		for (const issue of validateStylePack(pack)) {
			issues.push(err(PackComponent.StylePack, issue.message));
		}
		for (const finding of sanitizeStylePackCss(pack.css)) {
			const severity =
				finding.severity === StylePackSanitizeSeverity.Error
					? PackSeverity.Error
					: PackSeverity.Warning;
			issues.push({
				severity,
				component: PackComponent.StylePack,
				message: `line ${finding.line}: ${finding.message}`,
			});
		}
		if (isValidStylePack(pack)) normalizedStylePack = pack;
	}

	const ok = !issues.some((i) => i.severity === PackSeverity.Error);
	if (!ok) return { ok, issues };

	const bundle: ThemePackage = { name: pkg.name, appearance: pkg.appearance };
	if (normalizedTokenSet) bundle.tokenSet = normalizedTokenSet;
	if (normalizedStylePack)
		bundle.stylePack = { name: normalizedStylePack.name, css: normalizedStylePack.css };
	return { ok, issues, bundle };
}

/** Render a `PackResult`'s issues as human lines for the CLI report. */
export function formatPackIssues(issues: readonly PackIssue[]): string[] {
	return issues.map(
		(i) => `${i.severity === PackSeverity.Error ? "✗" : "⚠"} [${i.component}] ${i.message}`,
	);
}
