/**
 * `brainstorm/CodeFile/v1` — entity shape for an editable source-code
 * file. Schema is also declared inline in `manifest.json`. Persisted
 * shape mirrors the manifest's `schema` block.
 */

// The language enum, its ordered list, and the membership guard live in
// `@brainstorm-os/sdk/language-detect` (shared with the Preview app). Re-export
// under the `LanguageKey` name the Code Editor uses everywhere.
import type { CodeLanguage } from "@brainstorm-os/sdk/language-detect";

export {
	CodeLanguage as LanguageKey,
	CODE_LANGUAGES as LANGUAGES,
	isCodeLanguage as isLanguageKey,
} from "@brainstorm-os/sdk/language-detect";

export interface CodeFile {
	/** Stable opaque id. */
	id: string;
	/** Vault-relative organizing string (e.g. `snippets/runtime.ts`). Not a
	 *  filesystem path — `CodeFile/v1` is vault-resident in v1, edited
	 *  through the app rather than mirrored from a source tree. */
	path: string;
	language: CodeLanguage;
	sizeBytes: number | null;
	lineCount: number | null;
	isDirty: boolean;
	lastOpenedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface BufferState {
	codeFileId: string;
	content: string;
	cursorOffset: number;
	scrollTop: number;
	isDirty: boolean;
}
