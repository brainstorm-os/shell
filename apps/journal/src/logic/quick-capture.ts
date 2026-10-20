/**
 * Quick-capture routing (9.16.14) — the pure half of the capture stream on
 * today's entry. A captured line either lands in the day as a plain line, or,
 * when it carries a `#tag` naming one of the user's Collections, is FILED: a
 * new object (titled with the line, tag removed) joins that Collection and
 * the day keeps a line linking to it.
 *
 * A tag matches a Collection by slug — "#reading-list" ↔ "Reading list",
 * case- and accent-insensitive. The first tag in the line that names a real
 * Collection wins; an unknown tag is just text, so the line stays a plain
 * line with the tag intact. A line that is ONLY a tag has nothing to file
 * and stays a plain line too.
 */

export enum CaptureKind {
	Empty = "empty",
	Line = "line",
	File = "file",
}

export type CaptureCollection = { id: string; name: string };

export type CaptureRoute =
	| { kind: CaptureKind.Empty }
	| { kind: CaptureKind.Line; text: string }
	| {
			kind: CaptureKind.File;
			/** The whole line as typed (tag included) — what the day keeps
			 *  beside the link to the filed object. */
			text: string;
			/** The line minus the routing tag — the new object's title. */
			title: string;
			/** The tag as typed, without `#`. */
			tag: string;
			collection: CaptureCollection;
	  };

const TAG_RE = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

/** The comparable form of a Collection name or a tag: accents folded,
 *  lower-cased, every run of non-alphanumerics collapsed to one `-`. */
export function captureSlug(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
}

/** Every `#tag` in the line, in order, without the `#`. */
export function captureTags(line: string): string[] {
	const tags: string[] = [];
	for (const match of line.matchAll(TAG_RE)) {
		const tag = match[2];
		if (tag) tags.push(tag);
	}
	return tags;
}

function withoutTag(line: string, tag: string): string {
	let removed = false;
	const stripped = line.replace(TAG_RE, (whole, lead: string, found: string) => {
		if (removed || found !== tag) return whole;
		removed = true;
		return lead;
	});
	return stripped.replace(/\s+/g, " ").trim();
}

export function routeCapture(raw: string, collections: readonly CaptureCollection[]): CaptureRoute {
	const text = raw.replace(/\s+/g, " ").trim();
	if (text === "") return { kind: CaptureKind.Empty };
	const bySlug = new Map<string, CaptureCollection>();
	for (const collection of collections) {
		const slug = captureSlug(collection.name);
		if (slug !== "" && !bySlug.has(slug)) bySlug.set(slug, collection);
	}
	for (const tag of captureTags(text)) {
		const collection = bySlug.get(captureSlug(tag));
		if (!collection) continue;
		const title = withoutTag(text, tag);
		if (title === "") return { kind: CaptureKind.Line, text };
		return { kind: CaptureKind.File, text, title, tag, collection };
	}
	return { kind: CaptureKind.Line, text };
}
