/**
 * `derive-property-ref-links` — pure keystone that emits **structured**
 * edges from properties that *already* carry entity ids but never made
 * it into the link table.
 *
 * Distinct from [[derive-shared-property-links]] (which emits *inferred*
 * pairwise edges from shared vocabulary values): the rules here read an
 * **array of entity ids** off the source entity and emit one
 * source→dest edge per listed id. Canonical case: `Folder.members[]`
 * lists the entity ids of the folder's contents (DesignDocs, sub-
 * Folders) but the projection never generated `Folder/contains` edges,
 * so seeded folders + all their member docs were orphans in the graph.
 *
 * Pure + deterministic: no I/O, no clock. Same entity set → same
 * link array. The dangling filter on the read side strips edges to
 * destinations not in the snapshot, so a stale id in the array never
 * paints a ghost edge.
 */

import type { PropertyDef } from "@brainstorm-os/sdk-types";
import { ValueType } from "@brainstorm-os/sdk-types";
import type { VaultEntity, VaultLink } from "./vault-entities-service";

/** A single rule. Walks every entity matching `entityType`, reads
 *  `propertyPath` as an entity id (or array of ids), emits one edge
 *  per id. */
export type PropertyRefRule = {
	/** Wire-shape link type. Convention:
	 *  `brainstorm/<SourceType>/<verb>` to mirror existing structured
	 *  link types like `brainstorm/Task/in-project`. */
	linkType: string;
	/** Source entity type — the rule scans only entities of this type. */
	entityType: string;
	/** Top-level property key on the source's property bag. */
	propertyPath: string;
	/** True (default) when the property is a `string[]` of entity ids
	 *  (`Folder.members`). False when it's a single scalar string id
	 *  (`Event.milestoneId`). Other shapes are tolerated and contribute
	 *  zero edges. */
	arrayValued?: boolean;
};

/** Initial rule set. */
export const DEFAULT_PROPERTY_REF_RULES: ReadonlyArray<PropertyRefRule> = [
	{
		linkType: "brainstorm/Folder/contains",
		entityType: "brainstorm/Folder/v1",
		propertyPath: "members",
		arrayValued: true,
	},
	{
		linkType: "brainstorm/Event/from-milestone",
		entityType: "brainstorm/Event/v1",
		propertyPath: "milestoneId",
		arrayValued: false,
	},
	{
		linkType: "brainstorm/Task/from-iteration",
		entityType: "brainstorm/Task/v1",
		propertyPath: "iterationId",
		arrayValued: false,
	},
	// `Note/about` covers all three seeded "narrates-a-source" note classes
	// (iteration-notes, doc-notes, hub note). User-authored notes leave
	// `aboutEntityId` unset → no edge.
	{
		linkType: "brainstorm/Note/about",
		entityType: "io.brainstorm.notes/Note/v1",
		propertyPath: "aboutEntityId",
		arrayValued: false,
	},
];

/** Stable, deterministic edge id for the (source, dest, kind) triple.
 *  Different rules pairing the same entities get distinct ids by
 *  folding the linkType into the id; the dedupe pass on the read side
 *  collapses any accidental collision regardless. */
function refEdgeId(linkType: string, source: string, dest: string): string {
	return `lnk_ref_${linkType}_${source}_${dest}`;
}

/** Wire-shape link type for a catalog-driven entity-ref property. The
 *  source entity type + property key make it unique and self-describing,
 *  mirroring the structured `brainstorm/<Type>/<verb>` convention. */
function catalogLinkType(entityType: string, propertyKey: string): string {
	return `brainstorm/ref/${entityType}/${propertyKey}`;
}

/** Pull the entity ids a stored property value carries. Handles the two
 *  storage shapes per : a bare scalar id (`count.max === 1`)
 *  or an array of `{ value, label? }` envelopes / bare strings
 *  (`count.max > 1`). Non-string / empty values contribute nothing. */
