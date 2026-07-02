/**
 * Build the Files tree from a real vault snapshot — the long-term
 * keystone behind "manage the files in your vault" (the Database
 * 9.12.2-read-half move, applied to Files).
 *
 * Files is a UNIVERSAL object browser, not a files-only one (design 30
 * §"Not opinionated about content" — a Folder can contain any entity
 * type; design 41 §"the content pane shows all entity types"). The
 * `browsableTypes` set governs which non-File/Folder types surface: a
 * type is browsable when some app registered an opener for it (resolved
 * once via `intents.suggest` in the store and passed in here). Internal
 * state/config rows (`*View/v1`, `FileManagerState/v1`, connector
 * accounts, …) register no opener, so they never leak into the browser.
 * File and Folder rows are ALWAYS included regardless of the set.
 *
 * Pure + deterministic — it survives the swap from the `vaultEntities`
 * preview aggregator to the real entities service (9.3) and the Files
 * host service (9.10, binary file *content*); only the snapshot source
 * changes, never this projection.
 */

import { type Entity, FILE_TYPE, FOLDER_TYPE } from "../types/entity";

/** A folder member that is LIVE in the vault but hidden from the browser
 *  (child-scoped / app-internal type filtered out of `browsableTypes`).
 *  Hidden ≠ deleted: these ids must survive any full-replacement write of
 *  the folder's `members[]`, else a display filter silently destroys the
 *  user's membership record (the F-318 data-loss bug). `afterId` anchors
 *  the id to the nearest preceding RENDERED member (null = at the front)
 *  so `mergeRetainedMembers` can restore its position on persist. */
export type RetainedMember = { id: string; afterId: string | null };

/** Per-folder retained hidden members, keyed by folder id (root included). */
export type RetainedMembersMap = Map<string, RetainedMember[]>;

export type VaultEntityInput = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
};

function displayName(properties: Record<string, unknown>): string {
	const value = properties.name ?? properties.title;
	return typeof value === "string" && value.length > 0 ? value : "(untitled)";
}

/**
 * @param entities raw vault snapshot rows (soft-deleted dropped here)
 * @param rootId   the well-known root Folder id the renderer navigates to
 *                 (`ROOT_FOLDER_ID` — shell-bootstrapped via
 *                 `VaultSession.ensureRootFolder`)
 * @param now      synthetic-root timestamp seam (tests pin it)
 * @param browsableTypes the non-File/Folder entity types an app can open
 *                 (so Files may surface them). Undefined / empty ⇒ the
 *                 legacy files-only projection (File + Folder only); the
 *                 store fills it from `intents.suggest`. File and Folder
 *                 are always included irrespective of this set.
 * @param retainedOut when supplied, receives the per-folder member ids that
 *                 are live in the vault but excluded by the browsability
 *                 filter — the ids `persistFolderMembers` must merge back
 *                 into any full-replacement `members[]` write (hide-from-
 *                 display must never become delete-on-persist). Genuinely
 *                 dangling refs (deleted / unknown ids) are NOT retained —
 *                 pruning those on persist is intended.
 * @returns `[root, ...entities]`. When the snapshot contains the real
 *          `rootId` Folder (the shell bootstrap ran) its OWN row is the
 *          root — its declared members first, then any orphan no folder
 *          contains, so nothing is unreachable and folder
 *          appearance/pinning/open address the durable entity. When it is
 *          absent (older vault / bootstrap not yet run) a synthetic root
 *          is used so the app degrades gracefully. Empty `root.members`
 *          means an honest empty vault — never demo data.
 */
