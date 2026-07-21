/**
 * extract-references — **folded into the shared `@brainstorm-os/sdk/note-references`
 * (B6.5)**. The Notes-side walker and the shell-side mirror were byte-for-byte
 * copies of the same recursive scan over a Lexical `SerializedEditorState`;
 * they now share one implementation. This module keeps the Notes-local names
 * (`ReferenceKind` / `ExtractedReference` / `extractReferences`) as aliases so
 * the backlinks panel + link-markup ops don't churn.
 *
 * The persisted node-type strings + `brainstorm://entity/` URI prefix stay
 * protocol; `extract-references.test.ts` feeds the Lexical node constants
 * (`MENTION_NODE_TYPE` et al. from `./nodes/*`) through the shared walker, so
 * any drift between the node identities and the walker is caught there.
 */

export {
	NoteReferenceKind as ReferenceKind,
	type NoteReference as ExtractedReference,
	extractNoteReferences as extractReferences,
	formatBrainstormEntityUri,
	parseBrainstormEntityUri,
} from "@brainstorm-os/sdk/note-references";
