/**
 * 9.12 (embedded-list ladder) — the Database-local *insert* affordance for
 * the `io.brainstorm.database/embedded-list` BP block.
 *
 * The block render code (`src/blocks/embedded-list/entry.ts`) already builds
 * to `dist/blocks/embedded-list.js` and is served live by the shell's
 * `bsblock://` block-bundle loader; a host document mounts it through
 * `@brainstorm-os/sdk/block-mount` `BpBlockMount`, resolving the providing app
 * via `services.blocks.forType("brainstorm/List/v1")`. What was missing was
 * the entry point on Database's side: a way for the user to put a List onto
 * the clipboard so a document can embed it.
 *
 * Copying writes the canonical `brainstorm://entity/<listId>` URI (minted
 * through the single point so its grammar always matches the parser) as plain
 * text. Pasting it into a Notes document is recognised by the embed/link
 * path, which looks up the List type's live block — the very `embedded-list`
 * bundle this app provides — and mounts it inline as a live, read-only grid.
 * No block fragment is added: the embed renders the whole list, not a
 * sub-block anchor.
 *
 * Mirrors Calendar's `copyEventBlockRef` (9.15.3): fail-closed against a
 * denied or absent Clipboard API so a copy command can never tear down the
 * app.
 */

import { formatBrainstormEntityUri } from "@brainstorm-os/sdk/note-references";

/** Build the clipboard payload for embedding a list as an inline block: the
 *  plain `brainstorm://entity/<listId>` URI. Kept separate from the clipboard
 *  write so the wire format is unit-testable without a Clipboard API. */
export function listBlockRef(listId: string): string {
	return formatBrainstormEntityUri(listId);
}

/** Write the list's block reference to the clipboard. Resolves to whether the
 *  write succeeded — a denied or unavailable Clipboard API is a no-op
 *  (`false`), never a throw. */
export async function copyListBlockRef(listId: string): Promise<boolean> {
	const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
	if (!clipboard?.writeText) return false;
	try {
		await clipboard.writeText(listBlockRef(listId));
		return true;
	} catch {
		return false;
	}
}