export function buildVaultFileTree(
	entities: readonly VaultEntityInput[],
	rootId: string,
	now: number = Date.now(),
	browsableTypes?: ReadonlySet<string>,
	retainedOut?: RetainedMembersMap,
): Entity[] {
	// Files is a universal browser, but the vault snapshot is the WHOLE shared
	// object space — including internal state/config rows no app can open. A row
	// surfaces only when it is a File/Folder (structural) or its type is openable
	// (`browsableTypes`, resolved from the opener registry). Member refs pointing
	// at an excluded entity are dropped from the RENDERED members below (the
	// sanitiser keys off the filtered `liveIds`), so nothing unbrowsable leaks as
	// a ghost — but refs to a live-yet-hidden entity are RETAINED via
	// `retainedOut` (hidden ≠ deleted; only refs to genuinely-gone entities are
	// pruned for good).
	const isBrowsable = (type: string): boolean =>
		type === FILE_TYPE || type === FOLDER_TYPE || (browsableTypes?.has(type) ?? false);
	const allLiveIds = new Set<string>();
	for (const e of entities) {
		if (e.deletedAt == null) allLiveIds.add(e.id);
	}
	const live = entities.filter((e) => e.deletedAt == null && isBrowsable(e.type));
	const liveIds = new Set(live.map((e) => e.id));
	const rootRow = live.find((e) => e.id === rootId && e.type === FOLDER_TYPE);
	const nonRoot = live.filter((e) => e.id !== rootId);

	// Sanitised member lists per real folder: keep only ids that point at a
	// live, non-self, non-root entity (drops dangling refs so no ghost rows
	// render; the root is the container, never another folder's member).
	const folderMembers = new Map<string, string[]>();
	const contained = new Set<string>();
	for (const e of nonRoot) {
		if (e.type !== FOLDER_TYPE) continue;
		const raw = e.properties.members;
		const declared = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : [];
		const members: string[] = [];
		const retained: RetainedMember[] = [];
		const retainedIds = new Set<string>();
		for (const m of declared) {
			if (m === e.id || m === rootId || members.includes(m) || retainedIds.has(m)) continue;
			if (liveIds.has(m)) {
				members.push(m);
				contained.add(m);
			} else if (allLiveIds.has(m)) {
				retained.push({ id: m, afterId: members.at(-1) ?? null });
				retainedIds.add(m);
			}
			// else: ref to a deleted/unknown entity — genuinely dangling, pruned.
		}
		folderMembers.set(e.id, members);
		if (retained.length > 0) retainedOut?.set(e.id, retained);
	}

	const mapped: Entity[] = nonRoot.map((e) => {
		const base = {
			id: e.id,
			type: e.type,
			createdAt: e.createdAt,
			updatedAt: e.updatedAt,
			deletedAt: null,
		};
		if (e.type === FOLDER_TYPE) {
			return {
				...base,
				properties: {
					...e.properties,
					name: displayName(e.properties),
					members: folderMembers.get(e.id) ?? [],
				},
			};
		}
		return { ...base, properties: { ...e.properties, name: displayName(e.properties) } };
	});

	// The root's declared members (if it carries any) come first, in
	// declared order; then every orphan no folder contains, folders before
	// files for a file-manager-natural order. This keeps the root
	// authoritative while never stranding an entity.
	const rootDeclared: string[] = [];
	const rootDeclaredSet = new Set<string>();
	const rawRootMembers = rootRow?.properties.members;
	if (Array.isArray(rawRootMembers)) {
		const rootRetained: RetainedMember[] = [];
		const rootRetainedIds = new Set<string>();
		for (const m of rawRootMembers) {
			if (typeof m !== "string" || m === rootId || rootDeclaredSet.has(m) || rootRetainedIds.has(m)) {
				continue;
			}
			if (liveIds.has(m)) {
				rootDeclared.push(m);
				rootDeclaredSet.add(m);
				contained.add(m);
			} else if (allLiveIds.has(m)) {
				rootRetained.push({ id: m, afterId: rootDeclared.at(-1) ?? null });
				rootRetainedIds.add(m);
			}
		}
		if (rootRetained.length > 0) retainedOut?.set(rootId, rootRetained);
	}
	const topFolders = mapped
		.filter((e) => e.type === FOLDER_TYPE && !contained.has(e.id))
		.map((e) => e.id);
	const topOthers = mapped
		.filter((e) => e.type !== FOLDER_TYPE && !contained.has(e.id))
		.map((e) => e.id);
	const rootMembers = [...rootDeclared, ...topFolders, ...topOthers];

	const root: Entity = rootRow
		? {
				id: rootId,
				type: FOLDER_TYPE,
				properties: {
					...rootRow.properties,
					name: displayName(rootRow.properties),
					members: rootMembers,
				},
				createdAt: rootRow.createdAt,
				updatedAt: rootRow.updatedAt,
				deletedAt: null,
			}
		: {
				id: rootId,
				type: FOLDER_TYPE,
				properties: { name: "Vault", members: rootMembers },
				createdAt: now,
				updatedAt: now,
				deletedAt: null,
			};
	return [root, ...mapped];
}

/**
 * The `members[]` to WRITE for a folder: its rendered (browsable) members
 * with the snapshot's retained hidden ids re-inserted at their anchored
 * positions. This is the inverse of the display filter above — a full-
 * replacement `entities.update({members})` must go through it so hiding a
 * child-scoped/app-internal entity never deletes its membership record.
 * An id whose visible anchor left the folder appends at the end (position
 * is best-effort; membership is not). Never duplicates an id already in
 * `rendered` (e.g. re-dropped cross-app before the next snapshot rebuild).
 */
export function mergeRetainedMembers(
	rendered: readonly string[],
	retained: readonly RetainedMember[] | undefined,
): string[] {
	if (!retained || retained.length === 0) return [...rendered];
	const renderedSet = new Set(rendered);
	const front: string[] = [];
	const afterVisible = new Map<string, string[]>();
	const tail: string[] = [];
	const seen = new Set<string>();
	for (const r of retained) {
		if (renderedSet.has(r.id) || seen.has(r.id)) continue;
		seen.add(r.id);
		if (r.afterId === null) {
			front.push(r.id);
		} else if (renderedSet.has(r.afterId)) {
			const bucket = afterVisible.get(r.afterId);
			if (bucket) bucket.push(r.id);
			else afterVisible.set(r.afterId, [r.id]);
		} else {
			tail.push(r.id);
		}
	}
	const out = [...front];
	for (const id of rendered) {
		out.push(id);
		const bucket = afterVisible.get(id);
		if (bucket) out.push(...bucket);
	}
	out.push(...tail);
	return out;
}