function readEntityRefIds(raw: unknown): string[] {
	const push = (out: string[], v: unknown): void => {
		if (typeof v === "string") {
			if (v !== "") out.push(v);
			return;
		}
		if (v && typeof v === "object") {
			const value = (v as { value?: unknown }).value;
			if (typeof value === "string" && value !== "") out.push(value);
		}
	};
	const out: string[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) push(out, item);
	} else {
		push(out, raw);
	}
	return out;
}

/**
 * Project `entities` to the set of property-ref edges implied by
 * `rules`. Self-loops (a folder listing itself as a member) are
 * dropped — they encode no information and would surface as a
 * degenerate edge in the Graph renderer.
 *
 * Complexity: O(N + E) where E is the total length of all member
 * arrays across matching entities.
 */
export function derivePropertyRefLinks(
	entities: ReadonlyArray<VaultEntity>,
	rules: ReadonlyArray<PropertyRefRule> = DEFAULT_PROPERTY_REF_RULES,
	propertyDefs: ReadonlyArray<PropertyDef> = [],
): VaultLink[] {
	const out: VaultLink[] = [];

	for (const rule of rules) {
		const arrayValued = rule.arrayValued !== false;
		for (const entity of entities) {
			if (entity.type !== rule.entityType) continue;
			const raw = entity.properties[rule.propertyPath];
			const ids = arrayValued
				? Array.isArray(raw)
					? raw
					: []
				: typeof raw === "string" && raw !== ""
					? [raw]
					: [];
			const seen = new Set<string>();
			for (const member of ids) {
				if (typeof member !== "string" || member === "") continue;
				if (member === entity.id) continue;
				if (seen.has(member)) continue;
				seen.add(member);
				out.push({
					id: refEdgeId(rule.linkType, entity.id, member),
					sourceEntityId: entity.id,
					destEntityId: member,
					linkType: rule.linkType,
					createdAt: entity.updatedAt,
					deletedAt: null,
				});
			}
		}
	}

	out.push(...deriveCatalogRefLinks(entities, rules, propertyDefs));
	return out;
}

/**
 * Catalog-driven generalization: any vault property whose `PropertyDef` is
 * an `entityRef` already stores entity ids, so it *is* a reference edge —
 * regardless of whether a hardcoded structural rule exists. This turns
 * "only four properties produce graph edges" into "every reference property
 * does", with the source property name carried as the edge `detail` so the
 * Graph can say *why* (e.g. "Assignee", "Links").
 *
 * Property keys already owned by a structural rule (Folder.members, …) are
 * skipped here so the curated verb wins and the edge isn't double-emitted.
 */
function deriveCatalogRefLinks(
	entities: ReadonlyArray<VaultEntity>,
	rules: ReadonlyArray<PropertyRefRule>,
	propertyDefs: ReadonlyArray<PropertyDef>,
): VaultLink[] {
	const refDefs = propertyDefs.filter((d) => d.valueType === ValueType.EntityRef);
	if (refDefs.length === 0) return [];

	// `Type|propertyKey` pairs the structural rules already cover.
	const structural = new Set(rules.map((r) => `${r.entityType}|${r.propertyPath}`));
	const defByKey = new Map<string, PropertyDef>();
	for (const def of refDefs) defByKey.set(def.key, def);

	const out: VaultLink[] = [];
	for (const entity of entities) {
		for (const key of Object.keys(entity.properties)) {
			const def = defByKey.get(key);
			if (!def) continue;
			if (structural.has(`${entity.type}|${key}`)) continue;
			const linkType = catalogLinkType(entity.type, key);
			const seen = new Set<string>();
			for (const dest of readEntityRefIds(entity.properties[key])) {
				if (dest === entity.id || seen.has(dest)) continue;
				seen.add(dest);
				out.push({
					id: refEdgeId(linkType, entity.id, dest),
					sourceEntityId: entity.id,
					destEntityId: dest,
					linkType,
					detail: def.name,
					createdAt: entity.updatedAt,
					deletedAt: null,
				});
			}
		}
	}
	return out;
}
