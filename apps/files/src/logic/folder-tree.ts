/**
 * In-memory mirror of the entities + folder.members graph the Files app
 * reads.
 *
 * This is a long-term keystone (not a throwaway): every CRUD operation
 * the renderer performs goes through methods on this store, so when the
 * entities service lands at Stage 9.3 only the store's backing data
 * source swaps — `entities.create` / `entities.update` / `entities.delete`
 * replace the in-memory mutations, and the SDK pushes new snapshots into
 * `applySnapshot`. The renderer keeps subscribing through `onChange`.
 *
 * Operations covered:
 *   - getEntity / listEntities / listFolderMembers (read)
 *   - createFolder / createFile (write)
 *   - rename (collision detection up the caller)
 *   - move (cycle detection, batch transactional)
 *   - softDelete / restore / permanentDelete
 *
 * Cycle detection on move runs a DFS up to depth 32 (per
 * ) so a folder cannot end up
 * containing itself transitively.
 */

import { type Entity, type EntityType, FOLDER_TYPE, readMembers, readName } from "../types/entity";
import { type RetainedMember, mergeRetainedMembers } from "./vault-tree";

export type FolderTreeListener = () => void;

export type MoveResult =
	| { ok: true; movedIds: string[] }
	| { ok: false; reason: "cycle" | "missing-source" | "missing-dest" | "missing-entity" };

/** 9.8.7 — copy via membership-add (the multi-membership default per
 *  design 30). Result mirrors `MoveResult` minus the source-only
 *  failure modes. */
export type CopyResult =
	| { ok: true; copiedIds: string[] }
	| { ok: false; reason: "cycle" | "missing-dest" | "missing-entity" };

/** DND-4 — cross-app drop (membership-add). Like `copy`, but the dropped ids
 *  may be FOREIGN objects (a note/contact from another app) that aren't in the
 *  Files folder-tree mirror, so there is NO `missing-entity` rejection. The
 *  cycle guard still applies to ids that ARE local folders. */
export type AddMembersResult =
	| { ok: true; addedIds: string[] }
	| { ok: false; reason: "cycle" | "missing-dest" };

export type CreateFolderInput = {
	name: string;
	parentId: string;
	id?: string;
	now?: number;
};

export type CreateFileInput = {
	name: string;
	mime: string;
	size: number;
	hash?: string;
	/** Vault asset-store blob backing this file's bytes (9.8.5 second half).
	 *  Absent on metadata-only rows (pre-blob-store uploads). */
	assetId?: string;
	/** The shell's preview-safe SERVED mime for `assetId` — what
	 *  `brainstorm://asset/<assetId>` will say in Content-Type. Drives the
	 *  gallery image-preview gate (`image/*` ⇒ `<img>`-renderable). */
	assetMime?: string;
	parentId: string;
	id?: string;
	now?: number;
};

export const CYCLE_DEPTH_LIMIT = 32;

export class FolderTree {
	private readonly entities = new Map<string, Entity>();
	private readonly listeners = new Set<FolderTreeListener>();
	private retainedHiddenMembers: ReadonlyMap<string, readonly RetainedMember[]> = new Map();
	private idCounter = 0;
	private readonly idPrefix: string;

	constructor(idPrefix = "ent") {
		this.idPrefix = idPrefix;
	}

