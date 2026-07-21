/**
 * Language detection for the editor. The detector itself lives in
 * `@brainstorm-os/sdk/language-detect` (shared with the Preview app); this
 * module re-exports the per-signal helpers and names the editor's
 * `Unknown`-fallback resolver (`resolveLanguage`).
 */

import { type CodeLanguage, detectLanguage } from "@brainstorm-os/sdk/language-detect";

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
