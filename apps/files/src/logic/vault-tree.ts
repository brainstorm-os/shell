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
): Entity[] {
	// Files is a universal browser, but the vault snapshot is the WHOLE shared
	// object space — including internal state/config rows no app can open. A row
	// surfaces only when it is a File/Folder (structural) or its type is openable
	// (`browsableTypes`, resolved from the opener registry). Member refs pointing
	// at an excluded entity are dropped by the dangling-ref sanitiser below (it
	// keys off the filtered `liveIds`), so nothing unbrowsable leaks as a ghost.
	const isBrowsable = (type: string): boolean =>
		type === FILE_TYPE || type === FOLDER_TYPE || (browsableTypes?.has(type) ?? false);
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
		for (const m of declared) {
			if (m === e.id || m === rootId || !liveIds.has(m) || members.includes(m)) continue;
			members.push(m);
			contained.add(m);
		}
		folderMembers.set(e.id, members);
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
		for (const m of rawRootMembers) {
			if (typeof m !== "string" || m === rootId || !liveIds.has(m) || rootDeclaredSet.has(m)) {
				continue;
			}
			rootDeclared.push(m);
			rootDeclaredSet.add(m);
			contained.add(m);
		}
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