	subscribe(listener: FolderTreeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	applySnapshot(entities: Iterable<Entity>): void {
		this.entities.clear();
		for (const entity of entities) {
			this.entities.set(entity.id, cloneEntity(entity));
		}
		this.notify();
	}

	/** Per-folder membership records that are live in the vault but hidden
	 *  from the browser (child-scoped / app-internal types filtered out by
	 *  `buildVaultFileTree`). Replaced wholesale alongside every snapshot;
	 *  consulted only by `persistableMembers` so a full-replacement
	 *  `members[]` write never deletes what the display merely hides. */
	setRetainedHiddenMembers(retained: ReadonlyMap<string, readonly RetainedMember[]>): void {
		this.retainedHiddenMembers = retained;
	}

	/** The `members[]` to WRITE for `folderId`: the rendered members merged
	 *  with the snapshot's retained hidden ids at their original positions.
	 *  Genuinely-dangling refs (deleted entities) were pruned at build time
	 *  and stay pruned here. */
	persistableMembers(folderId: string): string[] {
		const folder = this.entities.get(folderId);
		const rendered = folder ? readMembers(folder) : [];
		return mergeRetainedMembers(rendered, this.retainedHiddenMembers.get(folderId));
	}

	get(id: string): Entity | undefined {
		const entity = this.entities.get(id);
		return entity ? cloneEntity(entity) : undefined;
	}

	getName(id: string): string | undefined {
		const entity = this.entities.get(id);
		return entity ? readName(entity) : undefined;
	}

	list(): Entity[] {
		return Array.from(this.entities.values(), cloneEntity);
	}

	listByType(type: EntityType): Entity[] {
		const out: Entity[] = [];
		for (const entity of this.entities.values()) {
			if (entity.type === type && entity.deletedAt === null) out.push(cloneEntity(entity));
		}
		return out;
	}

	listFolderMembers(folderId: string): Entity[] {
		const folder = this.entities.get(folderId);
		if (!folder || folder.type !== FOLDER_TYPE || folder.deletedAt !== null) return [];
		const ids = readMembers(folder);
		const out: Entity[] = [];
		for (const id of ids) {
			const member = this.entities.get(id);
			if (member && member.deletedAt === null) out.push(cloneEntity(member));
		}
		return out;
	}

	listChildFolders(folderId: string): Entity[] {
		return this.listFolderMembers(folderId).filter((e) => e.type === FOLDER_TYPE);
	}

	listDeleted(): Entity[] {
		const out: Entity[] = [];
		for (const entity of this.entities.values()) {
			if (entity.deletedAt !== null) out.push(cloneEntity(entity));
		}
		return out;
	}

	/** Find the first folder that lists `id` in its `members`. */
	findParentId(id: string): string | undefined {
		for (const entity of this.entities.values()) {
			if (entity.type !== FOLDER_TYPE) continue;
			if (readMembers(entity).includes(id)) return entity.id;
		}
		return undefined;
	}

	createFolder(input: CreateFolderInput): Entity | undefined {
		const parent = this.entities.get(input.parentId);
		if (!parent || parent.type !== FOLDER_TYPE) return undefined;
		const now = input.now ?? Date.now();
		const id = input.id ?? this.mintId("fld");
		const entity: Entity = {
			id,
			type: FOLDER_TYPE,
			properties: { name: input.name, members: [] },
			createdAt: now,
			updatedAt: now,
			deletedAt: null,
		};
		this.entities.set(id, entity);
		this.addMember(input.parentId, id, now);
		this.notify();
		return cloneEntity(entity);
	}

	createFile(input: CreateFileInput): Entity | undefined {
		const parent = this.entities.get(input.parentId);
		if (!parent || parent.type !== FOLDER_TYPE) return undefined;
		const now = input.now ?? Date.now();
		const id = input.id ?? this.mintId("fil");
		const entity: Entity = {
			id,
			type: "brainstorm/File/v1",
			properties: {
				name: input.name,
				mime: input.mime,
				size: input.size,
				...(input.hash !== undefined ? { hash: input.hash } : {}),
				...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
				...(input.assetMime !== undefined ? { assetMime: input.assetMime } : {}),
			},
			createdAt: now,
			updatedAt: now,
			deletedAt: null,
		};
		this.entities.set(id, entity);
		this.addMember(input.parentId, id, now);
		this.notify();
		return cloneEntity(entity);
	}

	rename(id: string, name: string, now = Date.now()): boolean {
		const entity = this.entities.get(id);
		if (!entity || entity.deletedAt !== null) return false;
		entity.properties = { ...entity.properties, name };
		entity.updatedAt = now;
		this.notify();
		return true;
	}

	/**
	 * Move `entityIds` from `sourceId` to `destId`. Atomic with respect to
	 * listeners: only one `notify()` fires when the whole batch succeeds.
	 * Cycle detection: a folder cannot become a descendant of itself.
	 */
	move(sourceId: string, destId: string, entityIds: string[], now = Date.now()): MoveResult {
		const source = this.entities.get(sourceId);
		if (!source || source.type !== FOLDER_TYPE) {
			return { ok: false, reason: "missing-source" };
		}
		const dest = this.entities.get(destId);
		if (!dest || dest.type !== FOLDER_TYPE) {
			return { ok: false, reason: "missing-dest" };
		}
		for (const id of entityIds) {
			if (!this.entities.has(id)) return { ok: false, reason: "missing-entity" };
			if (this.wouldCycle(id, destId)) return { ok: false, reason: "cycle" };
		}
		if (sourceId === destId) return { ok: true, movedIds: [] };

		const sourceMembers = readMembers(source).filter((m) => !entityIds.includes(m));
		source.properties = { ...source.properties, members: sourceMembers };
		source.updatedAt = now;

		const destMembers = [...readMembers(dest)];
		for (const id of entityIds) {
			if (!destMembers.includes(id)) destMembers.push(id);
		}
		dest.properties = { ...dest.properties, members: destMembers };
		dest.updatedAt = now;

		this.notify();
		return { ok: true, movedIds: entityIds };
	}

	/**
	 * 9.8.7 — Copy: add `entityIds` to `destId`'s members without removing
	 * them from any existing parent. Multi-membership is the documented
	 * default per design 30, so the entity becomes a member of both
	 * folders. Same cycle guard as `move` (a folder can't become a
	 * descendant of itself); ids already present in `dest.members` are
	 * silently skipped. Atomic w.r.t. listeners: one `notify()` per call.
	 */
	copy(destId: string, entityIds: string[], now = Date.now()): CopyResult {
		const dest = this.entities.get(destId);
		if (!dest || dest.type !== FOLDER_TYPE) {
			return { ok: false, reason: "missing-dest" };
		}
		const existingMembers = readMembers(dest);
		const existingSet = new Set(existingMembers);
		const toAdd: string[] = [];
		for (const id of entityIds) {
			if (!this.entities.has(id)) return { ok: false, reason: "missing-entity" };
			if (this.wouldCycle(id, destId)) return { ok: false, reason: "cycle" };
			if (existingSet.has(id)) continue;
			toAdd.push(id);
		}
		if (toAdd.length === 0) return { ok: true, copiedIds: [] };

		const destMembers = [...existingMembers, ...toAdd];
		dest.properties = { ...dest.properties, members: destMembers };
		dest.updatedAt = now;

		this.notify();
		return { ok: true, copiedIds: toAdd };
	}

	/**
	 * DND-4 — add `entityIds` to `destId`'s membership (cross-app drop =
	 * `DropSemantic.AddMembership`, non-destructive). Unlike `copy`, the ids may
	 * be objects this Files tree has never seen (dragged in from another app), so
	 * an unknown id is added verbatim rather than rejected — the entities service
	 * resolves it on its own. The folder-cycle guard still applies to any id that
	 * IS a local folder. Ids already in `dest.members` are silently skipped.
	 * Atomic w.r.t. listeners: one `notify()` per call.
	 */
	addMembers(destId: string, entityIds: string[], now = Date.now()): AddMembersResult {
		const dest = this.entities.get(destId);
		if (!dest || dest.type !== FOLDER_TYPE) {
			return { ok: false, reason: "missing-dest" };
		}
		const existingSet = new Set(readMembers(dest));
		const toAdd: string[] = [];
		for (const id of entityIds) {
			if (this.wouldCycle(id, destId)) return { ok: false, reason: "cycle" };
			if (existingSet.has(id) || id === destId) continue;
			if (toAdd.includes(id)) continue;
			toAdd.push(id);
		}
		if (toAdd.length === 0) return { ok: true, addedIds: [] };

		dest.properties = { ...dest.properties, members: [...readMembers(dest), ...toAdd] };
		dest.updatedAt = now;

		this.notify();
		return { ok: true, addedIds: toAdd };
	}

	softDelete(id: string, now = Date.now()): boolean {
		const entity = this.entities.get(id);
		if (!entity || entity.deletedAt !== null) return false;
		entity.deletedAt = now;
		entity.updatedAt = now;
		const parentId = this.findParentId(id);
		if (parentId) this.removeMember(parentId, id, now);
		this.notify();
		return true;
	}

	restore(id: string, parentId: string, now = Date.now()): boolean {
		const entity = this.entities.get(id);
		if (!entity || entity.deletedAt === null) return false;
		const parent = this.entities.get(parentId);
		if (!parent || parent.type !== FOLDER_TYPE) return false;
		entity.deletedAt = null;
		entity.updatedAt = now;
		this.addMember(parentId, id, now);
		this.notify();
		return true;
	}

	permanentDelete(id: string): boolean {
		const entity = this.entities.get(id);
		if (!entity) return false;
		this.entities.delete(id);
		const parentId = this.findParentId(id);
		if (parentId) this.removeMember(parentId, id);
		this.notify();
		return true;
	}

	/** Names collision detector. Active folder = parent of new/renamed entity. */
	hasNameCollision(parentId: string, name: string, excludeId?: string): boolean {
		const members = this.listFolderMembers(parentId);
		const folded = foldName(name);
		return members.some((m) => m.id !== excludeId && foldName(readName(m)) === folded);
	}

	wouldCycle(movingId: string, destId: string): boolean {
		if (movingId === destId) return true;
		const moving = this.entities.get(movingId);
		if (!moving || moving.type !== FOLDER_TYPE) return false;
		// dest descends from moving?
		const stack: Array<{ id: string; depth: number }> = [{ id: movingId, depth: 0 }];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const { id, depth } = stack.pop() as { id: string; depth: number };
			if (seen.has(id)) continue;
			seen.add(id);
			if (depth > CYCLE_DEPTH_LIMIT) return true;
			const entity = this.entities.get(id);
			if (!entity || entity.type !== FOLDER_TYPE) continue;
			for (const member of readMembers(entity)) {
				if (member === destId) return true;
				stack.push({ id: member, depth: depth + 1 });
			}
		}
		return false;
	}

	private addMember(parentId: string, id: string, now: number): void {
		const parent = this.entities.get(parentId);
		if (!parent || parent.type !== FOLDER_TYPE) return;
		const members = readMembers(parent);
		if (members.includes(id)) return;
		parent.properties = { ...parent.properties, members: [...members, id] };
		parent.updatedAt = now;
	}

	private removeMember(parentId: string, id: string, now = Date.now()): void {
		const parent = this.entities.get(parentId);
		if (!parent || parent.type !== FOLDER_TYPE) return;
		const members = readMembers(parent);
		const next = members.filter((m) => m !== id);
		if (next.length === members.length) return;
		parent.properties = { ...parent.properties, members: next };
		parent.updatedAt = now;
	}

	private mintId(kind: string): string {
		this.idCounter += 1;
		return `${this.idPrefix}_${kind}_${this.idCounter.toString(36)}`;
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

export function foldName(name: string): string {
	return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function cloneEntity(entity: Entity): Entity {
	return {
		...entity,
		properties: { ...entity.properties },
	};
}
