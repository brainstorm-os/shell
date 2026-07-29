/**
 * Language detection for the editor. The detector itself lives in
 * `@brainstorm-os/sdk/language-detect` (shared with the Preview app); this
 * module re-exports the per-signal helpers and names the editor's
 * `Unknown`-fallback resolver (`resolveLanguage`).
 */

import { CodeLanguage, detectLanguage } from "@brainstorm-os/sdk/language-detect";

export {
	languageForExtension,
	languageForMime,
	languageForShebang,
} from "@brainstorm-os/sdk/language-detect";

/**
 * Resolves the best-guess language for a file: special filename / extension
 * → MIME → shebang. Returns `Unknown` only when every signal is empty.
 */
export function resolveLanguage(input: {
	path?: string;
	mime?: string;
	firstLine?: string;
}): CodeLanguage {
	return detectLanguage(input);
}

/**
 * The `language` a `CodeFile/v1` should carry after its `path` changed
 * (POLISH-FN-2). A rename that swaps the extension changes what the file IS —
 * `foo.ts` → `foo.md` must stop being tokenised as TypeScript, must stop
 * raising TypeScript diagnostics, and must stop labelling itself "TypeScript"
 * in the header chip. The rename path used to write `{ path }` alone, so the
 * create-time `language` (always `typescript`, from the `untitled.ts` default)
 * outlived every rename.
 *
 * Only a CONFIDENT re-derivation replaces the stored value: `Unknown` — a
 * name with no extension (`README`), or an extension we don't classify
 * (`notes.xyz`) — keeps whatever the file already had rather than degrading a
 * perfectly good language to a guess. `CodeFile/v1` carries no user-set
 * "language override" field, so there is no deliberate choice to clobber; if
 * one is ever added, this is the single call site that must consult it.
 */
export function languageAfterRename(
	current: CodeLanguage,
	nextPath: string,
	firstLine = "",
): CodeLanguage {
	const derived = detectLanguage({ path: nextPath, firstLine });
	return derived === CodeLanguage.Unknown ? current : derived;
}
