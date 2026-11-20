/**
 * `Book/v1` — an imported book in the vault (EPUB, FB2 or PDF). The binary
 * (the .epub / .fb2 / .pdf) lives outside the entity via the Files host service
 * (`fileId`, wired in 9.21.2); this entity is the catalog record + the
 * per-book reading state. See and the implementation plan
 * 9.21 ladder.
 */

import type { Icon } from "./icon";
import type { Locator } from "./locator";

/** The vault entity type id Books owns (mirrors the manifest). */
export const BOOK_ENTITY_TYPE = "brainstorm/Book/v1";

export enum BookFormat {
	Epub = "epub",
	Pdf = "pdf",
	/** FictionBook 2 — plain `.fb2` or zipped `.fb2.zip`. */
	Fb2 = "fb2",
}

/** Per-book reading position + progress (OQ-BK-4 lives at 9.21.6; the
 *  shape is frozen here so the renderer can persist against it). */
export type ReadingState = {
	/** Where the reader was last parked. `null` = never opened. */
	position: Locator | null;
	/** 0..1 fraction read, derived from `position` over the content length. */
	progress: number;
	/** Epoch ms of the last reading session, for the library "recent" sort. */
	lastReadAt: number | null;
};

export type Book = {
	id: string;
	name: string;
	icon: Icon | null;
	format: BookFormat;
	author: string;
	/** Files-host file id for the imported binary; `null` for the in-memory
	 *  preview sample (which carries no backing file). */
	fileId: string | null;
	/** Total spine items (chapters / pages) — denormalized for the library. */
	spineLength: number;
	reading: ReadingState;
	createdAt: number;
	updatedAt: number;
};

export function emptyReadingState(): ReadingState {
	return { position: null, progress: 0, lastReadAt: null };
}
