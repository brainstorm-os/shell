/**
 * Pure-logic helpers for the `@`-mention typeahead.
 *
 *   - `detectMentionTrigger` — given the text content of the current
 *     paragraph and the caret offset, find the `@<query>` segment the
 *     caret is sitting inside (if any). Returns the trigger offset +
 *     query string. Triggers only when the `@` follows whitespace,
 *     punctuation, or the start of the paragraph (so `email@host` does
 *     not pop the menu).
 *   - `filterEntities` — rank entities by title prefix > word-start >
 *     anywhere against a trimmed query. Empty query keeps everything
 *     in title order. The notes app filters out the *currently-open
 *     note* so a user can't self-mention.
 *   - `entityDisplayName` — read a vault entity's user-facing title,
 *     falling back to its id when nothing reads as a name.
 *
 * Lives in a standalone module so the trigger + ranking logic can be
 * unit-tested without the editor surface or jsdom.
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";

export type MentionTrigger = {
	/** Character offset (in the paragraph text) where `@` sits. */
	triggerOffset: number;
	/** Substring between `@` and the caret. */
	query: string;
};

const MAX_QUERY_LENGTH = 64;

/** Walk back from the caret looking for an `@` that opens a mention
 *  context. Returns `null` if the caret isn't inside one.
 *
 *  An `@` opens a mention context when it's the first character of the
 *  paragraph OR the character before it is whitespace or one of a few
 *  punctuation marks. Anything else (a letter or digit) means the `@`
 *  is part of an email-style token — we leave that alone. */
export function detectMentionTrigger(text: string, caret: number): MentionTrigger | null {
	if (caret < 0 || caret > text.length) return null;
	for (let i = caret - 1; i >= 0; i--) {
		const ch = text.charAt(i);
		if (ch === "@") {
			const before = i === 0 ? "" : text.charAt(i - 1);
			// `!@` is the transclusion trigger, not a mention — defer to it so a
			// single `!@` doesn't satisfy both grammars and open two stacked
			// typeaheads (the journal double-menu bug).
			if (before === "!") return null;
			if (!isMentionBoundary(before)) return null;
			const query = text.slice(i + 1, caret);
			if (query.length > MAX_QUERY_LENGTH) return null;
			if (containsBreak(query)) return null;
			return { triggerOffset: i, query };
		}
		// A line break or whitespace before the `@` means we already left
		// the trigger context; stop scanning.
		if (ch === "\n") return null;
	}
	return null;
}

function isMentionBoundary(ch: string): boolean {
	if (ch === "") return true;
	if (/\s/.test(ch)) return true;
	return /[(\[{<,;:!?"'`-]/.test(ch);
}

function containsBreak(query: string): boolean {
	return /[\s\n]/.test(query);
}

export type EntityFilterResult = {
	entity: VaultEntity;
	rank: number;
};

const RANK_PREFIX = 0;
const RANK_WORD = 1;
const RANK_ANYWHERE = 2;

/** Rank entities by title against a (possibly empty) query. Excludes
 *  any entity whose id is in `excludeIds` (typically the currently-open
 *  note, so a user can't `@`-mention themselves). */
export function filterEntities(
	entities: Iterable<VaultEntity>,
	query: string,
	excludeIds: ReadonlySet<string> = new Set(),
): readonly EntityFilterResult[] {
	const q = query.trim().toLowerCase();
	const out: EntityFilterResult[] = [];
	for (const entity of entities) {
		if (excludeIds.has(entity.id)) continue;
		const name = entityDisplayName(entity).toLowerCase();
		if (!q) {
			out.push({ entity, rank: 0 });
			continue;
		}
		if (name.startsWith(q)) {
			out.push({ entity, rank: RANK_PREFIX });
		} else if (matchesWordStart(name, q)) {
			out.push({ entity, rank: RANK_WORD });
		} else if (name.includes(q)) {
			out.push({ entity, rank: RANK_ANYWHERE });
		}
	}
	out.sort((a, b) => {
		if (a.rank !== b.rank) return a.rank - b.rank;
		const an = entityDisplayName(a.entity);
		const bn = entityDisplayName(b.entity);
		return an.localeCompare(bn);
	});
	return out;
}

function matchesWordStart(name: string, q: string): boolean {
	let i = 0;
	while (i < name.length) {
		const start = i === 0 || /\s|[-_/]/.test(name.charAt(i - 1));
		if (start && name.startsWith(q, i)) return true;
		i += 1;
	}
	return false;
}

/** User-facing title for a vault entity, falling back to its id when
 *  `properties.title` / `properties.name` are missing or blank.
 *
 *  Reads `title` first, then `name` — Notes write `title`; future
 *  apps may write `name`. The fallback keeps the typeahead useful
 *  even on entities without a friendly title yet. */
export function entityDisplayName(entity: VaultEntity): string {
	const props = entity.properties ?? {};
	const title = readString(props, "title");
	if (title) return title;
	const name = readString(props, "name");
	if (name) return name;
	return entity.id;
}

/** Friendly caption for an entity type in the mention picker — the bare
 *  `TypeName` out of a `<namespace>/<TypeName>/v<n>` id (e.g.
 *  `io.brainstorm.notes/Note/v1` → `Note`, `brainstorm/Person/v1` →
 *  `Person`). Falls back to the raw type for shapes it can't parse, so a
 *  member/contact mention reads "Person" rather than the URI. */
export function mentionEntityTypeLabel(type: string): string {
	const segments = type.split("/").filter((s) => s.length > 0);
	if (segments.length >= 2) {
		const last = segments[segments.length - 1] ?? "";
		const candidate = /^v\d+$/i.test(last) ? segments[segments.length - 2] : last;
		if (candidate) return candidate;
	}
	return type;
}

function readString(props: Record<string, unknown>, key: string): string | null {
	const value = props[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
