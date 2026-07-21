/**
 * "Copy link to block" payload (B11.13). Builds the shareable
 * `brainstorm://entity/<documentId>#block-<blockId>` URI via the single
 * minting point (`formatBrainstormEntityUri`, so the fragment grammar always
 * matches `parseBrainstormEntityUri`) and writes it to the clipboard.
 *
 * The `blockId` here is the *session* block id (the top-level Lexical
 * NodeKey, what `stableBlockId` returns) — the same anchor B11.9 comments
 * use. A fully-persistent cross-reload block id waits on Lexical NodeState;
 * the scroll-into-window + place-caret-on-open consumer is the follow-up rung.
 */

import { formatBrainstormEntityUri } from "@brainstorm-os/sdk/note-references";

/** Write the block link to the clipboard. Resolves to whether the write
 *  succeeded — a denied or unavailable Clipboard API is a no-op (returns
 *  `false`), never a throw, so a copy command can't tear down the editor. */
export async function copyBlockLink(documentId: string, blockId: string): Promise<boolean> {
	const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
	if (!clipboard?.writeText) return false;
	try {
		await clipboard.writeText(formatBrainstormEntityUri(documentId, blockId));
		return true;
	} catch {
		return false;
	}
}
