/**
 * Type-level surface for the entities the Files app reads and writes.
 *
 * Mirrors the shape the entities service (Stage 9.3) will return through
 * `entities.subscribe` / `entities.get` / `entities.query`. Keeping this
 * surface app-local until the SDK exports it lets 9.8.3 – 9.8.10 ship
 * against the in-memory mirror; the Stage 9.3 swap replaces only the data
 * source.
 *
 * Per the canonical shapes are:
 *
 *   - `brainstorm/Folder/v1`: { name, members[], view?, sortBy?, createdAt, updatedAt }
 *   - `brainstorm/File/v1`:   { name, mime, size, hash, attachment, ... }
 *
 * The Files app reads everything (capability `entities.read:*`) so the
 * `Entity` shape carries a freeform `properties` bag the renderer pulls
 * `name` / `mime` / etc. out of, and a `type` discriminator the row
 * renderer maps to a glyph and primary-opener intent.
 */

export const FOLDER_TYPE = "brainstorm/Folder/v1" as const;
export const FILE_TYPE = "brainstorm/File/v1" as const;
export const NOTE_TYPE = "io.brainstorm.notes/Note/v1" as const;
export const STATE_TYPE = "brainstorm/FileManagerState/v1" as const;

/**
 * Well-known id of the vault root `Folder/v1` the shell bootstraps on
 * vault open (`VaultSession.ensureRootFolder` → `ROOT_FOLDER_ENTITY_ID`).
 * The renderer navigates here; the real row (when present in the
 * snapshot) replaces the former synthetic root so folder appearance /
 * pinning / cross-app open address a durable entity. MUST stay
 * byte-identical to the shell constant — it is a wire id.
 */
export const ROOT_FOLDER_ID = "brainstorm/root-folder/v1" as const;

export type EntityType = string;

export type EntityProperties = Record<string, unknown>;

export type Entity = {
	id: string;
	type: EntityType;
	properties: EntityProperties;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
};

export type FolderProperties = {
	name: string;
	members: string[];
	icon?: string;
	description?: string;
	view?: "list" | "grid";
	sortBy?: "manual" | "name" | "created" | "modified";
	createdAt?: number;
	updatedAt?: number;
};

export type FileProperties = {
	name: string;
	mime: string;
	size: number;
	hash?: string;
	attachment?: string;
	description?: string;
	tags?: string[];
};

/** The name segment of a `<namespace>/<Name>/<version>` type id —
 *  `brainstorm/ListView/v1` → "ListView", `io.brainstorm.notes/Note/v1` →
 *  "Note". Drops a trailing `vN` and takes the last remaining segment;
 *  falls back to the raw id. Shared by the "Kind" label (`humanizeType`)
 *  and the app-internal-type filter (`isAppInternalType`). */
export function entityTypeName(type: string): string {
	const segments = type.split("/").filter((s) => s.length > 0);
	while (segments.length > 1 && /^v\d+$/.test(segments[segments.length - 1] ?? "")) {
		segments.pop();
	}
	return segments[segments.length - 1] ?? type;
}

export function readName(entity: Entity): string {
	const name = entity.properties.name;
	return typeof name === "string" && name.length > 0 ? name : "(untitled)";
}

/** Byte size of a file, or 0 for folders / anything without a numeric size —
 *  so a size sort places sizeless rows together at one end. */
export function readSize(entity: Entity): number {
	const size = entity.properties.size;
	return typeof size === "number" ? size : 0;
}

export function readMembers(entity: Entity): string[] {
	const members = entity.properties.members;
	if (!Array.isArray(members)) return [];
	return members.filter((m): m is string => typeof m === "string");
}
