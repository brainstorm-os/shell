/**
 * Pure builder for the `@`-typeahead option list (B11.1). Combines two
 * sources into one ordered, keyboard-navigable list:
 *
 *   1. **Date mentions** — `@today` / `@tomorrow` / `@yesterday` / a valid
 *      ISO day (via `dateMentionCandidates`). Listed first so the common
 *      "jot a date" path is one keystroke + Enter.
 *   2. **Entity mentions** — vault entities ranked by title
 *      (`filterEntities`), excluding the open note.
 *
 * A discriminated union so the plugin's insert + render branch on `kind`
 * without re-deriving anything. Kept Lexical-free so the ordering is unit-
 * testable without the editor surface.
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";
import { type DateMention, dateMentionCandidates } from "./date-mention";
import { type EntityFilterResult, filterEntities } from "./mention-ops";

export enum TypeaheadOptionKind {
	Date = "date",
	Entity = "entity",
}

export type DateOption = { kind: TypeaheadOptionKind.Date; date: DateMention };
export type EntityOption = { kind: TypeaheadOptionKind.Entity } & EntityFilterResult;
export type TypeaheadOption = DateOption | EntityOption;

export function buildTypeaheadOptions(
	entities: Iterable<VaultEntity>,
	query: string,
	now: number,
	excludeIds: ReadonlySet<string> = new Set(),
): readonly TypeaheadOption[] {
	const dates: TypeaheadOption[] = dateMentionCandidates(query, now).map((date) => ({
		kind: TypeaheadOptionKind.Date,
		date,
	}));
	const ents: TypeaheadOption[] = filterEntities(entities, query, excludeIds).map((result) => ({
		kind: TypeaheadOptionKind.Entity,
		...result,
	}));
	return [...dates, ...ents];
}
