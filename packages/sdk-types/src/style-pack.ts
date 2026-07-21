/**
 * `brainstorm/StylePack/v1` — the optional fourth composable theme piece
 * (§What's distributed; OQ-183). A StylePack
 * is user-authored **raw CSS** that skins the shell + app chrome on top of
 * the token/icon/typography model, targeting the frozen `data-bs-*` hook
 * surface (see `style-hooks.ts`) rather than private class names.
 *
 * Unlike TokenSet/IconPack/Typography (passive data), a StylePack ships
 * code-shaped content, so it carries a **bundle validator** (see
 * `style-pack-sanitizer.ts`) that rejects the script / network / exfil
 * vectors doc 40 §Validation enumerates. A StylePack that fails the
 * sanitizer never installs.
 *
 * **Storage shape.** `properties.css` is the **authoritative** CSS — the
 * theme-editor reads/writes it directly and the validators + composite read
 * it. The code-editor edits it cross-app by adapting the entity into a CSS
 * file: it seeds its code buffer (the `Y.Text` named
 * {@link STYLE_PACK_BODY_ROOT}, the root `@brainstorm-os/editor`'s
 * `getCodeBuffer` binds) from `properties.css` and saves edits back to
 * `properties.css`. The StylePack declares {@link STYLE_PACK_CSS_MIME} so
 * the code-editor's `text/css` opener routes to it on the `open` intent.
 *
 * Dependency-free **contract freeze** (Stage 9.9.4) — shape + enums +
 * shipped default + structural validators. CSS *security* validation is
 * `style-pack-sanitizer.ts`; this file is pure structure. Near-leaf (only
 * `enum-guard` imported), barrel-re-exported with no cycle.
 */

import { enumGuard } from "./enum-guard";

export const STYLE_PACK_TYPE_URL = "brainstorm/StylePack/v1";

/** The MIME a StylePack entity declares so the code-editor's `text/css`
 *  opener routes to it (open-resolution matches on `mime` independent of
 *  entity type). Authoritative on `properties.mime`. */
export const STYLE_PACK_CSS_MIME = "text/css";

/** Root name of the `Y.Text` holding the canonical CSS in a StylePack
 *  entity's Y.Doc. Matches `@brainstorm-os/editor` `getCodeBuffer`'s root so
 *  the code-editor binds the same buffer when it opens the entity. */
export const STYLE_PACK_BODY_ROOT = "content";

/**
 * The StylePack entity payload (`properties` of a `brainstorm/StylePack/v1`
 * object). `css` is the denormalized mirror of the canonical body buffer;
 * `mime` is always {@link STYLE_PACK_CSS_MIME}.
 */
export type StylePackDef = {
	name: string;
	css: string;
	mime: string;
};

/** The shipped empty default — a named pack with no CSS. The editor seeds
 *  a new pack from this. */
export const EMPTY_STYLE_PACK: StylePackDef = Object.freeze({
	name: "Untitled style pack",
	css: "",
	mime: STYLE_PACK_CSS_MIME,
}) as StylePackDef;

/** Stable codes for StylePack **structural** validation failures (CSS
 *  security issues are `StylePackSanitizeCode` in the sanitizer). */
export enum StylePackIssueCode {
	EmptyName = "empty-name",
	MissingCss = "missing-css",
	WrongMime = "wrong-mime",
}

export type StylePackIssue = { code: StylePackIssueCode; message: string };

/**
 * Validate the **structure** of a `StylePackDef` — non-blank name, a
 * string `css` field, and the fixed `text/css` mime. Does NOT scan the CSS
 * for security issues (that's `sanitizeStylePackCss`). Returns every issue
 * (`[]` ⇒ structurally valid).
 */
export function validateStylePack(def: StylePackDef): StylePackIssue[] {
	const issues: StylePackIssue[] = [];
	if (typeof def.name !== "string" || def.name.trim().length === 0) {
		issues.push({ code: StylePackIssueCode.EmptyName, message: "Style pack name is empty." });
	}
	if (typeof def.css !== "string") {
		issues.push({ code: StylePackIssueCode.MissingCss, message: "Style pack has no CSS string." });
	}
	if (def.mime !== STYLE_PACK_CSS_MIME) {
		issues.push({
			code: StylePackIssueCode.WrongMime,
			message: `Style pack mime must be "${STYLE_PACK_CSS_MIME}".`,
		});
	}
	return issues;
}

export function isValidStylePack(def: StylePackDef): boolean {
	return validateStylePack(def).length === 0;
}

/**
 * The clean StylePack to actually persist — coerces a loosely-typed /
 * partial entity payload into a well-formed `StylePackDef`, never throwing
 * (the "always something / cleanly nothing" principle). Blank/missing
 * fields fall back to the empty default; mime is always normalized.
 */
export function resolveStylePack(def: Partial<StylePackDef> | null | undefined): StylePackDef {
	const name =
		typeof def?.name === "string" && def.name.trim().length > 0 ? def.name : EMPTY_STYLE_PACK.name;
	const css = typeof def?.css === "string" ? def.css : "";
	return { name, css, mime: STYLE_PACK_CSS_MIME };
}

export const STYLE_PACK_ISSUE_CODES = Object.freeze([
	StylePackIssueCode.EmptyName,
	StylePackIssueCode.MissingCss,
	StylePackIssueCode.WrongMime,
]) as readonly StylePackIssueCode[];

export const isStylePackIssueCode = enumGuard(STYLE_PACK_ISSUE_CODES);
