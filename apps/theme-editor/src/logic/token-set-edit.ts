/**
 * Pure immutable edits over a `TokenSetDef` + the preview-var composition
 * the in-editor live preview applies. Extracted from the DOM so the edit
 * semantics (blank value clears an override; preview = base then
 * overrides) are unit-tested without a browser.
 */

import { type TokenSetDef, resolveTokenOverrides } from "@brainstorm-os/sdk-types";

/** Set an override immutably. A blank/whitespace value clears it (an
 *  empty override is meaningless — the base shows through). */
export function setOverride(set: TokenSetDef, name: string, value: string): TokenSetDef {
	if (value.trim().length === 0) return clearOverride(set, name);
	return { ...set, overrides: { ...set.overrides, [name]: value } };
}

/** Remove an override immutably (no-op when absent). */
export function clearOverride(set: TokenSetDef, name: string): TokenSetDef {
	if (!(name in set.overrides)) return set;
	const { [name]: _removed, ...rest } = set.overrides;
	return { ...set, overrides: rest };
}

export function isOverridden(set: TokenSetDef, name: string): boolean {
	return Object.prototype.hasOwnProperty.call(set.overrides, name);
}

/** The effective value of a token — the override when present and
 *  non-blank, else the base value. */
export function effectiveValue(
	baseVars: Record<string, string>,
	set: TokenSetDef,
	name: string,
): string {
	const override = set.overrides[name];
	if (typeof override === "string" && override.trim().length > 0) return override;
	return baseVars[name] ?? "";
}

/** The full CSS-var map the live preview applies: every base value, with
 *  the set's clean overrides layered on top. */
export function composePreviewVars(
	baseVars: Record<string, string>,
	set: TokenSetDef,
): Record<string, string> {
	return { ...baseVars, ...resolveTokenOverrides(set) };
}
