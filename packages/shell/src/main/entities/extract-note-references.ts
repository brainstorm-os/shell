/**
 * Shell-side note-reference walker — **folded into the shared
 * `@brainstorm-os/sdk/note-references` (B6.5)**. This module is now a thin
 * re-export bridge: the walk + the persisted-node protocol constants live in
 * one place the Notes app and the shell main process both import, so the two
 * copies can no longer drift. Shell consumers keep importing the same names
 * from here.
 *
 * The MentionNode `type` strings + the `brainstorm://entity/` URI prefix stay
 * protocol — see `@brainstorm-os/sdk/note-references` and the Notes-side parity
 * test that pins the Lexical node constants to them.
 */

export {
	BLOCK_EMBED_NODE_TYPE,
	MENTION_NODE_TYPE,
	NoteReferenceKind,
	TRANSCLUSION_NODE_TYPE,
	type NoteReference,
	coerceNoteReferences,
	extractNoteReferences,
	parseBrainstormEntityUri,
} from "@brainstorm-os/sdk/note-references";
