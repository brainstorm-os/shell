/**
 * Group-by for the folder-contents list (9.8.11). Pure: takes the
 * already-sorted visible rows and buckets them into labelled sections;
 * within a section the incoming (sorted) order is preserved, so group-by
 * composes with the sort menu instead of fighting it.
 *
 * Wire values are a TS enum per the conventions (`case "type":` is
 * rejected); `None` means "no grouping" and callers skip sectioning
 * entirely rather than rendering a single unlabelled group.
 */

import { type Entity, FILE_TYPE, FOLDER_TYPE, readExtension, readName } from "../types/entity";

export enum GroupKey {
	None = "none",
	Type = "type",
	FirstLetter = "letter",
	Month = "month",
}

export const DEFAULT_GROUP_KEY: GroupKey = GroupKey.None;

export const GROUP_KEYS: readonly GroupKey[] = [
	GroupKey.None,
	GroupKey.Type,
	GroupKey.FirstLetter,
	GroupKey.Month,
];

export function isGroupKey(value: unknown): value is GroupKey {
	return typeof value === "string" && (GROUP_KEYS as readonly string[]).includes(value);
}

export type EntityGroup = {
	/** Stable bucket id (label may be localised later). */
	key: string;
	label: string;
	entities: Entity[];
};

/** Localisable labels the caller supplies (the pure module can't reach
 *  `t()` — mirrors `TaskValueContext`'s pattern). */
export type GroupLabels = {
	folders: string;
	noExtension: string;
	/** Bucket for names that don't start with a letter (Finder's "#"). */
	otherLetter: string;
};

/** The file-kind bucket for an entity: folders share one bucket, files
 *  bucket by upper-cased extension, anything else by its type's friendly
 *  name (`brainstorm/Person/v1` → `Person`). */
function typeBucket(entity: Entity, labels: GroupLabels): { key: string; label: string } {
	if (entity.type === FOLDER_TYPE) return { key: "folder", label: labels.folders };
	if (entity.type === FILE_TYPE) {
		const ext = readExtension(entity);
		if (ext.length > 0) {
			const upper = ext.toUpperCase();
			return { key: `ext:${upper}`, label: upper };
		}
		return { key: "ext:", label: labels.noExtension };
	}
	const segments = entity.type.split("/");
	const typeName =
		segments.length >= 2 ? (segments[segments.length - 2] ?? entity.type) : entity.type;
	return { key: `type:${typeName}`, label: typeName };
}

function letterBucket(entity: Entity, labels: GroupLabels): { key: string; label: string } {
	const first = readName(entity).trimStart().charAt(0);
	const upper = first.toLocaleUpperCase();
	const isLetter = upper.length > 0 && upper.toLocaleLowerCase() !== upper;
	if (isLetter) return { key: `letter:${upper}`, label: upper };
	return { key: "letter:#", label: labels.otherLetter };
}

function monthBucket(entity: Entity): { key: string; label: string } {
	const d = new Date(entity.updatedAt);
	const key = `month:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
	const label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
	return { key, label };
}

/** Bucket the (sorted) rows into labelled sections. Section order:
 *  Type → Folders first, then label A→Z; FirstLetter → A→Z with the
 *  non-letter bucket last; Month → newest month first. `None` → a single
 *  section containing everything (callers normally skip grouping instead). */
export function groupEntities(
	entities: readonly Entity[],
	key: GroupKey,
	labels: GroupLabels,
): EntityGroup[] {
	if (key === GroupKey.None) {
		return [{ key: "all", label: "", entities: entities.slice() }];
	}
	const buckets = new Map<string, EntityGroup>();
	for (const entity of entities) {
		const bucket =
			key === GroupKey.Type
				? typeBucket(entity, labels)
				: key === GroupKey.FirstLetter
					? letterBucket(entity, labels)
					: monthBucket(entity);
		const existing = buckets.get(bucket.key);
		if (existing) existing.entities.push(entity);
		else buckets.set(bucket.key, { key: bucket.key, label: bucket.label, entities: [entity] });
	}
	const groups = [...buckets.values()];
	if (key === GroupKey.Type) {
		groups.sort((a, b) => {
			if (a.key === "folder") return -1;
			if (b.key === "folder") return 1;
			return a.label.localeCompare(b.label);
		});
	} else if (key === GroupKey.FirstLetter) {
		groups.sort((a, b) => {
			if (a.key === "letter:#") return 1;
			if (b.key === "letter:#") return -1;
			return a.label.localeCompare(b.label);
		});
	} else {
		// Month keys are zero-padded `YYYY-MM`, so a string sort IS the
		// chronological sort; newest first.
		groups.sort((a, b) => b.key.localeCompare(a.key));
	}
	return groups;
}
