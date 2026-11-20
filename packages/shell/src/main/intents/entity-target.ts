/**
 * Resolves an entity id to its open-routing coordinates — the BP `type`
 * and (for file-shaped entities) the `mime`.
 *
 * Why this exists: a click usually only carries the *entity id* (a Notes
 * `@`-mention, a graph node, a "Linked from" row). The intents bus matches
 * handlers on `entityType` / `mime`, so without resolving the id to a type
 * the dispatch falls through to wildcard-only handlers and a type-specific
 * opener (Notes for `Note/v1`, Files for `Folder/v1`, Preview for an image)
 * is never selected. Resolution is shell-side so apps never need read
 * capability on the target just to navigate to it (per
 *  §Resolution — resolution is always
 * shell-mediated).
 */

import type { EntitiesRepository } from "../storage/entities-repo";

export type EntityTarget = {
	type?: string;
	mime?: string;
};

export type EntityTargetResolver = (entityId: string) => Promise<EntityTarget | null>;

/** The two property keys a file-as-entity uses for its MIME, in order of
 *  preference. Kept here so the open resolver and any future file indexer
 *  read the same shape. */
const MIME_PROPERTY_KEYS = ["mime", "mimeType"] as const;

export function mimeFromProperties(properties: Record<string, unknown>): string | undefined {
	for (const key of MIME_PROPERTY_KEYS) {
		const value = properties[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** MIME values that say nothing about what a file is. */
const UNINFORMATIVE_MIMES: ReadonlySet<string> = new Set([
	"application/octet-stream",
	"application/zip",
]);

/** Book formats by filename suffix, longest first. */
const BOOK_MIME_BY_SUFFIX: ReadonlyArray<readonly [suffix: string, mime: string]> = [
	[".fb2.zip", "application/x-zip-compressed-fb2"],
	[".epub", "application/epub+zip"],
	[".fb2", "application/x-fictionbook+xml"],
];

/**
 * The MIME an `open` is routed on. Normally the stored one — but a file row
 * written before EPUB / FB2 had a label carries `application/octet-stream`,
 * which matches no opener, so the book could not be opened from the file
 * manager at all. For those rows (and only when the stored value is
 * uninformative) the file's NAME decides, by its final extension:
 * `Dune.fb2.epub` is an EPUB. Read-only — nothing is rewritten here; the
 * reader corrects the stored label when it opens the file.
 */
export function routingMimeFromProperties(properties: Record<string, unknown>): string | undefined {
	const stored = mimeFromProperties(properties);
	// No stored MIME means "not a file-shaped entity" — a Note that happens
	// to be titled `draft.epub` must keep routing by its type alone.
	if (stored === undefined || !UNINFORMATIVE_MIMES.has(stored)) return stored;
	const name = typeof properties.name === "string" ? properties.name.trim().toLowerCase() : "";
	const match = BOOK_MIME_BY_SUFFIX.find(([suffix]) => name.endsWith(suffix));
	return match?.[1] ?? stored;
}

/**
 * Build a resolver over the active vault's entities repo. Per-call repo
 * lookup (not a captured handle) so a vault switch can't read a closed DB.
 * Any failure resolves to `null` — the bus then falls back to whatever the
 * caller put in the payload, never throwing the navigation.
 */
export function makeEntityTargetResolver(
	getRepo: () => Promise<EntitiesRepository | null>,
): EntityTargetResolver {
	return async (entityId: string): Promise<EntityTarget | null> => {
		try {
			const repo = await getRepo();
			if (!repo) return null;
			const row = repo.get(entityId);
			if (!row) return null;
			const mime = routingMimeFromProperties(row.properties);
			return mime !== undefined ? { type: row.type, mime } : { type: row.type };
		} catch {
			return null;
		}
	};
}
