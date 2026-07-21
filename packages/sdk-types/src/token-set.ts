/**
 * `brainstorm/TokenSet/v1` — concrete values for the semantic design
 * tokens (§What's distributed). One of the
 * three composable theme pieces alongside IconPack + Typography (a
 * `brainstorm/Theme/v1` points at all three); the theme-editor (9.9)
 * authors these and the render layer applies the resolved values.
 *
 * A TokenSet is a **partial override map**, not an embedded copy of the
 * full `Tokens` tree: authors ship subsets ("Solarized Dark token set,
 * pairs with Phosphor") and the render layer already composes base →
 * override. `overrides` is keyed by the SAME flattened `--kebab` CSS
 * variable names `flattenTokens()` emits (`--color-background-primary`),
 * each member of the canonical namespace (`token-names.ts`); doc 40
 * §Validation rejects unknown token names.
 *
 * Dependency-free **contract freeze** (Stage 9.9.1) — the shape + enums
 * + the shipped `EMPTY_TOKEN_SET` default + validators + a defensive
 * resolver. Near-leaf (only the shared `enum-guard` + `token-names`
 * leaves are imported), barrel-re-exported with no cycle. OQ-170/171
 * non-blocking.
 */

import { enumGuard } from "./enum-guard";
import { isCanonicalTokenName } from "./token-names";

export const TOKEN_SET_TYPE_URL = "brainstorm/TokenSet/v1";

/** Which appearance a token set targets. Values match the
 *  `@brainstorm-os/tokens` `ThemeAppearance` enum at the string layer so
 *  the two vocabularies are interchangeable without a cross-package
 *  dependency. */
export enum TokenSetAppearance {
	Light = "light",
	Dark = "dark",
}

export const TOKEN_SET_APPEARANCES = Object.freeze([
	TokenSetAppearance.Light,
	TokenSetAppearance.Dark,
]) as readonly TokenSetAppearance[];

/**
 * The TokenSet entity payload (`properties` of a `brainstorm/TokenSet/v1`
 * object). `overrides` is a sparse map from canonical token name to a CSS
 * value string; only the tokens the author changed appear.
 */
export type TokenSetDef = {
	name: string;
	appearance: TokenSetAppearance;
	overrides: Record<string, string>;
};

/**
 * The shipped empty default — a named set that overrides nothing (the
 * base theme shows through everywhere). Every authored set composes on
 * top of the base; this is the starting point the editor seeds a new
 * set from.
 */
export const EMPTY_TOKEN_SET: TokenSetDef = Object.freeze({
	name: "Untitled token set",
	appearance: TokenSetAppearance.Light,
	overrides: Object.freeze({}) as Record<string, string>,
}) as TokenSetDef;

export const isTokenSetAppearance = enumGuard(TOKEN_SET_APPEARANCES);

/**
 * The clean override map to actually apply — only well-formed
 * `(canonical token name, non-blank string value)` pairs survive;
 * loosely-typed / unknown / blank entries are dropped. Never throws on
 * partial or malformed vault data (the "always render something / cleanly
 * nothing" principle, applied to token overrides).
 */
export function resolveTokenOverrides(set: TokenSetDef | null | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	const overrides = set?.overrides;
	if (!overrides || typeof overrides !== "object") return out;
	for (const [name, value] of Object.entries(overrides)) {
		if (!isCanonicalTokenName(name)) continue;
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length > 0) out[name] = trimmed;
	}
	return out;
}

/** Stable codes for TokenSet validation failures (enum, not bare
 *  literals, per the no-string-discriminator convention). */
export enum TokenSetIssueCode {
	EmptyName = "empty-name",
	InvalidAppearance = "invalid-appearance",
	MissingOverrides = "missing-overrides",
	UnknownToken = "unknown-token",
	EmptyValue = "empty-value",
}

export type TokenSetIssue = { code: TokenSetIssueCode; message: string; token?: string };

/**
 * Validate a `TokenSetDef`. Returns every issue (`[]` ⇒ valid) so the
 * theme editor can surface them at once. A well-formed set has a
 * non-blank name, a valid appearance, an `overrides` object, and every
 * override keyed by a known token name with a non-blank value. (Contrast
 * / focus-ring lint from doc 40 §Validation is 9.9.6 — this contract is
 * pure structural.)
 */
export function validateTokenSet(def: TokenSetDef): TokenSetIssue[] {
	const issues: TokenSetIssue[] = [];
	if (typeof def.name !== "string" || def.name.trim().length === 0) {
		issues.push({ code: TokenSetIssueCode.EmptyName, message: "Token set name is empty." });
	}
	if (!isTokenSetAppearance(def.appearance)) {
		issues.push({
			code: TokenSetIssueCode.InvalidAppearance,
			message: `Unknown token-set appearance "${String(def.appearance)}".`,
		});
	}
	if (!def.overrides || typeof def.overrides !== "object") {
		issues.push({
			code: TokenSetIssueCode.MissingOverrides,
			message: "Token set has no overrides map.",
		});
		return issues;
	}
	for (const [name, value] of Object.entries(def.overrides)) {
		if (!isCanonicalTokenName(name)) {
			issues.push({
				code: TokenSetIssueCode.UnknownToken,
				message: `Unknown semantic token "${name}".`,
				token: name,
			});
			continue;
		}
		if (typeof value !== "string" || value.trim().length === 0) {
			issues.push({
				code: TokenSetIssueCode.EmptyValue,
				message: `Token "${name}" has an empty value.`,
				token: name,
			});
		}
	}
	return issues;
}

export function isValidTokenSet(def: TokenSetDef): boolean {
	return validateTokenSet(def).length === 0;
}
