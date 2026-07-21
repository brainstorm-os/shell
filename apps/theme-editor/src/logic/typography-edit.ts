/**
 * Pure immutable edits over a `TypographyDef` + the "is this still the
 * system default?" check the save flow uses to decide between a builtin
 * reference and a persisted `Typography/v1` entity. Extracted from the
 * DOM so the font-role mapping semantics unit-test without a browser.
 */

import {
	FONT_ROLES,
	type FontRole,
	SYSTEM_TYPOGRAPHY,
	type TypographyDef,
	type TypographyScale,
} from "@brainstorm-os/sdk-types";

/** A fresh editable typography seeded from the never-empty system stacks
 *  (so a brand-new typography is structurally valid before any edit). */
export function seedTypography(name: string): TypographyDef {
	return { name, scale: SYSTEM_TYPOGRAPHY.scale, fonts: { ...SYSTEM_TYPOGRAPHY.fonts } };
}

export function setFontStack(typo: TypographyDef, role: FontRole, stack: string): TypographyDef {
	return { ...typo, fonts: { ...typo.fonts, [role]: { stack } } };
}

export function setScale(typo: TypographyDef, scale: TypographyScale): TypographyDef {
	return { ...typo, scale };
}

export function setTypographyName(typo: TypographyDef, name: string): TypographyDef {
	return { ...typo, name };
}

/** True when every role's stack + the scale match the system default
 *  (the name is ignored) — i.e. the author hasn't actually customised
 *  typography, so the theme should keep the builtin `system` reference
 *  rather than persisting a redundant entity. */
export function isSystemTypography(typo: TypographyDef): boolean {
	if (typo.scale !== SYSTEM_TYPOGRAPHY.scale) return false;
	return FONT_ROLES.every((role) => typo.fonts[role]?.stack === SYSTEM_TYPOGRAPHY.fonts[role].stack);
}
