/**
 * Pure evaluator for `ListSource` against an in-memory entity + link set.
 * Returns the set of entity ids that the source criteria resolves to —
 * before `members.include` / `members.exclude` overrides land on top.
 *
 * Promoted from `apps/database/src/logic/evaluate-source.ts` (9.12.3): the
 * shell's entities service resolves saved-List sources with THIS evaluator
 * (SQL fast paths for the indexable kinds, this code for the rest), so the
 * Database renderer and the service path cannot drift — parity by
 * construction. The renderer only consumes the resolved id set; swapping in
 * the live service is a substitution, not a renderer rewrite.
 */

import {
	CompositeOp,
	LinkDirection,
	type ListSource,
	ListSourceKind,
} from "@brainstorm-os/sdk-types";
import { effectiveMembers } from "../collections";
import type { InMemoryVault } from "../in-memory-entities";
import { evaluatePredicate } from "./evaluate-predicate";

export function evaluateSource(source: ListSource | null, db: InMemoryVault): Set<string> {
	if (source === null) return new Set();
	switch (source.kind) {
		case ListSourceKind.ByType:
			return collectByType(db, source.types);
		case ListSourceKind.ByFilter:
			return collectByFilter(db, source.where);
		case ListSourceKind.ByLink:
			return collectByLink(db, source);
		case ListSourceKind.ByVocabulary:
			return collectByVocabulary(db, source.vocabularyId, source.values);
		case ListSourceKind.Composite:
			return collectComposite(db, source);
	}
}

function collectByType(db: InMemoryVault, types: ReadonlyArray<string>): Set<string> {
	const want = new Set(types);
	const out = new Set<string>();
	for (const e of db.entities) {
		if (e.deletedAt !== null) continue;
		if (want.has(e.type)) out.add(e.id);
	}
	return out;
}

function collectByFilter(
	db: InMemoryVault,
	where: Parameters<typeof evaluatePredicate>[1],
): Set<string> {
	const out = new Set<string>();
	for (const e of db.entities) {
		if (e.deletedAt !== null) continue;
		if (evaluatePredicate(e, where)) out.add(e.id);
	}
	return out;
}

/** The anchor id set for a `byLink` source — the union of the legacy single
 *  `anchorEntityId` and the multi-anchor `anchorEntityIds` (OQ-LD-1 (b)). */
export function byLinkAnchors(source: {
	anchorEntityId?: string;
	anchorEntityIds?: string[];
}): Set<string> {
	const anchors = new Set<string>(source.anchorEntityIds ?? []);
	if (source.anchorEntityId) anchors.add(source.anchorEntityId);
	return anchors;
}

function collectByLink(
	db: InMemoryVault,
	source: {
		linkType: string;
		direction: LinkDirection;
		anchorEntityId?: string;
		anchorEntityIds?: string[];
	},
): Set<string> {
	const anchors = byLinkAnchors(source);
	const out = new Set<string>();
	if (anchors.size === 0) return out;
	for (const link of db.links) {
		if (link.deletedAt !== null) continue;
		if (link.linkType !== source.linkType) continue;
		// Implicit OR across anchors: a member reachable from ANY anchor matches.
		if (source.direction === LinkDirection.Out) {
			if (anchors.has(link.sourceEntityId)) out.add(link.destEntityId);
		} else if (anchors.has(link.destEntityId)) {
			out.add(link.sourceEntityId);
		}
	}
	return out;
}

/** `byVocabulary` resolves to entities that hold any of `values` (or any
 *  value if `values` is omitted) under a property pointing at `vocabularyId`.
 *  In the preview the linkage is implicit — every multi-select / single-
 *  select stores its value under a top-level property whose key matches the
 *  vocabularyId, and the entry envelopes carry a `vocabularyId` field. Real
 *  Stage 9.3 dispatch reads PropertySchema → property path lookup; the
 *  contract for the renderer is identical. */
function collectByVocabulary(
	db: InMemoryVault,
	vocabularyId: string,
	values: ReadonlyArray<string> | undefined,
): Set<string> {
	const out = new Set<string>();
	for (const e of db.entities) {
		if (e.deletedAt !== null) continue;
		for (const [, raw] of Object.entries(e.properties)) {
			const items = Array.isArray(raw) ? raw : [raw];
			for (const item of items) {
				if (!item || typeof item !== "object") continue;
				const obj = item as { vocabularyId?: string; value?: string };
				if (obj.vocabularyId !== vocabularyId) continue;
				if (!values || (typeof obj.value === "string" && values.includes(obj.value))) {
					out.add(e.id);
					break;
				}
			}
		}
	}
	return out;
}

function collectComposite(
	db: InMemoryVault,
	source: { op: CompositeOp; sources: ReadonlyArray<ListSource> },
): Set<string> {
	if (source.sources.length === 0) return new Set();
	const childSets = source.sources.map((s) => evaluateSource(s, db));
	if (source.op === CompositeOp.And) {
		return intersectAll(childSets);
	}
	return unionAll(childSets);
}

/** Intersection of every set — the `composite AND` semantics. Exported for
 *  the shell's fast-path composer, which must combine SQL-resolved child
 *  sets exactly the way this evaluator combines in-memory ones. */
export function intersectAll(sets: Set<string>[]): Set<string> {
	const first = sets[0];
	if (!first) return new Set();
	const out = new Set<string>();
	for (const id of first) {
		if (sets.every((s) => s.has(id))) out.add(id);
	}
	return out;
}

/** Union of every set — the `composite OR` semantics (see `intersectAll`). */
export function unionAll(sets: Set<string>[]): Set<string> {
	const out = new Set<string>();
	for (const s of sets) for (const id of s) out.add(id);
	return out;
}

/** Apply `members.include` / `members.exclude` to the source-resolved set.
 *  `effective(L) = (source ∪ include) \ exclude`, per
 *  §Effective members. */
export function applyMemberOverrides(
	resolved: Set<string>,
	include: ReadonlyArray<{ entityId: string }>,
	exclude: ReadonlyArray<{ entityId: string }>,
): Set<string> {
	// Canonical formula lives in `../collections` (9.3.5.1) so every consumer
	// computes membership identically.
	return effectiveMembers(resolved, { include, exclude });
}
