/**
 * Pure immutable edits for the StylePack pane (9.9.4). The sanitizer +
 * structural validators live in `@brainstorm-os/sdk-types`; this is just the
 * state-transition layer the app owns (mirrors `token-set-edit.ts`).
 */

import { STYLE_PACK_CSS_MIME, type StylePackDef } from "@brainstorm-os/sdk-types";

export function setStylePackCss(def: StylePackDef, css: string): StylePackDef {
	return { ...def, css, mime: STYLE_PACK_CSS_MIME };
}

export function setStylePackName(def: StylePackDef, name: string): StylePackDef {
	return { ...def, name, mime: STYLE_PACK_CSS_MIME };
}

/** `true` iff the pack carries authored CSS (an empty pack drops its theme
 *  ref on save rather than persisting an empty entity). */
export function hasStylePackCss(def: StylePackDef): boolean {
	return def.css.trim().length > 0;
}
