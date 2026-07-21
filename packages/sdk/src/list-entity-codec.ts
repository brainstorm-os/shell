/**
 * List ⇄ `brainstorm/List/v1` entity codec (9.3.5.7a).
 *
 * The single-object-space remodel promotes Lists/Collections from in-memory
 * Database-app state to first-class vault entities. This is the pure,
 * dependency-free keystone every read/write goes through: it maps a frozen
 * `List` (the app-facing shape, `@brainstorm-os/sdk-types`) to the `properties`
 * bag stored on a `brainstorm/List/v1` `Entity`, and back.
 *
 * Field mapping: `List.id` ⇄ `Entity.id`; `List.createdAt`/`updatedAt` ⇄ the
 * `Entity`'s own timestamps (never duplicated into `properties`); everything
 * else (`name` / `icon` / `description` / `source` / `members` / `views` /
 * `defaultViewId`) lives in `properties`.
 *
 * `entityToList` is defensive — a partially-written, foreign-version, or
 * hand-edited entity coerces to safe defaults rather than throwing, so one bad
 * row never takes down the Database app. A wrong-type entity returns `null` so
 * callers can filter a mixed query result. Source-query resolution + override
 * application stay on the app/service side (`effectiveMembers`); this is only
 * the serialization half, mirroring how `effectiveMembers` is the pure half of
 * the membership contract.
 */

import {
	COLLECTION_TYPE_URL,
	type Entity,
	type Icon,
	type List,
	type ListSource,
	type MemberExclude,
	type MemberInclude,
	type MemberOverrides,
} from "@brainstorm-os/sdk-types";

/** Re-exported for call sites that create/query the entity by type. */
export const LIST_ENTITY_TYPE = COLLECTION_TYPE_URL;

/** The `properties` bag persisted on a `brainstorm/List/v1` entity — the
 *  `List` minus the fields the `Entity` itself owns (`id`, `createdAt`,
 *  `updatedAt`). */
export type ListEntityProperties = {
	name: string;
	icon: Icon | null;
	description: string;
	source: ListSource | null;
	members: MemberOverrides;
	views: string[];
	defaultViewId: string | null;
	defaultTemplate: string | null;
};

/** Serialize a `List` into the entity `properties` bag for
 *  `entities.create(LIST_ENTITY_TYPE, props, list.id)` / `entities.update`.
 *  Timestamps + id are carried by the `Entity`, not duplicated here. */
export function listToEntityProperties(list: List): ListEntityProperties {
	return {
		name: list.name,
		icon: list.icon,
		description: list.description,
		source: list.source,
		members: list.members,
		views: list.views,
		defaultViewId: list.defaultViewId,
		defaultTemplate: list.defaultTemplate,
	};
}

/** Reconstruct a `List` from a `brainstorm/List/v1` entity. Returns `null`
 *  for a non-List entity (so a mixed query can `.map(entityToList).filter`).
 *  Every property field coerces to a safe default when missing / malformed. */
export function entityToList(entity: Entity): List | null {
	if (entity.type !== LIST_ENTITY_TYPE) return null;
	const p = entity.properties as Record<string, unknown>;
	return {
		id: entity.id,
		name: asString(p.name, ""),
		icon: asIcon(p.icon),
		description: asString(p.description, ""),
		source: asObjectOrNull<ListSource>(p.source),
		members: asMemberOverrides(p.members),
		views: asStringArray(p.views),
		defaultViewId: asStringOrNull(p.defaultViewId),
		defaultTemplate: asStringOrNull(p.defaultTemplate),
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt,
	};
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asObjectOrNull<T>(value: unknown): T | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
}

function asIcon(value: unknown): Icon | null {
	// `Icon` is a tagged object; the resolver/renderer validates the variant.
	// Here we only gate that it's a non-array object, else null.
	return asObjectOrNull<Icon>(value);
}

function asMemberOverrides(value: unknown): MemberOverrides {
	const v = asObjectOrNull<{ include?: unknown; exclude?: unknown }>(value);
	return {
		include: asArray<MemberInclude>(v?.include),
		exclude: asArray<MemberExclude>(v?.exclude),
	};
}

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}
