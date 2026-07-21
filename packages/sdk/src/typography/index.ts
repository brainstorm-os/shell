/**
 * Render-application of the frozen `brainstorm/Typography/v1` contract
 * (Stage 8.7). Resolves a `TypographyDef` into the CSS custom properties
 * the renderer consumes (`--text-family-{ui,body,code,display}`, one per
 * `FontRole`) plus `--typography-scale`.
 *
 * Shared SDK home (extracted from the shell renderer at copy two — the
 * theme-editor's typography editor, Stage 9.9.3, applies the same vars for
 * its in-editor live preview). The shell `theme/typography-vars.ts`
 * re-exports this. Pure: same `(typo)` → same map; `resolveFontStack`
 * guarantees a never-empty family even for loosely-typed vault data.
 */

import {
	FONT_ROLES,
	SYSTEM_TYPOGRAPHY,
	type TypographyDef,
	isTypographyScale,
	resolveFontStack,
} from "@brainstorm-os/sdk-types";

/** CSS var the renderer reads for a font role — mirrors the token family
 *  path (`text.family.<role>` → `--text-family-<role>`), so the contract
 *  drives the variables every `font-family: var(--text-family-*)` rule
 *  already uses, no consumer migration required. */
export function typographyCssVars(typo: TypographyDef | null | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const role of FONT_ROLES) {
		out[`--text-family-${role}`] = resolveFontStack(typo, role);
	}
	out["--typography-scale"] =
		typo && isTypographyScale(typo.scale) ? typo.scale : SYSTEM_TYPOGRAPHY.scale;
	return out;
}
