/**
 * 9.15.3 — the Calendar-local *insert* affordance for the `inline-event`
 * BP block.
 *
 * The block render code (`src/blocks/inline-event/entry.ts`) already
 * builds to `dist/blocks/inline-event.js` and is served live by the
 * shell's `bsblock://` loader; a host document mounts it through
 * `@brainstorm-os/sdk/block-mount` `BpBlockMount`, resolving the providing
 * app via `services.blocks.forType("brainstorm/Event/v1")`. What was
 * missing was the entry point on Calendar's side: a way for the user to
 * put an event onto the clipboard so a document can embed it.
 *
 * Copying writes the canonical `brainstorm://entity/<eventId>` URI
 * (minted through the single point so its grammar always matches the
 * parser) as plain text. Pasting it into a Notes document is recognised
 * by the embed/link path, which looks up the Event type's live block —
 * the very `inline-event` bundle this app provides — and mounts it
 * inline. No event blockId fragment is added: the embed renders the
 * whole event, not a sub-block anchor.
 *
 * Mirrors Notes' `copyBlockLink` (B11.13): fail-closed against a denied
 * or absent Clipboard API so a copy command can never tear down the app.
 */

import { formatBrainstormEntityUri } from "@brainstorm-os/sdk/note-references";

/** Build the clipboard payload for embedding an event as an inline
 *  block: the plain `brainstorm://entity/<eventId>` URI. Kept separate
 *  from the clipboard write so the wire format is unit-testable without a
 *  Clipboard API. */
export function eventBlockRef(eventId: string): string {
	return formatBrainstormEntityUri(eventId);
}

/** Write the event's block reference to the clipboard. Resolves to
 *  whether the write succeeded — a denied or unavailable Clipboard API is
 *  a no-op (`false`), never a throw. */
export async function copyEventBlockRef(eventId: string): Promise<boolean> {
	const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
	if (!clipboard?.writeText) return false;
	try {
		await clipboard.writeText(eventBlockRef(eventId));
		return true;
	} catch {
		return false;
	}
}
